import { describe, expect, it, vi } from "vitest";
import {
  fetchLiteLLMKeyUsage,
  formatLiteLLMUsageText,
  parseLiteLLMKeyUsage,
  setupLiteLLMUsageStatus,
} from "../src/usage.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createPi() {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => void>>();
  return {
    handlers,
    on(event: string, handler: (event: any, ctx?: any) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
}

describe("LiteLLM key usage status", () => {
  it("parses and formats key spend from /key/info responses", () => {
    const usage = parseLiteLLMKeyUsage({ info: { spend: "1.25", max_budget: 5 } });

    expect(usage).toEqual({ spend: 1.25, maxBudget: 5 });
    expect(formatLiteLLMUsageText(usage)).toBe("LiteLLM $1.25/$5.00");
  });

  it("fetches /key/info without putting the key in the URL by default", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://litellm.example.com/key/info");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-test", Accept: "application/json" });
      return jsonResponse(200, { info: { spend: 0.42 } });
    });

    await expect(fetchLiteLLMKeyUsage("https://litellm.example.com/v1", "sk-test", { fetchImpl })).resolves.toEqual({
      spend: 0.42,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("can query a LiteLLM key with a separate usage read key", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://litellm.example.com/key/info?key=sk-llm");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-read", Accept: "application/json" });
      return jsonResponse(200, { info: { spend: 0.42 } });
    });

    await expect(
      fetchLiteLLMKeyUsage("https://litellm.example.com/v1", "sk-read", { fetchImpl, queryKey: "sk-llm" }),
    ).resolves.toEqual({ spend: 0.42 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("updates status for LiteLLM models and clears it for other providers", async () => {
    const previousUsageKey = process.env.LITELLM_USAGE_API_KEY;
    delete process.env.LITELLM_USAGE_API_KEY;
    try {
      const pi = createPi();
      const statuses: Array<{ key: string; text: string | undefined }> = [];
      const ui = {
        setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      };
      let spend = 1;
      const fetchImpl = vi.fn(async () => jsonResponse(200, { info: { spend: spend++, max_budget: 10 } }));

      setupLiteLLMUsageStatus(pi as any, {
        resolveCredentials: async () => ({ baseUrl: "https://litellm.example.com", apiKey: "sk-test" }),
        fetchImpl,
        refreshMs: 60_000,
        timeoutMs: 1_000,
      });

      pi.handlers.get("model_select")?.[0]?.({ model: { provider: "litellm", id: "test-model" } }, { ui });

      await vi.waitFor(() => expect(statuses.at(-1)?.text).toBe("LiteLLM $1.00/$10.00"));
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      pi.handlers.get("turn_end")?.[0]?.({}, { model: { provider: "litellm", id: "test-model" }, ui });

      await vi.waitFor(() => expect(statuses.at(-1)?.text).toBe("LiteLLM $2.00/$10.00"));
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      pi.handlers.get("model_select")?.[0]?.({ model: { provider: "openai", id: "gpt-5" } }, { ui });

      expect(statuses.at(-1)).toEqual({ key: "litellm-usage", text: undefined });
    } finally {
      if (previousUsageKey === undefined) delete process.env.LITELLM_USAGE_API_KEY;
      else process.env.LITELLM_USAGE_API_KEY = previousUsageKey;
    }
  });

  it("shows n/a warning when /key/info returns an error", async () => {
    const pi = createPi();
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const ui = {
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
    };
    const fetchImpl = vi.fn(async () => jsonResponse(403, { detail: "forbidden" }));

    setupLiteLLMUsageStatus(pi as any, {
      resolveCredentials: async () => ({ baseUrl: "https://litellm.example.com", apiKey: "sk-test" }),
      fetchImpl,
      refreshMs: 0,
      timeoutMs: 1_000,
    });

    pi.handlers.get("model_select")?.[0]?.({ model: { provider: "litellm", id: "test-model" } }, { ui });

    await vi.waitFor(() => expect(statuses.at(-1)?.text).toContain("LiteLLM n/a"));
  });

  it("uses LITELLM_USAGE_API_KEY for auth and passes the LLM key as query param", async () => {
    const previous = process.env.LITELLM_USAGE_API_KEY;
    process.env.LITELLM_USAGE_API_KEY = "sk-read";
    try {
      const fetchImpl = vi.fn(async () => jsonResponse(200, { info: { spend: 0.42 } }));

      const pi = createPi();
      const statuses: Array<{ key: string; text: string | undefined }> = [];
      const ui = {
        setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      };

      setupLiteLLMUsageStatus(pi as any, {
        resolveCredentials: async () => ({ baseUrl: "https://litellm.example.com", apiKey: "sk-llm" }),
        fetchImpl,
        refreshMs: 0,
        timeoutMs: 1_000,
      });

      pi.handlers.get("model_select")?.[0]?.({ model: { provider: "litellm", id: "test-model" } }, { ui });

      await vi.waitFor(() => expect(statuses.at(-1)?.text).toContain("LiteLLM $"));
      const calledUrl = String((fetchImpl.mock.calls[0] as unknown[])[0]);
      expect(calledUrl).toContain("key=sk-llm");
      const headers = ((fetchImpl.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBe("Bearer sk-read");
    } finally {
      if (previous === undefined) delete process.env.LITELLM_USAGE_API_KEY;
      else process.env.LITELLM_USAGE_API_KEY = previous;
    }
  });

  it("resolves the usage key via LITELLM_USAGE_API_KEY_HELPER and caches across turns", async () => {
    const previousKey = process.env.LITELLM_USAGE_API_KEY;
    const previousHelper = process.env.LITELLM_USAGE_API_KEY_HELPER;
    delete process.env.LITELLM_USAGE_API_KEY;
    process.env.LITELLM_USAGE_API_KEY_HELPER = "printf sk-read";
    try {
      let spend = 1;
      const fetchImpl = vi.fn(async () => jsonResponse(200, { info: { spend: spend++ } }));

      const pi = createPi();
      const statuses: Array<{ key: string; text: string | undefined }> = [];
      const ui = {
        setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      };

      setupLiteLLMUsageStatus(pi as any, {
        resolveCredentials: async () => ({ baseUrl: "https://litellm.example.com", apiKey: "sk-llm" }),
        fetchImpl,
        refreshMs: 60_000,
        timeoutMs: 1_000,
      });

      pi.handlers.get("model_select")?.[0]?.({ model: { provider: "litellm", id: "test-model" } }, { ui });

      await vi.waitFor(() => expect(statuses.at(-1)?.text).toContain("LiteLLM $"));
      const calledUrl = String((fetchImpl.mock.calls[0] as unknown[])[0]);
      expect(calledUrl).toContain("key=sk-llm");
      const headers = ((fetchImpl.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBe("Bearer sk-read");

      // Within refreshMs a non-forced read serves the cache without re-fetching.
      pi.handlers.get("session_start")?.[0]?.({}, { model: { provider: "litellm", id: "test-model" }, ui });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (previousKey === undefined) delete process.env.LITELLM_USAGE_API_KEY;
      else process.env.LITELLM_USAGE_API_KEY = previousKey;
      if (previousHelper === undefined) delete process.env.LITELLM_USAGE_API_KEY_HELPER;
      else process.env.LITELLM_USAGE_API_KEY_HELPER = previousHelper;
    }
  });

  it("does not register status handlers when disabled", () => {
    const previous = process.env.LITELLM_USAGE_STATUS;
    process.env.LITELLM_USAGE_STATUS = "0";
    try {
      const pi = createPi();
      setupLiteLLMUsageStatus(pi as any, {
        resolveCredentials: async () => ({ baseUrl: "https://litellm.example.com", apiKey: "sk-test" }),
      });

      expect(pi.handlers.size).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.LITELLM_USAGE_STATUS;
      else process.env.LITELLM_USAGE_STATUS = previous;
    }
  });
});
