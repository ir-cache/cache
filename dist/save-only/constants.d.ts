export declare enum Inputs {
    Key = "key",
    Path = "path",
    RestoreKeys = "restore-keys",
    UploadChunkSize = "upload-chunk-size",
    EnableCrossOsArchive = "enableCrossOsArchive",
    FailOnCacheMiss = "fail-on-cache-miss",
    LookupOnly = "lookup-only"
}
export declare enum Outputs {
    CacheHit = "cache-hit",
    CachePrimaryKey = "cache-primary-key",
    CacheMatchedKey = "cache-matched-key"
}
export declare enum State {
    CachePrimaryKey = "CACHE_KEY",
    CacheMatchedKey = "CACHE_RESULT"
}
export declare enum Events {
    Key = "GITHUB_EVENT_NAME",
    Push = "push",
    PullRequest = "pull_request"
}
export declare const RefKey = "GITHUB_REF";
