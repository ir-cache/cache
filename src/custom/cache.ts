import * as core from "@actions/core";
import * as path from "path";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as cacheHttpClient from "./backend";
import {
  createTar,
  extractTar,
  listTar,
} from "@actions/cache/lib/internal/tar";
import { computeContentSHA256 } from "./contentDigest";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

function checkPaths(paths: string[]): void {
  if (!paths || paths.length === 0) {
    throw new ValidationError(
      "Path Validation Error: At least one directory or file path is required"
    );
  }
}

function checkKey(key: string): void {
  if (key.length > 512) {
    throw new ValidationError(
      `Key Validation Error: ${key} cannot be larger than 512 characters.`
    );
  }
  if (/,/.test(key)) {
    throw new ValidationError(
      `Key Validation Error: ${key} cannot contain commas.`
    );
  }
}

export async function restoreCache(
  paths: string[],
  primaryKey: string,
  restoreKeys?: string[],
  options?: { lookupOnly?: boolean },
  enableCrossOsArchive = false
): Promise<string | undefined> {
  checkPaths(paths);

  restoreKeys = restoreKeys || [];
  const keys = [primaryKey, ...restoreKeys];

  if (keys.length > 10) {
    throw new ValidationError("Key Validation Error: Keys are limited to 10.");
  }
  for (const key of keys) {
    checkKey(key);
  }

  const compressionMethod = await utils.getCompressionMethod();
  let archivePath = "";

  try {
    const cacheEntry = await cacheHttpClient.getCacheEntry(keys, paths, {
      compressionMethod,
      enableCrossOsArchive,
    });

    if (!cacheEntry?.archiveLocation) {
      return undefined;
    }

    if (options?.lookupOnly) {
      core.info("Lookup only - skipping download");
      return cacheEntry.cacheKey;
    }

    archivePath = path.join(
      await utils.createTempDirectory(),
      utils.getCacheFileName(compressionMethod)
    );

    core.debug(`Archive Path: ${archivePath}`);

    await cacheHttpClient.downloadCache(
      cacheEntry.archiveLocation,
      archivePath
    );

    if (core.isDebug()) {
      await listTar(archivePath, compressionMethod);
    }

    const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
    core.info(
      `Cache Size: ~${Math.round(archiveFileSize / (1024 * 1024))} MB (${archiveFileSize} B)`
    );

    await extractTar(archivePath, compressionMethod);
    core.info("Cache restored successfully");

    return cacheEntry.cacheKey;
  } catch (error) {
    const typedError = error as Error;
    if (typedError.name === "ValidationError") {
      throw error;
    }
    core.warning(`Failed to restore: ${typedError.message}`);
  } finally {
    try {
      if (archivePath) {
        await utils.unlinkFile(archivePath);
      }
    } catch (error) {
      core.debug(`Failed to delete archive: ${error}`);
    }
  }

  return undefined;
}

export async function saveCache(
  paths: string[],
  key: string,
  options?: { uploadChunkSize?: number },
  enableCrossOsArchive = false
): Promise<number> {
  checkPaths(paths);
  checkKey(key);

  const compressionMethod = await utils.getCompressionMethod();

  const cachePaths = await utils.resolvePaths(paths);
  core.debug("Cache Paths:");
  core.debug(`${JSON.stringify(cachePaths)}`);

  if (cachePaths.length === 0) {
    throw new Error(
      "Path Validation Error: Path(s) specified do not exist, no cache saved."
    );
  }

  core.info("Calculating normalized cache content SHA-256...");
  const contentSha256 = await computeContentSHA256(cachePaths);
  core.info(`Cache content SHA-256: ${contentSha256}`);
  const checkResult = await cacheHttpClient.checkCacheEntry(key, paths, contentSha256, {
    compressionMethod,
    enableCrossOsArchive,
  });
  if (checkResult === "duplicate") {
    core.info("Identical cache entry already exists — skipping archive creation and upload");
    return 1;
  }

  const archiveFolder = await utils.createTempDirectory();
  const archivePath = path.join(
    archiveFolder,
    utils.getCacheFileName(compressionMethod)
  );

  core.debug(`Archive Path: ${archivePath}`);

  try {
    await createTar(archiveFolder, cachePaths, compressionMethod);

    if (core.isDebug()) {
      await listTar(archivePath, compressionMethod);
    }

    const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
    core.debug(`File Size: ${archiveFileSize}`);

    await cacheHttpClient.saveCache(key, paths, archivePath, contentSha256, {
      compressionMethod,
      enableCrossOsArchive,
      chunkSize: options?.uploadChunkSize,
    });

    return 1;
  } catch (error) {
    throw error;
  } finally {
    try {
      await utils.unlinkFile(archivePath);
    } catch (error) {
      core.debug(`Failed to delete archive: ${error}`);
    }
  }
}
