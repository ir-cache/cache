import * as core from "@actions/core";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";

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

  addBytes(n: number): void {
    this.bytesDownloaded += n;
  }

  get downloaded(): number {
    return this.bytesDownloaded;
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

// Stream a range directly to the file descriptor at the correct offset.
// Memory usage is bounded by Node's internal stream buffer (~64KB) per connection.
function downloadSegmentToFile(
  url: string,
  fd: fs.promises.FileHandle,
  offset: number,
  count: number,
  timeoutMs: number,
  progress: DownloadProgress
): Promise<number> {
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

    let bytesWritten = 0;
    let writeOffset = offset;
    let writing = false;
    let ended = false;
    let errored = false;

    const req = client.request(options, (res) => {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        reject(
          new Error(
            `Segment download failed: status ${res.statusCode} for range ${offset}-${offset + count - 1}`
          )
        );
        return;
      }

      res.on("data", (chunk: Buffer) => {
        if (errored) return;
        // Pause the stream while we write to prevent unbounded buffering
        res.pause();
        writing = true;
        fd.write(chunk, 0, chunk.length, writeOffset).then(({ bytesWritten: n }) => {
          writeOffset += n;
          bytesWritten += n;
          progress.addBytes(n);
          writing = false;
          if (ended) {
            resolve(bytesWritten);
          } else {
            res.resume();
          }
        }).catch((err) => {
          errored = true;
          res.destroy();
          reject(err);
        });
      });

      res.on("end", () => {
        ended = true;
        if (!writing) {
          resolve(bytesWritten);
        }
      });

      res.on("error", (err) => {
        errored = true;
        reject(err);
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(
        new Error(
          `Segment timeout after ${timeoutMs}ms for range ${offset}-${offset + count - 1}`
        )
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function downloadSegmentWithRetry(
  url: string,
  fd: fs.promises.FileHandle,
  offset: number,
  count: number,
  progress: DownloadProgress,
  maxRetries: number = 5,
  timeoutMs: number = 120000
): Promise<number> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await downloadSegmentToFile(url, fd, offset, count, timeoutMs, progress);
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

  // Pre-allocate file to full size
  const fd = await fs.promises.open(archivePath, "w");
  await fd.truncate(totalSize);

  const progress = new DownloadProgress(totalSize);
  progress.startDisplayTimer();

  try {
    // Build segment list
    const segments: { offset: number; count: number }[] = [];
    for (let offset = 0; offset < totalSize; offset += partSize) {
      const count = Math.min(partSize, totalSize - offset);
      segments.push({ offset, count });
    }

    // Process segments with bounded concurrency — streaming to file, not memory
    const active: Set<Promise<number>> = new Set();

    for (const seg of segments) {
      const promise = downloadSegmentWithRetry(
        archiveLocation,
        fd,
        seg.offset,
        seg.count,
        progress
      ).then((n) => {
        active.delete(promise);
        return n;
      });
      active.add(promise);

      if (active.size >= concurrency) {
        await Promise.race(active);
      }
    }

    // Drain remaining
    while (active.size > 0) {
      await Promise.race(active);
    }

    if (progress.downloaded !== totalSize) {
      throw new Error(
        `Download validation failed: expected ${totalSize} bytes, got ${progress.downloaded}`
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
        core.info(
          `Downloaded ${Math.round(downloaded / (1024 * 1024))}MB (single stream)`
        );
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
