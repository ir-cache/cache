export enum Inputs {
  Key = "key",
  Path = "path",
  RestoreKeys = "restore-keys",
  UploadChunkSize = "upload-chunk-size",
  EnableCrossOsArchive = "enableCrossOsArchive",
  FailOnCacheMiss = "fail-on-cache-miss",
  LookupOnly = "lookup-only",
}

export enum Outputs {
  CacheHit = "cache-hit",
  CachePrimaryKey = "cache-primary-key",
  CacheMatchedKey = "cache-matched-key",
}

export enum State {
  CachePrimaryKey = "CACHE_KEY",
  CacheMatchedKey = "CACHE_RESULT",
}

export enum Events {
  Key = "GITHUB_EVENT_NAME",
  Push = "push",
  PullRequest = "pull_request",
}

export const RefKey = "GITHUB_REF";
