import { describe, expect, it } from "vitest";
import { fingerprint, isCacheValid } from "../src/cache.js";
import type { CacheFile } from "../src/types.js";

describe("fingerprint", () => {
  it("produces a stable sha256 hex digest", () => {
    expect(fingerprint("secret")).toBe(fingerprint("secret"));
    expect(fingerprint("secret")).toHaveLength(64);
    expect(fingerprint("secret")).toMatch(/^[a-f0-9]+$/);
  });

  it("differs across inputs", () => {
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
  });
});

describe("isCacheValid", () => {
  const cache: CacheFile = {
    baseUrl: "https://litellm.example.com",
    apiKeyFingerprint: fingerprint("k1"),
    fetchedAt: Date.now(),
    source: "model_info",
    models: [],
  };

  it("returns true when baseUrl and fingerprint match", () => {
    expect(isCacheValid(cache, "https://litellm.example.com", "k1")).toBe(true);
  });

  it("returns false when baseUrl differs", () => {
    expect(isCacheValid(cache, "https://other.example.com", "k1")).toBe(false);
  });

  it("returns false when api key differs", () => {
    expect(isCacheValid(cache, "https://litellm.example.com", "k2")).toBe(false);
  });

  it("returns false for null cache", () => {
    expect(isCacheValid(null, "https://litellm.example.com", "k1")).toBe(false);
  });
});
