export interface ArtifactCacheEntry {
    cacheKey?: string;
    archiveLocation?: string;
}
interface CreateCacheEntryResponse {
    ok: boolean;
    signedUploadUrl: string;
    multipart?: {
        uploadId: string;
        partSize: number;
        parts: Array<{
            partNumber: number;
            url: string;
        }>;
    };
}
export declare function getTransferSettings(): {
    uploadConcurrency: number;
    uploadMaxAttempts: number;
    uploadTimeoutMs: number;
    downloadConcurrency: number;
    downloadPartSize: number;
};
export declare function validateMultipartResponse(multipart: NonNullable<CreateCacheEntryResponse["multipart"]>, fileSize: number): void;
export declare function getAuthHeaders(): Record<string, string>;
export declare function getCacheVersion(paths: string[], compressionMethod?: string, enableCrossOsArchive?: boolean): string;
export declare function getCacheEntry(keys: string[], paths: string[], options: {
    compressionMethod?: string;
    enableCrossOsArchive?: boolean;
}): Promise<ArtifactCacheEntry | null>;
export declare function checkCacheEntry(key: string, paths: string[], contentSha256: string, options: {
    compressionMethod?: string;
    enableCrossOsArchive?: boolean;
}): Promise<"miss" | "duplicate">;
export declare function saveCache(key: string, paths: string[], archivePath: string, contentSha256: string, options: {
    compressionMethod?: string;
    enableCrossOsArchive?: boolean;
    chunkSize?: number;
}): Promise<void>;
export declare function downloadCache(archiveLocation: string, archivePath: string): Promise<void>;
export declare function isRetryableUploadStatus(statusCode: number): boolean;
export {};
