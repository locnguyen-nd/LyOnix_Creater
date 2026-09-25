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
  let prisma: any;
  let sourcesService: SourcesService;
  let service: ScriptGenerationService;

  let providerAccounts: { markModelUnusable: ReturnType<typeof vi.fn>; repinModel: ReturnType<typeof vi.fn> };

  const draftBody = (title = "Messi") => JSON.stringify({
    output_text: JSON.stringify({ schemaVersion: "script-draft.v2", language: "vi", title, hook: "Messi la ai", body: "Messi la cau thu bong da noi tieng", cta: "Theo doi", caption: "#messi", scenes: draftScenes }),
  });

  beforeEach(() => {
    prisma = { providerAccount: { findFirst: async () => accountRow() } };
    sourcesService = { getRowForGeneration: async () => sourceRow() } as unknown as SourcesService;
    providerAccounts = { markModelUnusable: vi.fn(async () => undefined), repinModel: vi.fn(async () => undefined) };
    service = new ScriptGenerationService(prisma, sourcesService, providerAccounts as any);
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
    prisma.providerAccount.findFirst = async () => accountRow({ status: "unverified" });
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("fails fast with PROVIDER_NOT_CONFIGURED when the account does not exist", async () => {
    prisma.providerAccount.findFirst = async () => null;
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "missing" });
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("returns INVALID_STATE for an article_url source that has not been extracted yet", async () => {
    sourcesService = { getRowForGeneration: async () => sourceRow({ type: "article_url", extractedText: null, originRef: "https://example.com/a" }) } as unknown as SourcesService;
    service = new ScriptGenerationService(prisma, sourcesService, providerAccounts as any);
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });
    expect(outcome).toMatchObject({ ok: false, code: "INVALID_STATE" });
  });

  it("normalizes a provider auth failure without ever returning a fake draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_AUTH_INVALID" });
  });

  it("rotates to the next available model when the pinned model is out of quota, and re-pins the account to the model that worked", async () => {
    prisma.providerAccount.findFirst = async () => accountRow({ availableModels: ["gpt-4o-mini", "gpt-4o"] });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "You have exceeded your current quota exceeded" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(draftBody(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ ok: true });
    if (outcome && outcome !== "forbidden" && outcome.ok) {
      expect(outcome.response.providerPin.modelId).toBe("gpt-4o");
    }
    expect(providerAccounts.repinModel).toHaveBeenCalledWith("account-1", "gpt-4o");
  });

  it("returns PROVIDER_QUOTA_EXHAUSTED once every available model for the account is out of quota", async () => {
    prisma.providerAccount.findFirst = async () => accountRow({ availableModels: ["gpt-4o-mini", "gpt-4o"] });
    const quotaResponse = () => new Response(JSON.stringify({ error: { message: "quota exceeded for this project" } }), { status: 429 });
    const fetchMock = vi.fn().mockResolvedValueOnce(quotaResponse()).mockResolvedValueOnce(quotaResponse());
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_QUOTA_EXHAUSTED", status: 429 });
    expect(providerAccounts.repinModel).not.toHaveBeenCalled();
  });

  it("does not burn the rest of the candidate list on an account-wide auth failure", async () => {
    prisma.providerAccount.findFirst = async () => accountRow({ availableModels: ["gpt-4o-mini", "gpt-4o"] });
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_AUTH_INVALID" });
  });

  it("hides an inaccessible source as not-found (forbidden)", async () => {
    sourcesService = { getRowForGeneration: async () => "forbidden" as const } as unknown as SourcesService;
    service = new ScriptGenerationService(prisma, sourcesService, providerAccounts as any);
    expect(await service.generate("source-1", "user-1", "staff", { providerAccountId: "account-1" })).toBe("forbidden");
  });
});
