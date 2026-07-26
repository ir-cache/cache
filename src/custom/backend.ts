import * as crypto from "crypto";
import * as fs from "fs";
import * as core from "@actions/core";
import { HttpClient } from "@actions/http-client";
import * as http from "http";
import { downloadCacheParallel } from "./downloadUtils";

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

const MAX_MULTIPART_PARTS = 10_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    core.warning(`${name}=${raw} is invalid; using ${fallback}`);
    return fallback;
  }
  return value;
}

export function getTransferSettings() {
  return {
    uploadConcurrency: boundedInteger("IR_UPLOAD_CONCURRENCY", 8, 1, 32),
    uploadMaxAttempts: boundedInteger("IR_UPLOAD_MAX_ATTEMPTS", 5, 1, 10),
    uploadTimeoutMs: boundedInteger("IR_UPLOAD_TIMEOUT_MS", 120_000, 1_000, 600_000),
    downloadConcurrency: boundedInteger("IR_DOWNLOAD_CONCURRENCY", 8, 1, 32),
    downloadPartSize: boundedInteger("IR_DOWNLOAD_PART_SIZE", 32, 1, 512) * 1024 * 1024,
  };
}

export function validateMultipartResponse(
  multipart: NonNullable<CreateCacheEntryResponse["multipart"]>,
  fileSize: number
): void {
  if (!multipart.uploadId || !Number.isSafeInteger(multipart.partSize) || multipart.partSize <= 0) {
    throw new Error("CreateCacheEntry returned invalid multipart metadata");
  }
  const expectedParts = Math.ceil(fileSize / multipart.partSize);
  const receivedParts = Array.isArray(multipart.parts) ? multipart.parts.length : 0;
  if (expectedParts < 1 || expectedParts > MAX_MULTIPART_PARTS || receivedParts !== expectedParts) {
    throw new Error(`CreateCacheEntry returned invalid multipart part count: expected ${expectedParts}, received ${receivedParts}`);
  }
  multipart.parts.forEach((part, index) => {
    if (part.partNumber !== index + 1 || !part.url) {
      throw new Error("CreateCacheEntry returned unordered or invalid multipart parts");
    }
  });
}

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
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is not available for IR cache scoping");
  }

  const headers: Record<string, string> = {
    "X-GitHub-Repository": repo,
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
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
  const settings = getTransferSettings();

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
    try {
      validateMultipartResponse(createResult.multipart, fileSize);
      core.info(`Multipart upload: ${parts.length} parts, ${Math.round(partSize / (1024 * 1024))}MB each, concurrency ${settings.uploadConcurrency}`);
      const completedParts: CompletedPart[] = new Array(parts.length);

      // Upload parts in parallel with concurrency limit using native https
      await parallelMap(parts, settings.uploadConcurrency, async (part) => {
        const start = (part.partNumber - 1) * partSize;
        const end = Math.min(start + partSize, fileSize);
        const partLength = end - start;

        const etag = await withUploadRetry(`part ${part.partNumber}`, settings.uploadMaxAttempts, () =>
          uploadPart(part.url, archivePath, start, partLength, settings.uploadTimeoutMs)
        );
        if (!etag) throw new Error(`Upload part ${part.partNumber} returned no ETag`);
        completedParts[part.partNumber - 1] = { partNumber: part.partNumber, etag };
        core.info(`Uploaded part ${part.partNumber}/${parts.length}`);
      });

      const finalizeUrl = `${baseUrl}${twirpPrefix}FinalizeCacheEntryUpload`;
      const finalizeBody = JSON.stringify({ key, version, sizeBytes: String(fileSize), uploadId, parts: completedParts });
      const finalizeResponse = await httpClient.post(finalizeUrl, finalizeBody, createHeaders);
      const finalizeStatus = finalizeResponse.message.statusCode || 0;
      if (finalizeStatus !== 200) {
        const finalizeResponseBody = await finalizeResponse.readBody();
        throw new Error(`FinalizeCacheEntryUpload failed: ${finalizeStatus} ${finalizeResponseBody}`);
      }
    } catch (error) {
      await abortMultipartUpload(baseUrl, key, version, uploadId, createHeaders);
      throw error;
    }
  } else if (createResult.signedUploadUrl) {
    // Single PUT upload using native http/https to handle both protocols
    await withUploadRetry("cache archive", settings.uploadMaxAttempts, () =>
      uploadSingleFile(createResult.signedUploadUrl, archivePath, fileSize, settings.uploadTimeoutMs)
    );

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
  const settings = getTransferSettings();
  core.info(`Downloading cache (concurrency=${settings.downloadConcurrency}, segment=${Math.round(settings.downloadPartSize / (1024 * 1024))}MB)...`);
  await downloadCacheParallel(
    archiveLocation,
    archivePath,
    settings.downloadConcurrency,
    settings.downloadPartSize
  );
}

