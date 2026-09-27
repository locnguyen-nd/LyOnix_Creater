import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { encryptSecret } from "./secret-crypto.js";

const originalEncryptionKey = process.env.PERSISTENCE_ENCRYPTION_KEY;

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "account-1", name: "OpenAI primary", provider: "openai", role: "content", scope: "personal",
  ownerUserId: "user-1", status: "verified", model: "gpt-4o-mini", availableModels: ["gpt-4o-mini"],
  encryptedSecret: "encrypted", isFake: false, version: 3, configVersion: 1, deletedAt: null,
  ...overrides,
});

describe("ProviderAccountsService content admission", () => {
  it("restricts candidates to accounts visible to the actor and honors an explicit account preference", async () => {
    const visible = [
      row({ id: "org", scope: "organization", ownerUserId: null }),
      row({ id: "own", scope: "personal", ownerUserId: "staff-1" }),
    ];
    const findMany = vi.fn(async () => visible);
    const service = new ProviderAccountsService({ providerAccount: { findMany } } as any);

    const candidates = await service.contentGenerationCandidates("staff-1", "staff", "org");

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ role: "content", status: "verified", OR: expect.any(Array) }) }));
    expect(candidates.map((candidate) => candidate.id)).toEqual(["org", "own"]);
  });

  it("uses atomic admission, decrements on release, and persists bounded retry-after cooldown", async () => {
    const updateMany = vi.fn(async (_args?: any) => ({ count: 1 }));
    const service = new ProviderAccountsService({ providerAccount: { updateMany } } as any);
    const now = new Date("2026-09-26T10:00:00.000Z");

    expect(await service.acquireContentRequestSlot("account-1", now, 4)).toBe(true);
    await service.releaseContentRequestSlot("account-1");
    const cooldown = await service.cooldownContentAccount("account-1", 5_000, now);

    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ where: { activeContentRequests: { lt: 4 }, OR: expect.any(Array) }, data: { activeContentRequests: { increment: 1 } } });
    expect(updateMany.mock.calls[1]?.[0]).toMatchObject({ data: { activeContentRequests: { decrement: 1 } } });
    expect(cooldown).toEqual(new Date("2026-09-26T10:00:05.000Z"));
  });
});

describe("ProviderAccountsService lifecycle", () => {
  let store: any;
  let prisma: any;
  let service: ProviderAccountsService;

  beforeEach(() => {
    store = row();
    prisma = {
      providerAccount: {
        findFirst: async ({ where }: any) => where.id === store.id && store.deletedAt === null ? store : null,
        findUnique: async () => store,
        updateMany: async ({ where, data }: any) => {
          if (where.version !== store.version || store.deletedAt !== null) return { count: 0 };
          const { version, ...changes } = data;
          Object.assign(store, changes);
          if (version?.increment) store.version += version.increment;
          return { count: 1 };
        },
      },
    };
    service = new ProviderAccountsService(prisma);
  });

  it("updates an owned account only when If-Match version is current", async () => {
    const updated = await service.update("account-1", "user-1", "staff", 3, { name: "OpenAI fallback", model: "gpt-4o-mini" });
    expect(updated).toMatchObject({ name: "OpenAI fallback", version: 4 });
    expect(await service.update("account-1", "user-1", "staff", 3, { name: "stale" })).toBe("conflict");
  });

  it("does not let staff alter a shared organization account", async () => {
    store = row({ scope: "organization", ownerUserId: null });
    expect(await service.update("account-1", "user-1", "staff", 3, { name: "nope" })).toBe("forbidden");
  });

  it("soft-deletes an account so a pinned historical config is retained", async () => {
    expect(await service.remove("account-1", "user-1", "staff", 3)).toBe(true);
    expect(store.deletedAt).toBeInstanceOf(Date);
    expect(store.version).toBe(4);
  });
});

