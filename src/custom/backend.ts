import * as crypto from "crypto";
import * as fs from "fs";
import * as core from "@actions/core";
import { HttpClient } from "@actions/http-client";

export interface ArtifactCacheEntry {
  cacheKey?: string;
  archiveLocation?: string;
}

interface ReserveResponse {
  cacheId: number;
}

interface LookupResponse {
  archiveLocation?: string;
  cacheKey?: string;
}

const versionSalt = "1.0";
const httpClient = new HttpClient("ir-cache-action");

function getBaseUrl(): string {
  const url = process.env.IR_CACHE_URL;
  if (!url) {
    throw new Error("IR_CACHE_URL environment variable is not set");
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
  const keysParam = keys.join(",");
  const url = `${baseUrl}/cache/_apis/artifactcache/cache?keys=${encodeURIComponent(keysParam)}&version=${encodeURIComponent(version)}`;

  const headers = getAuthHeaders();
  const response = await httpClient.getJson<LookupResponse>(url, headers);

  if (response.statusCode === 204 || !response.result?.archiveLocation) {
    return null;
  }

  return {
    cacheKey: response.result.cacheKey,
    archiveLocation: response.result.archiveLocation,
  };
}

export async function reserveCache(
  key: string,
  paths: string[],
  options: { compressionMethod?: string; enableCrossOsArchive?: boolean }
): Promise<number> {
  const baseUrl = getBaseUrl();
  const version = getCacheVersion(
    paths,
    options.compressionMethod,
    options.enableCrossOsArchive
  );
  const url = `${baseUrl}/cache/_apis/artifactcache/caches`;

  const headers = {
    ...getAuthHeaders(),
    "Content-Type": "application/json",
  };

  const body = JSON.stringify({ key, version });
  const response = await httpClient.post(url, body, headers);
  const statusCode = response.message.statusCode || 0;

  if (statusCode === 409) {
    core.info(`Cache entry already exists for key: ${key}`);
    return -1;
  }

  const responseBody = await response.readBody();
  const result = JSON.parse(responseBody) as ReserveResponse;

  if (statusCode !== 201 || !result?.cacheId) {
    throw new Error(`Reserve cache failed with status ${statusCode}`);
  }

  return result.cacheId;
}

export async function uploadChunks(
  cacheId: number,
  archivePath: string,
  chunkSize: number
): Promise<void> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/cache/_apis/artifactcache/caches/${cacheId}`;
  const fileSize = fs.statSync(archivePath).size;

  let offset = 0;
  let partNum = 1;
  const totalParts = Math.ceil(fileSize / chunkSize);

  while (offset < fileSize) {
    const chunkEnd = Math.min(offset + chunkSize, fileSize);
    const stream = fs.createReadStream(archivePath, {
      start: offset,
      end: chunkEnd - 1,
    });

    const headers = {
      ...getAuthHeaders(),
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes ${offset}-${chunkEnd - 1}/*`,
    };

    const response = await httpClient.sendStream("PATCH", url, stream, headers);
    const statusCode = response.message.statusCode || 0;

    if (statusCode !== 204 && statusCode !== 200) {
      throw new Error(`Upload chunk failed: status ${statusCode}`);
    }

    core.info(`Uploaded part ${partNum}/${totalParts}`);
    offset = chunkEnd;
    partNum++;
  }
}

export async function commitCache(
  cacheId: number,
  size: number
): Promise<void> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/cache/_apis/artifactcache/caches/${cacheId}`;

  const headers = {
    ...getAuthHeaders(),
    "Content-Type": "application/json",
  };

  const body = JSON.stringify({ size });
  const response = await httpClient.post(url, body, headers);
  const statusCode = response.message.statusCode || 0;

  if (statusCode !== 200 && statusCode !== 204) {
    throw new Error(`Commit cache failed with status ${statusCode}`);
  }
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
  const chunkSize = options.chunkSize || 32 * 1024 * 1024;
  const fileSize = fs.statSync(archivePath).size;

  core.info(
    `Cache Size: ~${Math.round(fileSize / (1024 * 1024))} MB (${fileSize} B)`
  );

  const cacheId = await reserveCache(key, paths, options);
  if (cacheId === -1) {
    return;
  }

  core.info(`Reserved cache with ID: ${cacheId}`);
  await uploadChunks(cacheId, archivePath, chunkSize);
  await commitCache(cacheId, fileSize);
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
