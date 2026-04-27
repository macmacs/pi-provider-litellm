import { createHash } from "node:crypto";
import type { CacheFile } from "./types.js";

export function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function isCacheValid(
  cache: CacheFile | null,
  baseUrl: string,
  apiKey: string,
): boolean {
  if (!cache) return false;
  return cache.baseUrl === baseUrl && cache.apiKeyFingerprint === fingerprint(apiKey);
}
