import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";

export function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/, "").replace(/\/v1\/?$/i, "");
}

export function buildCompat(modelId: string): ProviderModelConfig["compat"] {
  if (modelId.startsWith("anthropic/")) {
    return { supportsStore: false, cacheControlFormat: "anthropic" };
  }
  return { supportsStore: false };
}