// uploadPart uploads a file range to a presigned URL using native https for true parallelism.
class UploadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export function isRetryableUploadStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

async function withUploadRetry<T>(description: string, maxAttempts: number, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof UploadError) || error.retryable;
      if (!retryable || attempt === maxAttempts) throw error;
      const delayMs = Math.min(1_000 * 2 ** (attempt - 1), 8_000);
      core.warning(`Upload ${description} failed (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function abortMultipartUpload(
  baseUrl: string,
  key: string,
  version: string,
  uploadId: string,
  headers: Record<string, string>
): Promise<void> {
  try {
    const response = await httpClient.post(
      `${baseUrl}${twirpPrefix}AbortCacheEntryUpload`,
      JSON.stringify({ key, version, uploadId }),
      headers
    );
    const status = response.message.statusCode || 0;
    if (status !== 200) {
      core.warning(`Unable to abort multipart cache upload ${uploadId}: status ${status}`);
    }
  } catch (error) {
    core.warning(`Unable to abort multipart cache upload ${uploadId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function uploadPart(url: string, filePath: string, start: number, length: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "PUT",
      headers: {
        "Content-Length": String(length),
      },
    };

    const proto = parsedUrl.protocol === "https:" ? require("https") : require("http");
    const stream = fs.createReadStream(filePath, { start, end: start + length - 1 });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };
    const req = proto.request(options, (res: any) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        if (body.length < MAX_ERROR_BODY_BYTES) body += chunk.toString().slice(0, MAX_ERROR_BODY_BYTES - body.length);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          fail(new UploadError(`Upload part failed: ${res.statusCode} ${body}`, isRetryableUploadStatus(res.statusCode || 0)));
          return;
        }
        settled = true;
        const etagHeader = res.headers["etag"];
        const etag = Array.isArray(etagHeader) ? etagHeader[0] || "" : etagHeader || "";
        resolve(etag);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`upload timed out after ${timeoutMs}ms`)));
    req.on("error", (error: Error) => fail(new UploadError(error.message, true)));
    stream.on("error", fail);
    stream.pipe(req);
  });
}

// uploadSingleFile uploads an entire file to a presigned URL using native http/https.
function uploadSingleFile(url: string, filePath: string, fileSize: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "PUT",
      headers: {
        "Content-Length": String(fileSize),
        "Content-Type": "application/octet-stream",
      },
    };

    const proto = parsedUrl.protocol === "https:" ? require("https") : require("http");
    const stream = fs.createReadStream(filePath);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };
    const req = proto.request(options, (res: any) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        if (body.length < MAX_ERROR_BODY_BYTES) body += chunk.toString().slice(0, MAX_ERROR_BODY_BYTES - body.length);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          fail(new UploadError(`S3 upload failed: status ${res.statusCode} ${body}`, isRetryableUploadStatus(res.statusCode || 0)));
          return;
        }
        settled = true;
        resolve();
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`upload timed out after ${timeoutMs}ms`)));
    req.on("error", (error: Error) => fail(new UploadError(error.message, true)));
    stream.on("error", fail);
    stream.pipe(req);
  });
}

// parallelMap executes an async function over items with a concurrency limit.
async function parallelMap<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (firstError === undefined) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        await fn(items[index]);
      } catch (error) {
        firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) {
    throw firstError;
  }
}
