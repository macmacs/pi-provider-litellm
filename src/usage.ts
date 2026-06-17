import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fingerprint } from "./cache.js";

const PROVIDER_NAME = "litellm";
const STATUS_KEY = "litellm-usage";
const ENV_USAGE_STATUS = "LITELLM_USAGE_STATUS";
const ENV_USAGE_REFRESH_MS = "LITELLM_USAGE_REFRESH_MS";
const ENV_USAGE_API_KEY = "LITELLM_USAGE_API_KEY";
const ENV_USAGE_API_KEY_HELPER = "LITELLM_USAGE_API_KEY_HELPER";
const DEFAULT_USAGE_REFRESH_MS = 60_000;
const DEFAULT_USAGE_TIMEOUT_MS = 5_000;
const STALE_USAGE_RESULT = "stale LiteLLM usage result";

export interface LiteLLMUsageCredentials {
  baseUrl?: string;
  apiKey?: string;
}

export interface LiteLLMKeyUsage {
  spend: number;
  maxBudget?: number;
}

interface UsageStatusOptions {
  resolveCredentials: () => Promise<LiteLLMUsageCredentials>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshMs?: number;
  timeoutMs?: number;
}

type StatusContext = Partial<Pick<ExtensionContext, "hasUI" | "model" | "signal" | "ui">>;

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1\/?$/i, "");
}

function getRefreshMs(): number {
  const raw = process.env[ENV_USAGE_REFRESH_MS];
  if (raw === undefined) return DEFAULT_USAGE_REFRESH_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? DEFAULT_USAGE_REFRESH_MS : parsed;
}

function isUsageStatusEnabled(): boolean {
  return process.env[ENV_USAGE_STATUS] !== "0";
}

function cleanConfig(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && trimmed !== "undefined" ? trimmed : undefined;
}

function normalizeCommand(raw: string | undefined): string | undefined {
  const trimmed = cleanConfig(raw);
  if (!trimmed) return undefined;
  return trimmed.startsWith("!") ? trimmed : `!${trimmed}`;
}

function executeApiKeyCommand(commandConfig: string): string {
  const command = commandConfig.startsWith("!") ? commandConfig.slice(1) : commandConfig;
  const output = execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  if (!output) throw new Error("LiteLLM usage API key helper produced no output");
  return output;
}

