import * as crypto from "crypto";
import * as fs from "fs";
import * as core from "@actions/core";
import { HttpClient } from "@actions/http-client";

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
    // Multipart upload
    const { uploadId, parts, partSize } = createResult.multipart;
    core.info(`Multipart upload: ${parts.length} parts, ${Math.round(partSize / (1024 * 1024))}MB each`);

    const completedParts: CompletedPart[] = [];

    for (const part of parts) {
      const start = (part.partNumber - 1) * partSize;
      const end = Math.min(start + partSize, fileSize);
      const stream = fs.createReadStream(archivePath, { start, end: end - 1 });

      const putResponse = await httpClient.sendStream("PUT", part.url, stream, {
        "Content-Length": String(end - start),
      });
      const putStatus = putResponse.message.statusCode || 0;

      if (putStatus !== 200) {
        throw new Error(`Multipart upload part ${part.partNumber} failed: status ${putStatus}`);
      }

      const etag = putResponse.message.headers["etag"] || "";
      completedParts.push({ partNumber: part.partNumber, etag });
      core.info(`Uploaded part ${part.partNumber}/${parts.length}`);
    }

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
