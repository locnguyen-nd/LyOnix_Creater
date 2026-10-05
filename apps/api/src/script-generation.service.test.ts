import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptGenerationService } from "./script-generation.service.js";
import { SourcesService } from "./sources.service.js";
import * as secretCrypto from "./secret-crypto.js";

const projectId = "project-1";
const sourceRow = (overrides: Record<string, unknown> = {}) => ({
  id: "source-1",
  projectId,
  type: "topic",
  extractedText: "Messi",
  rawText: null,
  originRef: null,
  ...overrides,
});

const accountRow = (overrides: Record<string, unknown> = {}) => ({
  id: "account-1",
  provider: "openai",
  role: "content",
  status: "verified",
  model: "gpt-4o-mini",
  availableModels: ["gpt-4o-mini"],
  encryptedSecret: "encrypted",
  configVersion: 2,
  isFake: false,
  deletedAt: null,
  ...overrides,
});

const draftScenes = [
  { sceneId: "s01", narration: "Messi la cau thu bong da", screenText: "Messi", visualQuery: "soccer player", durationHintMs: 15_000 },
  { sceneId: "s02", narration: "Anh choi cho Inter Miami", screenText: "Inter Miami", visualQuery: "stadium crowd", durationHintMs: 15_000 },
  { sceneId: "s03", narration: "Theo doi de biet them", screenText: "Theo doi", visualQuery: "follow button", durationHintMs: 15_000 },
];