describe("ProviderAccountsService ElevenLabs (tts) account", () => {
  let store: any;
  let prisma: any;
  let service: ProviderAccountsService;

  beforeEach(() => {
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    store = null;
    prisma = {
      providerAccount: {
        create: async ({ data }: any) => { store = { id: "el-1", version: 1, configVersion: 1, isFake: false, deletedAt: null, ownerUserId: "user-1", ...data }; return store; },
        findFirst: async ({ where }: any) => (store && where.id === store.id && store.deletedAt === null ? store : null),
        update: async ({ data }: any) => { Object.assign(store, data); if (data.version?.increment) store.version += data.version.increment; return store; },
      },
    };
    service = new ProviderAccountsService(prisma);
  });

  afterEach(() => { vi.unstubAllGlobals(); process.env.PERSISTENCE_ENCRYPTION_KEY = originalEncryptionKey; });

  it("creates an elevenlabs/tts account with the curated model list, rejects other tts providers", async () => {
    const created = await service.create({ name: "Studio voice", provider: "elevenlabs", role: "tts", scope: "personal", model: "eleven_multilingual_v2", secret: "sk_test" }, "user-1", "staff");
    expect(created).toMatchObject({ provider: "elevenlabs", role: "tts", status: "unverified" });
    expect((created as any).availableModels).toContain("eleven_multilingual_v2");
    expect(await service.create({ name: "Omni", provider: "omni", role: "tts", scope: "personal", model: "x", secret: "y" }, "user-1", "staff")).toBe("unsupported");
    expect(await service.create({ name: "OpenAI as tts", provider: "openai", role: "tts", scope: "personal", model: "x", secret: "y" }, "user-1", "staff")).toBe("unsupported");
  });

  it("verifies a real ElevenLabs key via GET /v1/user without a billed TTS call", async () => {
    await service.create({ name: "Studio voice", provider: "elevenlabs", role: "tts", scope: "personal", model: "eleven_multilingual_v2", secret: "sk_test" }, "user-1", "staff");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ subscription: { tier: "starter", can_use_instant_voice_cloning: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const verified = await service.verify("el-1", "user-1", "staff");
    expect(verified).toMatchObject({ status: "verified" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])).toContain("/v1/user");
  });

  it("marks the account failed (not silently fake) when the ElevenLabs key is rejected", async () => {
    await service.create({ name: "Studio voice", provider: "elevenlabs", role: "tts", scope: "personal", model: "eleven_multilingual_v2", secret: "bad" }, "user-1", "staff");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { status: "invalid_api_key" } }), { status: 401 })));
    const result = await service.verify("el-1", "user-1", "staff");
    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(store.status).toBe("failed");
  });
});

