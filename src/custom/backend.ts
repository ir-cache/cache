import * as crypto from "crypto";
import * as fs from "fs";
import * as core from "@actions/core";
import { HttpClient } from "@actions/http-client";
import * as http from "http";

export interface ArtifactCacheEntry {
  cacheKey?: string;
  archiveLocation?: string;
}

// v2 Twirp API response types
interface CreateCacheEntryResponse {
  ok: boolean;
  signedUploadUrl: string;
  multipart?: {
    uploadId: string;
    partSize: number;
    parts: Array<{ partNumber: number; url: string }>;
  };
}

interface FinalizeCacheEntryResponse {
  ok: boolean;
  entryId: string;
}

interface GetCacheEntryDownloadURLResponse {
  ok: boolean;
  signedDownloadUrl: string;
  matchedKey: string;
  contentLength?: number;
}

interface CompletedPart {
  partNumber: number;
  etag: string;
}

const versionSalt = "1.0";
const twirpPrefix = "/twirp/github.actions.results.api.v1.CacheService/";
const httpClient = new HttpClient("ir-cache-action");

const UPLOAD_CONCURRENCY = Number(process.env.IR_UPLOAD_CONCURRENCY || "4");
const DOWNLOAD_CONCURRENCY = Number(process.env.IR_DOWNLOAD_CONCURRENCY || "8");
const DOWNLOAD_PART_SIZE = Number(process.env.IR_DOWNLOAD_PART_SIZE || "64") * 1024 * 1024;

function getBaseUrl(): string {
  let url = process.env.IR_CACHE_URL;
  if (!url) {
    try {
      url = fs.readFileSync("/etc/ir/cache-url", "utf-8").trim();
    } catch {
      // file doesn't exist
    }
  }
  if (!url) {
    throw new Error("IR_CACHE_URL not set and /etc/ir/cache-url not found");
  }
  return url.replace(/\/+$/, "");
}

export function getAuthHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo) {
    return { "X-IR-Repository": repo };
  }
  throw new Error("No authentication available for IR cache");
}

export function getCacheVersion(
  paths: string[],
  compressionMethod?: string,
  enableCrossOsArchive = false
): string {
  const components = paths.slice();
  if (compressionMethod) {
    components.push(compressionMethod);
  }
  if (process.platform === "win32" && !enableCrossOsArchive) {
    components.push("windows-only");
  }
  components.push(versionSalt);
  return crypto
    .createHash("sha256")
    .update(components.join("|"))
    .digest("hex");
}

export async function getCacheEntry(
  keys: string[],
  paths: string[],
  options: { compressionMethod?: string; enableCrossOsArchive?: boolean }
): Promise<ArtifactCacheEntry | null> {
  const baseUrl = getBaseUrl();
  const version = getCacheVersion(
    paths,
    options.compressionMethod,
    options.enableCrossOsArchive
  );

  const url = `${baseUrl}${twirpPrefix}GetCacheEntryDownloadURL`;
  const headers = {
    ...getAuthHeaders(),
    "Content-Type": "application/json",
  };

  const primaryKey = keys[0];
  const restoreKeys = keys.slice(1);

  const body = JSON.stringify({
    key: primaryKey,
    restoreKeys,
    version,
  });

  const response = await httpClient.post(url, body, headers);
  const statusCode = response.message.statusCode || 0;
  const responseBody = await response.readBody();

  if (statusCode !== 200) {
    core.debug(`GetCacheEntryDownloadURL returned ${statusCode}: ${responseBody}`);
    return null;
  }

  const result = JSON.parse(responseBody) as GetCacheEntryDownloadURLResponse;

  if (!result.ok || !result.signedDownloadUrl) {
    return null;
  }

  return {
    cacheKey: result.matchedKey || primaryKey,
    archiveLocation: result.signedDownloadUrl,
  };
}

