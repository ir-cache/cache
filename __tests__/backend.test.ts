import { getCacheVersion, getAuthHeaders } from "../src/custom/backend";

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
});
