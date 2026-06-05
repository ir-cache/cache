export declare class ValidationError extends Error {
    constructor(message: string);
}
export declare function restoreCache(paths: string[], primaryKey: string, restoreKeys?: string[], options?: {
    lookupOnly?: boolean;
}, enableCrossOsArchive?: boolean): Promise<string | undefined>;
export declare function saveCache(paths: string[], key: string, options?: {
    uploadChunkSize?: number;
}, enableCrossOsArchive?: boolean): Promise<number>;