describe("ProviderAccountsService OpenAI (content) account — V00-10 model eligibility + freshness", () => {
  let store: any;
  let prisma: any;
  let service: ProviderAccountsService;

  const okResponses = () => new Response(JSON.stringify({ output_text: JSON.stringify({ ok: true }) }), { status: 200 });

  beforeEach(() => {
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    store = row({ id: "oa-1", availableModels: [], modelSnapshot: null, encryptedSecret: encryptSecret("sk-test") });
    prisma = {
      providerAccount: {
        findFirst: async ({ where }: any) => (store && where.id === store.id && store.deletedAt === null ? store : null),
        findUnique: async () => store,
        update: async ({ data }: any) => { Object.assign(store, data); if (data.version?.increment) store.version += data.version.increment; return store; },
        updateMany: async ({ where, data }: any) => {
          if (where.version !== store.version || store.deletedAt !== null) return { count: 0 };
          const { version, ...changes } = data;
          Object.assign(store, changes);
          if (version?.increment) store.version += version.increment;
          return { count: 1 };
        },
      },
    };
    service = new ProviderAccountsService(prisma);
  });

  afterEach(() => { vi.unstubAllGlobals(); process.env.PERSISTENCE_ENCRYPTION_KEY = originalEncryptionKey; });

  it("verify() never trusts a listed model as usable - it must also pass a real bounded generate probe", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });
      return okResponses();
    });
    vi.stubGlobal("fetch", fetchMock);
    const verified = await service.verify("oa-1", "user-1", "staff");
    expect(verified).toMatchObject({ status: "verified", model: "gpt-4o-mini", availableModels: ["gpt-4o-mini"] });
    expect(store.modelSnapshot).toMatchObject([{ modelId: "gpt-4o-mini", status: "usable" }]);
    // one call for listing + one bounded real generate probe, never a static-catalog fallback
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("verify() does not treat a static catalog as account capability evidence", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/v1/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return okResponses();
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await service.verify("oa-1", "user-1", "staff");
    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(store.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("verify() makes one probe and does not scan the remaining listed models when the preference is retired", async () => {
    store = row({ id: "oa-1", model: "gpt-4o-mini", availableModels: [], modelSnapshot: null, encryptedSecret: encryptSecret("sk-test") });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }), { status: 200 });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.model === "gpt-4o-mini") return new Response(JSON.stringify({ error: { message: "This model is no longer available" } }), { status: 404 });
      return okResponses();
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await service.verify("oa-1", "user-1", "staff");
    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(store.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("verify() marks the account failed (not fake-verified) on zero-credit/quota-exhausted, never picking a model", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await service.verify("oa-1", "user-1", "staff");
    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(store.status).toBe("failed");
  });

  it("update() rejects switching to a model whose snapshot is missing/stale until a fresh reprobe succeeds", async () => {
    store = row({
      id: "oa-1", model: "gpt-4o-mini", availableModels: ["gpt-4o-mini", "gpt-4o"],
      modelSnapshot: [{ modelId: "gpt-4o-mini", status: "usable", checkedAt: new Date().toISOString(), source: "probed" }],
      encryptedSecret: encryptSecret("sk-test"),
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "This model is no longer available" } }), { status: 404 })));
    const rejected = await service.update("oa-1", "user-1", "staff", store.version, { model: "gpt-4o" });
    expect(rejected).toBe("model_unavailable");
  });

  it("update() accepts switching to an unverified-but-listed model once it passes a fresh reprobe, and persists the new snapshot entry", async () => {
    store = row({
      id: "oa-1", model: "gpt-4o-mini", availableModels: ["gpt-4o-mini", "gpt-4o"],
      modelSnapshot: [{ modelId: "gpt-4o-mini", status: "usable", checkedAt: new Date().toISOString(), source: "probed" }],
      encryptedSecret: encryptSecret("sk-test"),
    });
    vi.stubGlobal("fetch", vi.fn(async () => okResponses()));
    const updated = await service.update("oa-1", "user-1", "staff", store.version, { model: "gpt-4o" });
    expect(updated).toMatchObject({ model: "gpt-4o" });
    expect(store.modelSnapshot).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: "gpt-4o", status: "usable" })]));
  });

  it("update() does not spend a probe call when switching to a model that is already fresh+usable", async () => {
    const freshCheckedAt = new Date().toISOString();
    store = row({
      id: "oa-1", model: "gpt-4o-mini", availableModels: ["gpt-4o-mini", "gpt-4o"],
      modelSnapshot: [
        { modelId: "gpt-4o-mini", status: "usable", checkedAt: freshCheckedAt, source: "probed" },
        { modelId: "gpt-4o", status: "usable", checkedAt: freshCheckedAt, source: "probed" },
      ],
    });
    const fetchMock = vi.fn(async () => okResponses());
    vi.stubGlobal("fetch", fetchMock);
    const updated = await service.update("oa-1", "user-1", "staff", store.version, { model: "gpt-4o" });
    expect(updated).toMatchObject({ model: "gpt-4o" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("markModelUnusable() flips the pinned model to retired and drops it from availableModels, forcing explicit reselection", async () => {
    store = row({
      id: "oa-1", model: "gpt-4o-mini", availableModels: ["gpt-4o-mini", "gpt-4o"],
      modelSnapshot: [{ modelId: "gpt-4o-mini", status: "usable", checkedAt: new Date().toISOString(), source: "probed" }],
    });
    await service.markModelUnusable("oa-1", "gpt-4o-mini", "Model is no longer available");
    expect(store.availableModels).not.toContain("gpt-4o-mini");
    expect(store.modelSnapshot).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: "gpt-4o-mini", status: "retired" })]));
  });
});