export async function saveCache(
  key: string,
  paths: string[],
  archivePath: string,
  options: {
    compressionMethod?: string;
    enableCrossOsArchive?: boolean;
    chunkSize?: number;
  }
): Promise<void> {
  const baseUrl = getBaseUrl();
  const version = getCacheVersion(
    paths,
    options.compressionMethod,
    options.enableCrossOsArchive
  );
  const fileSize = fs.statSync(archivePath).size;

  core.info(
    `Cache Size: ~${Math.round(fileSize / (1024 * 1024))} MB (${fileSize} B)`
  );

  // Step 1: CreateCacheEntry — get presigned upload URL(s)
  const createUrl = `${baseUrl}${twirpPrefix}CreateCacheEntry`;
  const createHeaders = {
    ...getAuthHeaders(),
    "Content-Type": "application/json",
  };
  const createBody = JSON.stringify({
    key,
    version,
    sizeBytes: String(fileSize),
  });

  const createResponse = await httpClient.post(createUrl, createBody, createHeaders);
  const createStatus = createResponse.message.statusCode || 0;
  const createResponseBody = await createResponse.readBody();

  if (createStatus !== 200) {
    throw new Error(`CreateCacheEntry failed with status ${createStatus}: ${createResponseBody}`);
  }

  const createResult = JSON.parse(createResponseBody) as CreateCacheEntryResponse;

  if (!createResult.ok) {
    core.info("Cache entry already exists (immutable) — skipping save");
    return;
  }

  // Step 2: Upload to S3 via presigned URL(s)
  if (createResult.multipart) {
    const { uploadId, parts, partSize } = createResult.multipart;
    core.info(`Multipart upload: ${parts.length} parts, ${Math.round(partSize / (1024 * 1024))}MB each, concurrency ${UPLOAD_CONCURRENCY}`);

    const completedParts: CompletedPart[] = new Array(parts.length);

    // Upload parts in parallel with concurrency limit using native https
    await parallelMap(parts, UPLOAD_CONCURRENCY, async (part) => {
      const start = (part.partNumber - 1) * partSize;
      const end = Math.min(start + partSize, fileSize);
      const partLength = end - start;

      const etag = await uploadPart(part.url, archivePath, start, partLength);
      completedParts[part.partNumber - 1] = { partNumber: part.partNumber, etag };
      core.info(`Uploaded part ${part.partNumber}/${parts.length}`);
    });

    // Step 3: Finalize with completed parts
    const finalizeUrl = `${baseUrl}${twirpPrefix}FinalizeCacheEntryUpload`;
    const finalizeBody = JSON.stringify({
      key,
      version,
      sizeBytes: String(fileSize),
      uploadId,
      parts: completedParts,
    });

    const finalizeResponse = await httpClient.post(finalizeUrl, finalizeBody, createHeaders);
    const finalizeStatus = finalizeResponse.message.statusCode || 0;

    if (finalizeStatus !== 200) {
      const finalizeResponseBody = await finalizeResponse.readBody();
      throw new Error(`FinalizeCacheEntryUpload failed: ${finalizeStatus} ${finalizeResponseBody}`);
    }
  } else if (createResult.signedUploadUrl) {
    // Single PUT upload
    const stream = fs.createReadStream(archivePath);
    const putResponse = await httpClient.sendStream("PUT", createResult.signedUploadUrl, stream, {
      "Content-Length": String(fileSize),
      "Content-Type": "application/octet-stream",
    });
    const putStatus = putResponse.message.statusCode || 0;

    if (putStatus !== 200) {
      throw new Error(`S3 upload failed: status ${putStatus}`);
    }

    core.info("Upload complete, finalizing...");

    // Step 3: Finalize
    const finalizeUrl = `${baseUrl}${twirpPrefix}FinalizeCacheEntryUpload`;
    const finalizeBody = JSON.stringify({
      key,
      version,
      sizeBytes: String(fileSize),
    });

    const finalizeResponse = await httpClient.post(finalizeUrl, finalizeBody, createHeaders);
    const finalizeStatus = finalizeResponse.message.statusCode || 0;

    if (finalizeStatus !== 200) {
      const finalizeResponseBody = await finalizeResponse.readBody();
      throw new Error(`FinalizeCacheEntryUpload failed: ${finalizeStatus} ${finalizeResponseBody}`);
    }
  } else {
    throw new Error("CreateCacheEntry returned ok=true but no upload URL");
  }

  core.info("Cache saved successfully.");
}

