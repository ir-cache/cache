import * as core from "@actions/core";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";

interface DownloadSegment {
  offset: number;
  count: number;
  buffer: Buffer;
}

class DownloadProgress {
  private contentLength: number;
  private bytesDownloaded: number;
  private startTime: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(contentLength: number) {
    this.contentLength = contentLength;
    this.bytesDownloaded = 0;
    this.startTime = Date.now();
  }

  update(bytes: number): void {
    this.bytesDownloaded = bytes;
  }

  startDisplayTimer(): void {
    this.timer = setInterval(() => this.display(), 5000);
  }

  stopDisplayTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.display();
  }

  private display(): void {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const speed = (this.bytesDownloaded / (1024 * 1024) / elapsed).toFixed(1);
    const pct = ((100 * this.bytesDownloaded) / this.contentLength).toFixed(1);
    core.info(
      `Downloaded ${Math.round(this.bytesDownloaded / (1024 * 1024))}MB / ${Math.round(this.contentLength / (1024 * 1024))}MB (${pct}%) at ${speed} MB/s`
    );
  }
}

function downloadSegment(
  url: string,
  offset: number,
  count: number,
  timeoutMs: number
): Promise<DownloadSegment> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: {
        Range: `bytes=${offset}-${offset + count - 1}`,
      },
      timeout: timeoutMs,
    };

    const req = client.request(options, (res) => {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        reject(
          new Error(
            `Segment download failed: status ${res.statusCode} for range ${offset}-${offset + count - 1}`
          )
        );
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ offset, count: buffer.length, buffer });
      });
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Segment timeout after ${timeoutMs}ms for range ${offset}-${offset + count - 1}`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function downloadSegmentWithRetry(
  url: string,
  offset: number,
  count: number,
  maxRetries: number = 5,
  timeoutMs: number = 120000
): Promise<DownloadSegment> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await downloadSegment(url, offset, count, timeoutMs);
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        core.warning(
          `Segment at offset ${Math.round(offset / (1024 * 1024))}MB failed (attempt ${attempt}/${maxRetries}): ${lastError.message}. Retrying in ${delay}ms...`
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        core.error(
          `Segment at offset ${Math.round(offset / (1024 * 1024))}MB failed after ${maxRetries} attempts: ${lastError.message}`
        );
      }
    }
  }
  throw lastError;
}

function probeRangeSupport(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: { Range: "bytes=0-0" },
      timeout: 10000,
    };

    const req = client.request(options, (res) => {
      res.resume();
      if (res.statusCode === 206) {
        const contentRange = res.headers["content-range"];
        const match = contentRange?.match(/bytes \d+-\d+\/(\d+)/);
        if (match) {
          resolve(parseInt(match[1]));
        } else {
          reject(new Error("Content-Range header missing or malformed"));
        }
      } else if (res.statusCode === 200) {
        const cl = res.headers["content-length"];
        if (cl) {
          resolve(-parseInt(cl)); // Negative = Range not supported, use single stream
        } else {
          reject(new Error("No Content-Length in response"));
        }
      } else {
        reject(new Error(`Probe failed with status ${res.statusCode}`));
      }
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Probe timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function downloadCacheParallel(
  archiveLocation: string,
  archivePath: string,
  concurrency: number,
  partSize: number
): Promise<void> {
  // Probe for Range request support and get total size
  let totalSize: number;
  try {
    totalSize = await probeRangeSupport(archiveLocation);
  } catch (err) {
    core.warning(
      `Range probe failed: ${(err as Error).message}. Falling back to single stream.`
    );
    return downloadSingleStream(archiveLocation, archivePath);
  }

  if (totalSize < 0) {
    core.info("Server does not support Range requests. Using single stream.");
    return downloadSingleStream(archiveLocation, archivePath);
  }

  core.info(
    `Parallel download: ${Math.round(totalSize / (1024 * 1024))}MB, ${concurrency} concurrent segments of ${Math.round(partSize / (1024 * 1024))}MB`
  );

  const fd = await fs.promises.open(archivePath, "w");
  const progress = new DownloadProgress(totalSize);
  progress.startDisplayTimer();

  try {
    // Build segment list
    const segments: { offset: number; count: number }[] = [];
    for (let offset = 0; offset < totalSize; offset += partSize) {
      const count = Math.min(partSize, totalSize - offset);
      segments.push({ offset, count });
    }

    // Process with bounded concurrency
    let bytesDownloaded = 0;
    const activeDownloads: Map<number, Promise<DownloadSegment>> = new Map();

    const writeSegment = async (): Promise<void> => {
      const segment = await Promise.race(activeDownloads.values());
      await fd.write(segment.buffer, 0, segment.count, segment.offset);
      bytesDownloaded += segment.count;
      progress.update(bytesDownloaded);
      activeDownloads.delete(segment.offset);
    };

    for (const seg of segments) {
      const promise = downloadSegmentWithRetry(
        archiveLocation,
        seg.offset,
        seg.count
      );
      activeDownloads.set(seg.offset, promise);

      if (activeDownloads.size >= concurrency) {
        await writeSegment();
      }
    }

    // Drain remaining
    while (activeDownloads.size > 0) {
      await writeSegment();
    }

    if (bytesDownloaded !== totalSize) {
      throw new Error(
        `Download validation failed: expected ${totalSize} bytes, got ${bytesDownloaded}`
      );
    }
  } finally {
    progress.stopDisplayTimer();
    await fd.close();
  }
}

function downloadSingleStream(
  url: string,
  archivePath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      timeout: 300000,
    };

    const fileStream = fs.createWriteStream(archivePath);
    const req = client.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed with status ${res.statusCode}`));
        return;
      }
      let downloaded = 0;
      res.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
      });
      res.pipe(fileStream);
      fileStream.on("finish", () => {
        core.info(`Downloaded ${Math.round(downloaded / (1024 * 1024))}MB (single stream)`);
        resolve();
      });
      fileStream.on("error", reject);
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Download timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}
