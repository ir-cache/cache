export interface ArtifactCacheEntry {
    cacheKey?: string;
    archiveLocation?: string;
}
export declare function getAuthHeaders(): Record<string, string>;
export declare function getCacheVersion(paths: string[], compressionMethod?: string, enableCrossOsArchive?: boolean): string;
export declare function getCacheEntry(keys: string[], paths: string[], options: {
    compressionMethod?: string;
    enableCrossOsArchive?: boolean;
}): Promise<ArtifactCacheEntry | null>;
export declare function reserveCache(key: string, paths: string[], options: {
    compressionMethod?: string;
    enableCrossOsArchive?: boolean;
}): Promise<number>;
export declare function uploadChunks(cacheId: number, archivePath: string, chunkSize: number): Promise<void>;
export declare function commitCache(cacheId: number, size: number): Promise<void>;
export declare function saveCache(key: string, paths: string[], archivePath: string, options: {
    compressionMethod?: string;
    enableCrossOsArchive?: boolean;
    chunkSize?: number;
}): Promise<void>;
export declare function downloadCache(archiveLocation: string, archivePath: string): Promise<void>;