describe("ProviderAccountsService Pexels (visual) account", () => {
  let store: any;
  let prisma: any;
  let service: ProviderAccountsService;

  beforeEach(() => {
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    store = null;
    prisma = {
      providerAccount: {
        create: async ({ data }: any) => { store = { id: "px-1", version: 1, configVersion: 1, isFake: false, deletedAt: null, ownerUserId: "user-1", ...data }; return store; },
        findFirst: async ({ where }: any) => (store && where.id === store.id && store.deletedAt === null ? store : null),
        update: async ({ data }: any) => { Object.assign(store, data); if (data.version?.increment) store.version += data.version.increment; return store; },
      },
    };
    service = new ProviderAccountsService(prisma);
  });

  afterEach(() => { vi.unstubAllGlobals(); process.env.PERSISTENCE_ENCRYPTION_KEY = originalEncryptionKey; });

  it("creates a pexels/visual account, rejects pexels with a different role", async () => {
    const created = await service.create({ name: "Stock media", provider: "pexels", role: "visual", scope: "personal", model: "default", secret: "px_test" }, "user-1", "staff");
    expect(created).toMatchObject({ provider: "pexels", role: "visual", status: "unverified" });
    expect(await service.create({ name: "Pexels as content", provider: "pexels", role: "content", scope: "personal", model: "x", secret: "y" }, "user-1", "staff")).toBe("unsupported");
  });

  it("verifies a real Pexels key via the cheap curated-list probe", async () => {
    await service.create({ name: "Stock media", provider: "pexels", role: "visual", scope: "personal", model: "default", secret: "px_test" }, "user-1", "staff");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ photos: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const verified = await service.verify("px-1", "user-1", "staff");
    expect(verified).toMatchObject({ status: "verified" });
    expect(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0])).toContain("/v1/curated");
  });

  it("marks the account failed (not silently fake) when the Pexels key is rejected", async () => {
    await service.create({ name: "Stock media", provider: "pexels", role: "visual", scope: "personal", model: "default", secret: "bad" }, "user-1", "staff");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));
    const result = await service.verify("px-1", "user-1", "staff");
    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(store.status).toBe("failed");
  });
});

describe("ProviderAccountsService YouTube (visual, discovery/embed-only) account — VE2E-15b", () => {
  let store: any;
  let prisma: any;
  let service: ProviderAccountsService;

  beforeEach(() => {
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    store = null;
    prisma = {
      providerAccount: {
        create: async ({ data }: any) => { store = { id: "yt-1", version: 1, configVersion: 1, isFake: false, deletedAt: null, ownerUserId: "user-1", ...data }; return store; },
        findFirst: async ({ where }: any) => (store && where.id === store.id && store.deletedAt === null ? store : null),
        update: async ({ data }: any) => { Object.assign(store, data); if (data.version?.increment) store.version += data.version.increment; return store; },
      },
    };
    service = new ProviderAccountsService(prisma);
  });

  afterEach(() => { vi.unstubAllGlobals(); process.env.PERSISTENCE_ENCRYPTION_KEY = originalEncryptionKey; });

  it("creates a youtube/visual account, rejects youtube with a different role", async () => {
    const created = await service.create({ name: "YouTube discovery", provider: "youtube", role: "visual", scope: "personal", model: "default", secret: "yt_test" }, "user-1", "staff");
    expect(created).toMatchObject({ provider: "youtube", role: "visual", status: "unverified" });
    expect(await service.create({ name: "YouTube as content", provider: "youtube", role: "content", scope: "personal", model: "x", secret: "y" }, "user-1", "staff")).toBe("unsupported");
  });

  it("verifies a real YouTube key via the cheap videos.list(chart=mostPopular) probe, not the 100-unit search endpoint", async () => {
    await service.create({ name: "YouTube discovery", provider: "youtube", role: "visual", scope: "personal", model: "default", secret: "yt_test" }, "user-1", "staff");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const verified = await service.verify("yt-1", "user-1", "staff");
    expect(verified).toMatchObject({ status: "verified" });
    const calledUrl = String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0]);
    expect(calledUrl).toContain("/videos?part=id&chart=mostPopular");
    expect(calledUrl).not.toContain("/search");
  });

  it("marks the account failed (not silently fake) when the YouTube key is rejected", async () => {
    await service.create({ name: "YouTube discovery", provider: "youtube", role: "visual", scope: "personal", model: "default", secret: "bad" }, "user-1", "staff");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "API key invalid" } }), { status: 401 })));
    const result = await service.verify("yt-1", "user-1", "staff");
    expect(result).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(store.status).toBe("failed");
  });
});