export async function downloadCache(
  archiveLocation: string,
  archivePath: string
): Promise<void> {
  // Try HEAD to get content-length; if it fails, fall back to single GET
  let contentLength = 0;
  try {
    const headResponse = await httpClient.head(archiveLocation);
    if (headResponse.message.statusCode === 200) {
      contentLength = Number(headResponse.message.headers["content-length"] || "0");
    }
  } catch {
    // HEAD not supported (common with presigned URLs) — try GET with Range to probe
  }

  // If HEAD didn't work, do a range request for first byte to get content-length
  if (contentLength === 0) {
    try {
      const probeResponse = await httpClient.get(archiveLocation, { Range: "bytes=0-0" });
      const rangeHeader = probeResponse.message.headers["content-range"] || "";
      // content-range: bytes 0-0/524373026
      const match = rangeHeader.match(/\/(\d+)$/);
      if (match) {
        contentLength = Number(match[1]);
      }
      // Consume and discard the probe response body
      probeResponse.message.resume();
    } catch {
      // Fall through to single GET
    }
  }

  if (contentLength === 0 || contentLength < DOWNLOAD_PART_SIZE * 2) {
    // Small file or can't determine size — single GET
    core.info("Downloading cache (single stream)");
    const response = await httpClient.get(archiveLocation);
    const statusCode = response.message.statusCode || 0;
    if (statusCode !== 200) {
      throw new Error(`Download failed with status ${statusCode}`);
    }
    const fileStream = fs.createWriteStream(archivePath);
    return new Promise((resolve, reject) => {
      response.message.pipe(fileStream);
      response.message.on("error", reject);
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
  }

  // Large file — parallel range downloads
  const numParts = Math.ceil(contentLength / DOWNLOAD_PART_SIZE);
  core.info(`Parallel download: ${numParts} parts, ${Math.round(DOWNLOAD_PART_SIZE / (1024 * 1024))}MB each, concurrency ${DOWNLOAD_CONCURRENCY}`);

  // Pre-allocate the file
  const fd = fs.openSync(archivePath, "w");
  fs.ftruncateSync(fd, contentLength);
  fs.closeSync(fd);

  const parts = Array.from({ length: numParts }, (_, i) => i);

  await parallelMap(parts, DOWNLOAD_CONCURRENCY, async (partIndex) => {
    const start = partIndex * DOWNLOAD_PART_SIZE;
    const end = Math.min(start + DOWNLOAD_PART_SIZE - 1, contentLength - 1);

    const rangeResponse = await httpClient.get(archiveLocation, {
      Range: `bytes=${start}-${end}`,
    });

    const statusCode = rangeResponse.message.statusCode || 0;
    if (statusCode !== 206 && statusCode !== 200) {
      throw new Error(`Range download failed: status ${statusCode} for bytes ${start}-${end}`);
    }

    const chunks: Buffer[] = [];
    return new Promise<void>((resolve, reject) => {
      rangeResponse.message.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      rangeResponse.message.on("end", () => {
        const data = Buffer.concat(chunks);
        const fd = fs.openSync(archivePath, "r+");
        fs.writeSync(fd, data, 0, data.length, start);
        fs.closeSync(fd);
        resolve();
      });
      rangeResponse.message.on("error", reject);
    });
  });

  const actualSize = fs.statSync(archivePath).size;
  if (actualSize !== contentLength) {
    throw new Error(`Download size mismatch: expected ${contentLength}, got ${actualSize}`);
  }
}

// uploadPart uploads a file range to a presigned URL using native https for true parallelism.
function uploadPart(url: string, filePath: string, start: number, length: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "PUT",
      headers: {
        "Content-Length": String(length),
      },
    };

    const proto = parsedUrl.protocol === "https:" ? require("https") : require("http");
    const req = proto.request(options, (res: any) => {
      let body = "";
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Upload part failed: ${res.statusCode} ${body}`));
          return;
        }
        const etag = res.headers["etag"] || "";
        resolve(etag);
      });
    });

    req.on("error", reject);

    const stream = fs.createReadStream(filePath, { start, end: start + length - 1 });
    stream.pipe(req);
  });
}

// parallelMap executes an async function over items with a concurrency limit.
async function parallelMap<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const executing: Set<Promise<void>> = new Set();

  for (const item of items) {
    const p = fn(item).then(() => {
      executing.delete(p);
    });
    executing.add(p);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
}