function getUsageApiKeyOverride(): string | undefined {
  const helper = normalizeCommand(process.env[ENV_USAGE_API_KEY_HELPER]);
  if (helper) return executeApiKeyCommand(helper);
  return cleanConfig(process.env[ENV_USAGE_API_KEY]);
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function pickBudget(info: Record<string, unknown>): number | undefined {
  return (
    numericValue(info.max_budget) ??
    numericValue(info.key_max_budget) ??
    numericValue(info.budget) ??
    numericValue(objectValue(info.litellm_budget_table)?.max_budget) ??
    numericValue(objectValue(info.budget_table)?.max_budget)
  );
}

export function parseLiteLLMKeyUsage(payload: unknown): LiteLLMKeyUsage {
  const root = objectValue(payload);
  if (!root) throw new Error("/key/info returned a non-object response");

  const info = objectValue(root.info) ?? root;
  const spend = numericValue(info.spend) ?? numericValue(root.spend);
  if (spend === undefined) throw new Error("/key/info response did not include key spend");

  const maxBudget = pickBudget(info);
  return {
    spend,
    ...(maxBudget !== undefined ? { maxBudget } : {}),
  };
}

function withTimeout(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function fetchLiteLLMKeyUsage(
  baseUrl: string,
  apiKey: string,
  options: { fetchImpl?: typeof fetch; queryKey?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<LiteLLMKeyUsage> {
  const { signal, cancel } = withTimeout(options.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS, options.signal);
  try {
    const url = new URL(`${cleanBaseUrl(baseUrl)}/key/info`);
    if (options.queryKey) url.searchParams.set("key", options.queryKey);
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error(`/key/info returned ${response.status}`);
    return parseLiteLLMKeyUsage(await response.json());
  } finally {
    cancel();
  }
}

function formatUsd(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(0)}k`;
  if (abs >= 1_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 100) return `${sign}$${abs.toFixed(0)}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function formatLiteLLMUsageText(usage: LiteLLMKeyUsage): string {
  const spend = formatUsd(usage.spend);
  return usage.maxBudget === undefined ? `LiteLLM ${spend}` : `LiteLLM ${spend}/${formatUsd(usage.maxBudget)}`;
}

function styleStatus(ctx: StatusContext, text: string, tone: "normal" | "warning" = "normal"): string {
  const theme = ctx.ui?.theme;
  if (!theme) return text;
  const prefix = tone === "warning" ? theme.fg("warning", "LiteLLM") : theme.fg("accent", "LiteLLM");
  return prefix + theme.fg("dim", text.slice("LiteLLM".length));
}

function safeSetStatus(ctx: StatusContext, text: string | undefined, tone?: "normal" | "warning"): void {
  try {
    ctx.ui?.setStatus(STATUS_KEY, text === undefined ? undefined : styleStatus(ctx, text, tone));
  } catch {
    // The ctx can become stale if a session is replaced while a usage fetch is in flight.
  }
}

function providerFromContext(ctx: StatusContext): string | undefined {
  return ctx.model?.provider;
}

export function setupLiteLLMUsageStatus(pi: ExtensionAPI, options: UsageStatusOptions): void {
  if (!isUsageStatusEnabled()) return;

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const refreshMs = options.refreshMs ?? getRefreshMs();
  const timeoutMs = options.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS;
  let activeProvider: string | undefined;
  let latestCacheKey: string | undefined;
  let cached: { cacheKey: string; fetchedAt: number; usage: LiteLLMKeyUsage } | undefined;
  let inFlight: { cacheKey: string; promise: Promise<{ cacheKey: string; usage: LiteLLMKeyUsage }> } | undefined;

  async function readUsage(force: boolean, signal?: AbortSignal): Promise<LiteLLMKeyUsage> {
    const credentials = await options.resolveCredentials();
    if (!credentials.baseUrl || !credentials.apiKey) throw new Error("no LiteLLM credentials available");

    const baseUrl = cleanBaseUrl(credentials.baseUrl);
    // The cache identity is derived purely from config sources (no exec), so a
    // cache hit never has to resolve the usage key. Helper commands and the
    // keys they print are intentionally fingerprinted by their config source.
    const usageKeySource =
      cleanConfig(process.env[ENV_USAGE_API_KEY]) ?? cleanConfig(process.env[ENV_USAGE_API_KEY_HELPER]);
    const usageKeyFp = usageKeySource ? fingerprint(usageKeySource) : "self";
    const cacheKey = `${baseUrl}:${fingerprint(credentials.apiKey)}:${usageKeyFp}`;
    latestCacheKey = cacheKey;
    if (!force && cached?.cacheKey === cacheKey && now() - cached.fetchedAt <= refreshMs) return cached.usage;

    if (!inFlight || inFlight.cacheKey !== cacheKey) {
      // Cache miss: resolve the actual usage key (may run execSync).
      const usageApiKey = usageKeySource ? getUsageApiKeyOverride() : undefined;
      const authKey = usageApiKey ?? credentials.apiKey;
      const queryKey = usageApiKey ? credentials.apiKey : undefined;
      const promise = fetchLiteLLMKeyUsage(baseUrl, authKey, { fetchImpl, queryKey, signal, timeoutMs })
        .then((usage) => ({ cacheKey, usage }))
        .finally(() => {
          if (inFlight?.cacheKey === cacheKey) inFlight = undefined;
        });
      inFlight = { cacheKey, promise };
    }

    const result = await inFlight.promise;
    if (latestCacheKey !== result.cacheKey) throw new Error(STALE_USAGE_RESULT);
    cached = { cacheKey: result.cacheKey, fetchedAt: now(), usage: result.usage };
    return result.usage;
  }

  function setActiveProvider(provider: string | undefined, ctx: StatusContext): boolean {
    if (!provider) return activeProvider === PROVIDER_NAME;
    activeProvider = provider;
    if (provider !== PROVIDER_NAME) {
      safeSetStatus(ctx, undefined);
      return false;
    }
    return true;
  }

  function scheduleUpdate(ctx: StatusContext, force: boolean, signal?: AbortSignal): void {
    if (ctx.hasUI === false) return;
    const provider = providerFromContext(ctx);
    if (!setActiveProvider(provider, ctx)) return;
    if (!cached) safeSetStatus(ctx, "LiteLLM ...");

    void readUsage(force, signal)
      .then((usage) => {
        if (activeProvider !== PROVIDER_NAME) return;
        safeSetStatus(ctx, formatLiteLLMUsageText(usage));
      })
      .catch((error) => {
        if (error instanceof Error && error.message === STALE_USAGE_RESULT) return;
        if (activeProvider !== PROVIDER_NAME) return;
        safeSetStatus(ctx, "LiteLLM n/a", "warning");
      });
  }

  pi.on("session_start", (_event, ctx) => {
    scheduleUpdate(ctx as StatusContext, false);
  });

  pi.on("model_select", (event, ctx) => {
    activeProvider = event.model.provider;
    if (event.model.provider !== PROVIDER_NAME) {
      safeSetStatus(ctx as StatusContext, undefined);
      return;
    }
    scheduleUpdate({ ...(ctx as StatusContext), model: event.model }, false);
  });

  pi.on("turn_end", (_event, ctx) => {
    // Do not pass ctx.signal — the turn-scoped signal may already be aborted
    // by the time this handler fires, which would cancel the usage fetch.
    scheduleUpdate(ctx as StatusContext, true);
  });
}
