import {
  getCacheVersion,
  getAuthHeaders,
  getTransferSettings,
  isRetryableUploadStatus,
  validateMultipartResponse,
} from "../src/custom/backend";

describe("backend", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getCacheVersion", () => {
    it("produces consistent hash for same inputs", () => {
      const v1 = getCacheVersion(["node_modules"], "zstd");
      const v2 = getCacheVersion(["node_modules"], "zstd");
      expect(v1).toBe(v2);
    });

    it("produces different hash for different paths", () => {
      const v1 = getCacheVersion(["node_modules"], "zstd");
      const v2 = getCacheVersion(["vendor"], "zstd");
      expect(v1).not.toBe(v2);
    });

    it("includes compression method in hash", () => {
      const v1 = getCacheVersion(["node_modules"], "zstd");
      const v2 = getCacheVersion(["node_modules"], "gzip");
      expect(v1).not.toBe(v2);
    });
  });

  describe("getAuthHeaders", () => {
    it("uses GITHUB_TOKEN when available", () => {
      process.env.GITHUB_TOKEN = "ghs_test123";
      process.env.GITHUB_REPOSITORY = "acme/webapp";
      const headers = getAuthHeaders();
      expect(headers["Authorization"]).toBe("Bearer ghs_test123");
      expect(headers["X-GitHub-Repository"]).toBe("acme/webapp");
    });

    it("uses X-GitHub-Repository when no token", () => {
      delete process.env.GITHUB_TOKEN;
      process.env.GITHUB_REPOSITORY = "acme/webapp";
      const headers = getAuthHeaders();
      expect(headers["X-GitHub-Repository"]).toBe("acme/webapp");
    });

    it("throws when repository context is unavailable", () => {
      process.env.GITHUB_TOKEN = "ghs_test123";
      delete process.env.GITHUB_REPOSITORY;
      expect(() => getAuthHeaders()).toThrow("GITHUB_REPOSITORY is not available");
    });
  });

  describe("transfer settings", () => {
    it("uses bounded defaults for invalid environment values", () => {
      process.env.IR_UPLOAD_CONCURRENCY = "0";
      process.env.IR_UPLOAD_MAX_ATTEMPTS = "unlimited";
      process.env.IR_UPLOAD_TIMEOUT_MS = "99999999";
      expect(getTransferSettings()).toMatchObject({
        uploadConcurrency: 8,
        uploadMaxAttempts: 5,
        uploadTimeoutMs: 120000,
      });
    });

    it("accepts valid configured values", () => {
      process.env.IR_UPLOAD_CONCURRENCY = "4";
      process.env.IR_UPLOAD_MAX_ATTEMPTS = "3";
      process.env.IR_UPLOAD_TIMEOUT_MS = "30000";
      expect(getTransferSettings()).toMatchObject({
        uploadConcurrency: 4,
        uploadMaxAttempts: 3,
        uploadTimeoutMs: 30000,
      });
    });
  });

  describe("multipart validation", () => {
    it("accepts complete ordered metadata", () => {
      expect(() => validateMultipartResponse({
        uploadId: "upload-1",
        partSize: 10,
        parts: [
          { partNumber: 1, url: "https://s3/1" },
          { partNumber: 2, url: "https://s3/2" },
        ],
      }, 20)).not.toThrow();
    });

    it("rejects missing, unordered, or excessive parts", () => {
      expect(() => validateMultipartResponse({
        uploadId: "upload-1",
        partSize: 10,
        parts: [{ partNumber: 2, url: "https://s3/2" }],
      }, 10)).toThrow("unordered or invalid");

      expect(() => validateMultipartResponse({
        uploadId: "upload-1",
        partSize: 1,
        parts: [],
      }, 10001)).toThrow("invalid multipart part count");
    });
  });

  it("only retries transient HTTP statuses", () => {
    expect(isRetryableUploadStatus(408)).toBe(true);
    expect(isRetryableUploadStatus(429)).toBe(true);
    expect(isRetryableUploadStatus(503)).toBe(true);
    expect(isRetryableUploadStatus(403)).toBe(false);
  });
});
