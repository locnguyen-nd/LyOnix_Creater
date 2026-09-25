import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderCapabilitiesService, publicBaseUrlConfigured } from "./provider-capabilities.service.js";
import * as secretCrypto from "./secret-crypto.js";

const accountRow = (overrides: Record<string, unknown> = {}) => ({
  id: "account-1",
  provider: "openai",
  role: "content",
  status: "verified",
  model: "gpt-model",
  isFake: false,
  deletedAt: null,
  encryptedSecret: "encrypted",
  scope: "organization",
  ownerUserId: null,
  ...overrides,
});

const profileRow = (overrides: Record<string, unknown> = {}) => ({
  id: "profile-1",
  projectId: null,
  createdByUserId: "user-1",
  contentConfig: { providerAccountId: "account-1" },
  voiceConfig: { providerAccountId: "account-2" },
  ...overrides,
});

describe("ProviderCapabilitiesService", () => {
  let prisma: any;
  let service: ProviderCapabilitiesService;
  let grants: any;
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

  beforeEach(() => {
    process.env.PUBLIC_BASE_URL = "https://demo.lyonix.local";
    prisma = {
      automationProfileVersion: { findUnique: vi.fn(async () => profileRow()) },
      providerAccount: {
        findFirst: vi.fn(async ({ where }: any) => {
          if (where.id === "account-1") return accountRow({ id: "account-1", provider: "openai", role: "content" });
          if (where.id === "account-2") return accountRow({ id: "account-2", provider: "elevenlabs", role: "tts", model: "eleven_v3" });
          if (where.id === "account-pexels") return accountRow({ id: "account-pexels", provider: "pexels", role: "visual" });
          if (where.id === "account-creatomate") return accountRow({ id: "account-creatomate", provider: "creatomate", role: "render" });
          return null;
        }),
      },
    };
    grants = { forUser: vi.fn(async () => ({ projectIds: ["project-1"] })) };
    service = new ProviderCapabilitiesService(prisma, grants);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("secret-key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  it("returns null when the automation profile does not exist", async () => {
    prisma.automationProfileVersion.findUnique = vi.fn(async () => null);
    const result = await service.preflight("missing", "user-1", "staff");
    expect(result).toBeNull();
  });

  it("reports not_configured for content/tts when no account is pinned", async () => {
    prisma.automationProfileVersion.findUnique = vi.fn(async () => profileRow({ contentConfig: {}, voiceConfig: {} }));
    const result = await service.preflight("profile-1", "user-1", "staff");
    expect(result?.ready).toBe(false);
    expect(result?.operations.find((op) => op.operation === "generate_script")).toMatchObject({ status: "not_configured", code: "PROVIDER_NOT_CONFIGURED" });
    expect(result?.operations.find((op) => op.operation === "generate_voice")).toMatchObject({ status: "not_configured", code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("is ready shallow (no probe call) when accounts are verified and PUBLIC_BASE_URL is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await service.preflight("profile-1", "user-1", "staff");
    expect(result?.ready).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports capability_unavailable when a pinned account is unverified", async () => {
    prisma.providerAccount.findFirst = vi.fn(async ({ where }: any) =>
      where.id === "account-1" ? accountRow({ id: "account-1", status: "unverified" }) : accountRow({ id: "account-2", provider: "elevenlabs", role: "tts" }),
    );
    const result = await service.preflight("profile-1", "user-1", "staff");
    expect(result?.ready).toBe(false);
    expect(result?.operations.find((op) => op.operation === "generate_script")).toMatchObject({ status: "capability_unavailable", code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
  });

  it("does not report media_delivery ready without PUBLIC_BASE_URL", async () => {
    delete process.env.PUBLIC_BASE_URL;
    const result = await service.preflight("profile-1", "user-1", "staff");
    expect(result?.operations.find((op) => op.operation === "media_delivery")).toMatchObject({ status: "not_configured", code: "PROVIDER_NOT_CONFIGURED" });
  });

  describe("deep probe", () => {
    it("runs pickUsableContentModel for content and probeElevenLabsTts for tts when voiceId is provided", async () => {
      prisma.automationProfileVersion.findUnique = vi.fn(async () => profileRow({ voiceConfig: { providerAccountId: "account-2", voiceId: "voice-1" } }));
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ output_text: JSON.stringify({ ok: true }) }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await service.preflight("profile-1", "user-1", "staff", { deep: true });
      expect(fetchMock).toHaveBeenCalled();
      // one call for OpenAI generate probe; ElevenLabs TTS probe will fail against this stub response shape,
      // so it should surface as capability_unavailable rather than throwing out of preflight.
      expect(result?.operations.find((op) => op.operation === "generate_voice")?.status).toBe("capability_unavailable");
    });

    it("skips the deep TTS probe (stays ready) when no voiceId is pinned", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await service.preflight("profile-1", "user-1", "staff", { deep: true });
      // content probe still runs (openai/gemini/xai always has a model), tts probe is skipped without voiceId
      expect(result?.operations.find((op) => op.operation === "generate_voice")).toMatchObject({ status: "ready" });
    });

    it("surfaces a probe failure as capability_unavailable instead of throwing", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_api_key" }), { status: 401 })));
      const result = await service.preflight("profile-1", "user-1", "staff", { deep: true });
      expect(result?.ready).toBe(false);
      expect(result?.operations.find((op) => op.operation === "generate_script")).toMatchObject({ status: "capability_unavailable", code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    });
  });

  describe("explicit pexels/creatomate accounts", () => {
    it("adds no visual/render operation when no account id is passed", async () => {
      const result = await service.preflight("profile-1", "user-1", "staff");
      expect(result?.operations.find((op) => op.role === "visual")).toBeUndefined();
      expect(result?.operations.find((op) => op.role === "render" && op.operation === "render_submit")).toBeUndefined();
    });

    it("runs the live cheap Pexels/Creatomate probe when account ids are passed", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ photos: [] }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await service.preflight("profile-1", "user-1", "staff", { pexelsAccountId: "account-pexels", creatomateAccountId: "account-creatomate" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result?.operations.find((op) => op.operation === "media_search")).toMatchObject({ status: "ready" });
      expect(result?.operations.find((op) => op.operation === "render_submit")).toMatchObject({ status: "ready" });
    });

    it("rejects an account id that does not match the expected provider", async () => {
      const result = await service.preflight("profile-1", "user-1", "staff", { pexelsAccountId: "account-creatomate" });
      expect(result?.operations.find((op) => op.operation === "media_search")).toMatchObject({ status: "not_configured", code: "PROVIDER_NOT_CONFIGURED" });
    });
  });

  it("publicBaseUrlConfigured reflects the environment variable", () => {
    process.env.PUBLIC_BASE_URL = "https://x.example";
    expect(publicBaseUrlConfigured()).toBe(true);
    delete process.env.PUBLIC_BASE_URL;
    expect(publicBaseUrlConfigured()).toBe(false);
  });

  it("does not reveal a profile outside the caller's project grants", async () => {
    prisma.automationProfileVersion.findUnique = vi.fn(async () => profileRow({ projectId: "other-project" }));
    grants.forUser.mockResolvedValue({ projectIds: [] });
    const result = await service.preflight("profile-1", "user-1", "staff");
    expect(result).toBeNull();
    expect(prisma.providerAccount.findFirst).not.toHaveBeenCalled();
  });

  it("does not probe a personal provider account owned by another user", async () => {
    prisma.providerAccount.findFirst = vi.fn(async () => accountRow({ scope: "personal", ownerUserId: "other-user" }));
    const result = await service.preflight("profile-1", "user-1", "staff");
    expect(result?.operations.find((op) => op.operation === "generate_script")).toMatchObject({ status: "not_configured" });
  });
});
