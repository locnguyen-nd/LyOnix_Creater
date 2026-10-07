import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ProviderError, type rewriteSourceAsScript } from "@lyonix/providers";
import { IntakeRewriteService, REWRITE_MAX_OVERLAP } from "./intake-rewrite.service.js";
import { encryptSecret } from "./secret-crypto.js";

let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env.PERSISTENCE_ENCRYPTION_KEY;
  process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.PERSISTENCE_ENCRYPTION_KEY;
  else process.env.PERSISTENCE_ENCRYPTION_KEY = previousKey;
});

const SOURCE = "The old river bridge reopened on Monday after eight months of repairs costing 12 million dollars. Engineers replaced the deck and strengthened the supports.";
const account = (id: string, over: Record<string, unknown> = {}) => ({ id, role: "content", provider: "openai", status: "verified", isFake: false, model: "gpt-4.1-mini", availableModels: ["gpt-4.1-mini"], preferredModels: [], modelSnapshot: [], get encryptedSecret() { return encryptSecret("sk-test"); }, ...over });

const setup = (candidates: ReturnType<typeof account>[], rewrite: typeof rewriteSourceAsScript) => {
  const accounts = {
    contentGenerationCandidates: vi.fn(async (_u: string, _r: string, preferred?: string) => (preferred ? [...candidates.filter((a) => a.id === preferred), ...candidates.filter((a) => a.id !== preferred)] : candidates)),
    acquireContentRequestSlot: vi.fn(async () => true),
    releaseContentRequestSlot: vi.fn(async () => undefined),
    cooldownContentAccount: vi.fn(async () => undefined),
    markModelUnusable: vi.fn(async () => undefined),
    markModelLimited: vi.fn(async () => new Date()),
    getModelAvailability: vi.fn(async () => ({ available: true, retryAt: null })),
  };
  return { service: new IntakeRewriteService(accounts as never, { rewrite }), accounts };
};
const request = { source: { sourceType: "article" as const, sourceUrl: "https://example.com/a", title: "Bridge", sourceName: "Example News", cleanedText: SOURCE }, language: "en" as const, durationSec: 45 };

describe("VE2E-96 source rewrite", () => {
  it("writes an original script with the form's account, in the form's language and length", async () => {
    const rewrite = vi.fn<typeof rewriteSourceAsScript>(async (_kind, _key, modelId) => ({ hook: "Big trucks are back!", script: "Big trucks are back! After eight months and 12 million dollars, the river bridge is open again.", language: "en", modelId }));
    const { service, accounts } = setup([account("a1"), account("a2")], rewrite);
    const result = await service.rewrite("u1", "staff", { ...request, contentAccountId: "a2" });
    expect(result).toMatchObject({ status: "done", hook: "Big trucks are back!", providerUsed: "openai/gpt-4.1-mini", overlapHigh: false });
    expect(result.status === "done" && result.overlapRatio).toBeLessThan(REWRITE_MAX_OVERLAP);
    expect(accounts.contentGenerationCandidates).toHaveBeenCalledWith("u1", "staff", "a2");
    // the source is 156 characters: the 45 s asked for is capped to what it can fill (156 x 1.5 / 15 cps = 16 s) - a thin source is never padded
    expect(rewrite.mock.calls[0]![3]).toMatchObject({ targetLanguage: "en", targetSeconds: 16, text: SOURCE, sourceName: "Example News" });
  });

  it("a draft that copies the source is rewritten once more; the less copied one wins and the closeness is reported", async () => {
    const rewrite = vi.fn<typeof rewriteSourceAsScript>()
      .mockResolvedValueOnce({ hook: "x", script: SOURCE, language: "en", modelId: "m" })
      .mockResolvedValueOnce({ hook: "Trucks rejoice", script: "Trucks rejoice: the river bridge is open again after a 12 million dollar fix that took eight months.", language: "en", modelId: "m" });
    const { service } = setup([account("a1")], rewrite);
    const result = await service.rewrite("u1", "staff", request);
    expect(rewrite).toHaveBeenCalledTimes(2);
    expect(rewrite.mock.calls[1]![3]).toMatchObject({ tooCloseFeedback: true });
    expect(result).toMatchObject({ status: "done", hook: "Trucks rejoice", overlapHigh: false });
    const stubborn = vi.fn<typeof rewriteSourceAsScript>(async () => ({ hook: "x", script: SOURCE, language: "en", modelId: "m" }));
    expect(await setup([account("a1")], stubborn).service.rewrite("u1", "staff", request)).toMatchObject({ status: "done", overlapHigh: true, overlapRatio: 1 });
  });

  it("a long source keeps the length the form asks for", async () => {
    const rewrite = vi.fn<typeof rewriteSourceAsScript>(async () => ({ hook: "h", script: "A brand new script about the bridge.", language: "en", modelId: "m" }));
    await setup([account("a1")], rewrite).service.rewrite("u1", "staff", { ...request, source: { ...request.source, cleanedText: SOURCE.repeat(8) } });
    expect(rewrite.mock.calls[0]![3]).toMatchObject({ targetSeconds: 45 });
  });

  it("no usable content account: skipped (the form can still use the analysed text)", async () => {
    const rewrite = vi.fn<typeof rewriteSourceAsScript>();
    expect(await setup([], rewrite).service.rewrite("u1", "staff", request)).toEqual({ status: "skipped", reason: "no_content_account" });
    expect(await setup([account("a1", { status: "invalid" })], rewrite).service.rewrite("u1", "staff", request)).toEqual({ status: "skipped", reason: "no_content_account" });
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("provider errors: failed with the code; an account the user may not use is refused", async () => {
    const denied = vi.fn<typeof rewriteSourceAsScript>(async () => { throw new ProviderError("PROVIDER_AUTH_INVALID", "bad key", false); });
    expect(await setup([account("a1")], denied).service.rewrite("u1", "staff", request)).toMatchObject({ status: "failed", code: "PROVIDER_AUTH_INVALID" });
    expect(await setup([account("a1")], denied).service.rewrite("u1", "staff", { ...request, contentAccountId: "someone-else" })).toMatchObject({ status: "failed", code: "PROVIDER_NOT_CONFIGURED" });
    expect(await setup([account("a1")], denied).service.rewrite("u1", "staff", { ...request, source: { ...request.source, cleanedText: "  " } })).toMatchObject({ status: "failed", code: "VALIDATION_FAILED" });
  });
});