describe("ScriptGenerationService.generate", () => {
  let sourcesService: SourcesService;
  let service: ScriptGenerationService;

  let providerAccounts: {
    contentGenerationCandidates: ReturnType<typeof vi.fn>;
    acquireContentRequestSlot: ReturnType<typeof vi.fn>;
    releaseContentRequestSlot: ReturnType<typeof vi.fn>;
    cooldownContentAccount: ReturnType<typeof vi.fn>;
    getModelAvailability: ReturnType<typeof vi.fn>;
    markModelLimited: ReturnType<typeof vi.fn>;
    markModelUnusable: ReturnType<typeof vi.fn>;
    repinModel: ReturnType<typeof vi.fn>;
  };

  const draftBody = (title = "Messi") => JSON.stringify({
    output_text: JSON.stringify({ schemaVersion: "script-draft.v2", language: "vi", title, hook: "Messi la ai", body: "Messi la cau thu bong da noi tieng", cta: "Theo doi", caption: "#messi", scenes: draftScenes }),
  });

  beforeEach(() => {
    sourcesService = { getRowForGeneration: async () => sourceRow() } as unknown as SourcesService;
    providerAccounts = {
      contentGenerationCandidates: vi.fn(async () => [accountRow()]),
      acquireContentRequestSlot: vi.fn(async () => true),
      releaseContentRequestSlot: vi.fn(async () => undefined),
      cooldownContentAccount: vi.fn(async () => undefined),
      getModelAvailability: vi.fn(async () => ({ available: true, retryAt: null })),
      markModelLimited: vi.fn(async () => new Date(Date.now() + 60_000)),
      markModelUnusable: vi.fn(async () => undefined),
      repinModel: vi.fn(async () => undefined),
    };
    service = new ScriptGenerationService(sourcesService, providerAccounts as any);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("sk-test");
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns a pinned ScriptDraftV2 when the account is verified and the call succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({ schemaVersion: "script-draft.v2", language: "vi", title: "Messi", hook: "Messi la ai", body: "Messi la cau thu bong da noi tieng", cta: "Theo doi", caption: "#messi", scenes: draftScenes }),
    }), { status: 200 })));
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });
    expect(outcome).toMatchObject({ ok: true });
    if (outcome && outcome !== "forbidden" && outcome.ok) {
      expect(outcome.response.providerPin).toMatchObject({ accountId: "account-1", provider: "openai", modelId: "gpt-4o-mini", configVersion: 2 });
      expect(outcome.response.draft.scenes).toHaveLength(3);
    }
  });

  it("fails fast with PROVIDER_NOT_CONFIGURED when the account is unverified", async () => {
    providerAccounts.contentGenerationCandidates.mockResolvedValue([]);
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("fails fast with PROVIDER_NOT_CONFIGURED when the account does not exist", async () => {
    providerAccounts.contentGenerationCandidates.mockResolvedValue([]);
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "missing" });
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("returns INVALID_STATE for an article_url source that has not been extracted yet", async () => {
    sourcesService = { getRowForGeneration: async () => sourceRow({ type: "article_url", extractedText: null, originRef: "https://example.com/a" }) } as unknown as SourcesService;
    service = new ScriptGenerationService(sourcesService, providerAccounts as any);
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });
    expect(outcome).toMatchObject({ ok: false, code: "INVALID_STATE" });
  });

  it("normalizes a provider auth failure without ever returning a fake draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_AUTH_INVALID" });
  });

  it("does not call another model on the same account after account-wide quota exhaustion", async () => {
    providerAccounts.contentGenerationCandidates.mockResolvedValue([accountRow({ availableModels: ["gpt-4o-mini", "gpt-4o"] })]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "You have exceeded your current quota exceeded" } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_QUOTA_EXHAUSTED", status: 429 });
    expect(providerAccounts.repinModel).not.toHaveBeenCalled();
    expect(providerAccounts.cooldownContentAccount).toHaveBeenCalledWith("account-1", 15 * 60_000);
  });

  it("returns PROVIDER_QUOTA_EXHAUSTED once every available model for the account is out of quota", async () => {
    providerAccounts.contentGenerationCandidates.mockResolvedValue([accountRow({ availableModels: ["gpt-4o-mini", "gpt-4o"] })]);
    const quotaResponse = () => new Response(JSON.stringify({ error: { message: "model quota exceeded per day" } }), { status: 429 });
    const fetchMock = vi.fn().mockResolvedValueOnce(quotaResponse()).mockResolvedValueOnce(quotaResponse());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_QUOTA_EXHAUSTED", status: 429 });
    if (outcome && outcome !== "forbidden" && !outcome.ok) expect(outcome.message).toContain("gpt-4o");
    expect(providerAccounts.repinModel).not.toHaveBeenCalled();
    expect(providerAccounts.cooldownContentAccount).not.toHaveBeenCalled();
    expect(providerAccounts.markModelLimited).toHaveBeenCalledTimes(2);
  });

  it("treats a 402 (balance cannot afford this model) as model-level: benches that model and tries a cheaper one without cooling the key", async () => {
    providerAccounts.contentGenerationCandidates.mockResolvedValue([accountRow({ availableModels: ["gpt-4o-mini", "gpt-4o"] })]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "You requested up to 8192 tokens, but can only afford 4000." } }), { status: 402 }))
      .mockResolvedValueOnce(new Response(draftBody(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });
    expect(outcome).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(providerAccounts.markModelLimited).toHaveBeenCalledWith("account-1", "gpt-4o-mini", expect.any(Number), "PROVIDER_QUOTA_EXHAUSTED");
    expect(providerAccounts.cooldownContentAccount).not.toHaveBeenCalled();
  });

  it("tries the next model on the same key after a model-level 429", async () => {
    providerAccounts.contentGenerationCandidates.mockResolvedValue([accountRow({ availableModels: ["gpt-4o-mini", "gpt-4o"] })]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limit per minute" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(draftBody(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });
    expect(outcome).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(providerAccounts.markModelLimited).toHaveBeenCalledWith("account-1", "gpt-4o-mini", expect.any(Number), expect.any(String));
    expect(providerAccounts.cooldownContentAccount).not.toHaveBeenCalled();
  });

  it("does not burn the rest of the candidate list on an account-wide auth failure", async () => {
    providerAccounts.contentGenerationCandidates.mockResolvedValue([accountRow({ availableModels: ["gpt-4o-mini", "gpt-4o"] })]);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_AUTH_INVALID" });
  });

  it("may advance after an explicit model-retired error", async () => {
    providerAccounts.contentGenerationCandidates.mockResolvedValue([accountRow({ availableModels: ["gpt-4o-mini", "gpt-4o"] })]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "This model is no longer available" } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(draftBody(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ ok: true });
    if (outcome && outcome !== "forbidden" && outcome.ok) expect(outcome.response.providerPin.modelId).toBe("gpt-4o");
    expect(providerAccounts.repinModel).toHaveBeenCalledWith("account-1", "gpt-4o");
  });

  it("fails over after account-wide quota and pins the account actually used", async () => {
    providerAccounts.contentGenerationCandidates.mockResolvedValue([
      accountRow({ id: "account-1", availableModels: ["gpt-4o-mini", "gpt-4o"] }),
      accountRow({ id: "account-2", provider: "openai", model: "gpt-5-mini", availableModels: ["gpt-5-mini"] }),
    ]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(draftBody(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await service.generate("source-1", "user-1", "staff", {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(providerAccounts.cooldownContentAccount).toHaveBeenCalledWith("account-1", 15 * 60_000);
    expect(providerAccounts.acquireContentRequestSlot).toHaveBeenNthCalledWith(1, "account-1");
    expect(providerAccounts.acquireContentRequestSlot).toHaveBeenNthCalledWith(2, "account-2");
    expect(outcome).toMatchObject({ ok: true });
    if (outcome && outcome !== "forbidden" && outcome.ok) {
      expect(outcome.response.providerPin).toMatchObject({ accountId: "account-2", selectionReason: "automatic_preference", rankingVersion: expect.any(String), usage: { costAmount: null, costCurrency: null } });
    }
  });

  it("hides an inaccessible source as not-found (forbidden)", async () => {
    sourcesService = { getRowForGeneration: async () => "forbidden" as const } as unknown as SourcesService;
    service = new ScriptGenerationService(sourcesService, providerAccounts as any);
    expect(await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" })).toBe("forbidden");
  });
});

describe("ScriptGenerationService.extractSegmentKeywords (VE2E-50)", () => {
  let service: ScriptGenerationService;
  let providerAccounts: Record<string, ReturnType<typeof vi.fn>>;
  const segments = [{ segmentId: "seg-1", narration: "新宿の夜景です。" }, { segmentId: "seg-2", narration: "渋谷の交差点です。" }];

  beforeEach(() => {
    providerAccounts = {
      contentGenerationCandidates: vi.fn(async () => [accountRow()]),
      acquireContentRequestSlot: vi.fn(async () => true),
      releaseContentRequestSlot: vi.fn(async () => undefined),
      cooldownContentAccount: vi.fn(async () => undefined),
      getModelAvailability: vi.fn(async () => ({ available: true, retryAt: null })),
      markModelLimited: vi.fn(async () => new Date(Date.now() + 60_000)),
      markModelUnusable: vi.fn(async () => undefined),
    };
    service = new ScriptGenerationService({} as unknown as SourcesService, providerAccounts as any);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("sk-test");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("makes one call for all segments and returns validated keywords with usage", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({ segments: [{ segmentId: "seg-1", ja: "新宿 夜景", en: "shinjuku night" }, { segmentId: "seg-2", ja: "crossing", en: "shibuya crossing" }] }),
      usage: { input_tokens: 120, output_tokens: 25 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await service.extractSegmentKeywords("user-1", "staff", { providerAccountId: "account-1", language: "ja", segments });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true, keywords: { "seg-1": { ja: "新宿 夜景", en: "shinjuku night" } }, rejectedSegmentIds: ["seg-2"], usage: { inputTokens: 120, outputTokens: 25 }, provider: "openai" });
    expect(providerAccounts.releaseContentRequestSlot).toHaveBeenCalledWith("account-1");
  });

  it("returns a failure outcome (never throws) when the provider is rate limited, and cools the model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "rate limit per minute" } }), { status: 429 })));
    const outcome = await service.extractSegmentKeywords("user-1", "staff", { providerAccountId: "account-1", language: "ja", segments });
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_RATE_LIMITED" });
    expect(providerAccounts.markModelLimited).toHaveBeenCalled();
    expect(providerAccounts.cooldownContentAccount).not.toHaveBeenCalled();
  });

  it("rotates to another content account (different provider) when the first one is auth-invalid, and reports the account used", async () => {
    providerAccounts.contentGenerationCandidates = vi.fn(async () => [
      accountRow({ id: "account-1" }),
      accountRow({ id: "account-2", provider: "openai", model: "gpt-5-mini", availableModels: ["gpt-5-mini"] }),
    ]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output_text: JSON.stringify({ segments: [{ segmentId: "seg-1", ja: "新宿 夜景", en: "shinjuku night" }] }),
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await service.extractSegmentKeywords("user-1", "staff", { providerAccountId: "account-1", language: "ja", segments });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ ok: true, providerAccountId: "account-2" });
    expect(providerAccounts.cooldownContentAccount).toHaveBeenCalledWith("account-1", expect.any(Number));
  });

  it("fails with the last error once every content account has failed", async () => {
    providerAccounts.contentGenerationCandidates = vi.fn(async () => [accountRow({ id: "account-1" }), accountRow({ id: "account-2" })]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await service.extractSegmentKeywords("user-1", "staff", { providerAccountId: "account-1", language: "ja", segments });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_AUTH_INVALID" });
  });

  it("fails without a call when the content account is unavailable or the request is empty", async () => {
    providerAccounts.contentGenerationCandidates = vi.fn(async () => []);
    expect(await service.extractSegmentKeywords("user-1", "staff", { providerAccountId: "account-1", language: "ja", segments })).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    expect(await service.extractSegmentKeywords("user-1", "staff", { providerAccountId: "account-1", language: "ja", segments: [] })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });
});
