import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyQuotaScope, generateLiveStructured, quotaDetail } from "./live-content.js";
import { isScriptCapableModel, rankContentModels } from "./content-models.js";

afterEach(() => { vi.unstubAllGlobals(); });

/** The 429 body Gemini really returns when one model's free-tier daily quota is spent (captured 2026-10-09). */
const geminiDailyModelQuota = {
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-2.5-flash\nPlease retry in 22h6m26.2s.",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaDimensions: { location: "global", model: "gemini-2.5-flash" }, quotaValue: "20" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "79586s" },
    ],
  },
};

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));

describe("quota / rate-limit classification", () => {
  it("a Gemini per-model DAILY quota is the model's, not the account's - even though the text mentions billing", async () => {
    const fetchMock = respond(429, geminiDailyModelQuota);
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateLiveStructured("gemini", "key", "gemini-2.5-flash", "prompt")).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED", quotaScope: "daily", retryAfterMs: 79_586_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry that would burn quota
  });

  it("a per-minute model limit is `minute` and keeps Google's retryDelay", async () => {
    vi.stubGlobal("fetch", respond(429, { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 5, model: gemini-3.5-flash", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaDimensions: { model: "gemini-3.5-flash" } }] }, { retryDelay: "34s" }] } }));
    await expect(generateLiveStructured("gemini", "key", "gemini-3.5-flash", "prompt")).rejects.toMatchObject({ quotaScope: "minute", retryAfterMs: 34_000 });
  });

  it("billing / credits without a model reach the whole account", async () => {
    vi.stubGlobal("fetch", respond(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota" } }));
    await expect(generateLiveStructured("openai", "sk-test", "gpt-5", "prompt")).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED", quotaScope: "account" });
    expect(classifyQuotaScope("insufficient_quota")).toBe("account");
  });

  it("honours a Retry-After header", async () => {
    vi.stubGlobal("fetch", respond(429, { error: { message: "Rate limit reached for requests per minute" } }, { "retry-after": "12" }));
    await expect(generateLiveStructured("openai", "sk-test", "gpt-4o-mini", "prompt")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterMs: 12_000, quotaScope: "minute" });
  });

  it("a model with no free allowance at all (limit: 0) is benched for a day when Google gives no delay", async () => {
    vi.stubGlobal("fetch", respond(429, { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro-preview" } }));
    await expect(generateLiveStructured("gemini", "key", "gemini-3.1-pro-preview", "prompt")).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED", retryAfterMs: 24 * 60 * 60_000 });
  });

  it("an Interactions-only model is a capability problem (never retried as a payload error)", async () => {
    vi.stubGlobal("fetch", respond(400, { error: { status: "INVALID_ARGUMENT", message: "This model only supports Interactions API." } }));
    await expect(generateLiveStructured("gemini", "key", "antigravity-preview-latest", "prompt")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
  });

  it("quotaDetail turns Google RPC details into a short suffix (no message text, no secret)", () => {
    expect(quotaDetail(geminiDailyModelQuota.error)).toBe(' [quota=GenerateRequestsPerDayPerProjectPerModel-FreeTier model=gemini-2.5-flash quotaValue="20"; retryDelay: "79586s"]');
    expect(quotaDetail({ message: "x" })).toBe("");
  });
});

describe("script-capable model routing", () => {
  it("drops models that cannot serve generateContent / chat before ranking", () => {
    for (const id of ["antigravity-preview-latest", "deep-research-preview-04-2026", "gemini-3-pro-image", "nano-banana-pro-preview", "lyria-3.5", "gemini-robotics-er-2-preview", "gemini-2.5-computer-use-preview-10-2025", "gemini-3.1-pro-preview-customtools", "gemini-omni-flash-preview", "text-embedding-3-small"]) {
      expect(isScriptCapableModel("gemini", id)).toBe(false);
    }
    for (const id of ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-flash-latest", "gpt-4o-mini"]) expect(isScriptCapableModel("gemini", id)).toBe(true);
  });

  it("ranks curated script models first and never returns an incapable one", () => {
    const ranked = rankContentModels("gemini", ["antigravity-preview-latest", "gemma-4-31b-it", "gemini-3.5-flash", "deep-research-max-preview-04-2026", "gemini-2.5-flash", "gemini-3.1-pro-preview", "lyria-3.5"]);
    expect(ranked).toEqual(["gemini-3.1-pro-preview", "gemini-2.5-flash", "gemini-3.5-flash", "gemma-4-31b-it"]);
  });
});
