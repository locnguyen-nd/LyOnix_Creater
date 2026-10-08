import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsVoiceService, VOICE_PREVIEW_CACHE, VOICE_PREVIEW_SAMPLES } from "./elevenlabs-voice.service.js";
import type { MediaAssetVersionSummary } from "@lyonix/contracts";
import { MediaService } from "./media.service.js";
import * as secretCrypto from "./secret-crypto.js";

const fakeAsset = { id: "asset-1", projectId: "project-1" } as unknown as MediaAssetVersionSummary;

const accountRow = (overrides: Record<string, unknown> = {}) => ({
  id: "account-1",
  provider: "elevenlabs",
  role: "tts",
  status: "verified",
  model: "eleven_multilingual_v2",
  encryptedSecret: "encrypted",
  isFake: false,
  deletedAt: null,
  ...overrides,
});

const consent = { statementVersion: "v1", statementText: "I confirm I have the legal right to clone this voice.", acceptedAt: "2026-09-24T00:00:00.000Z" };
const sampleFiles = [{ fileName: "sample.mp3", mimeType: "audio/mpeg", base64Data: Buffer.from("sample-bytes").toString("base64") }];

/** Minimal MP3 container (ID3 header) so `validateGeneratedAudio` sniffs it as `audio/mpeg`. */
const mp3Bytes = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 0)]);
const alignedTtsBody = {
  audio_base64: mp3Bytes.toString("base64"),
  alignment: { characters: ["h", "i"], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.3] },
};

describe("ElevenLabsVoiceService", () => {
  let mediaRootDir: string;
  let previousMediaRoot: string | undefined;
  let prisma: any;
  let media: Partial<MediaService>;
  let service: ElevenLabsVoiceService;

  beforeEach(async () => {
    mediaRootDir = await mkdtemp(join(tmpdir(), "lyonix-elevenlabs-"));
    previousMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = mediaRootDir;
    prisma = {
      providerAccount: { findFirst: async () => accountRow() },
      voiceCloneConsentRecord: {
        create: vi.fn(async (args: any) => ({ id: "consent-1", ...args.data })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    media = { registerAsset: vi.fn(async () => fakeAsset) };
    service = new ElevenLabsVoiceService(prisma, media as MediaService);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("sk-test");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (previousMediaRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = previousMediaRoot;
    await rm(mediaRootDir, { recursive: true, force: true });
  });

  describe("listVoices / getVoice", () => {
    it("lists voices for a verified elevenlabs/tts account", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        voices: [{ voice_id: "v1", name: "Alex", category: "cloned", preview_url: "https://cdn.elevenlabs.io/preview/v1.mp3" }],
      }), { status: 200 })));
      const outcome = await service.listVoices("account-1");
      expect(outcome).toMatchObject({ ok: true, data: [{ voiceId: "v1", name: "Alex" }] });
    });

    it("fails fast with PROVIDER_NOT_CONFIGURED when the account does not exist", async () => {
      prisma.providerAccount.findFirst = async () => null;
      const outcome = await service.listVoices("missing");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    });

    it("rejects an account that is not elevenlabs/tts", async () => {
      prisma.providerAccount.findFirst = async () => accountRow({ provider: "openai", role: "content" });
      const outcome = await service.listVoices("account-1");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    });

    it("fails fast with PROVIDER_NOT_CONFIGURED when the account is unverified", async () => {
      prisma.providerAccount.findFirst = async () => accountRow({ status: "unverified" });
      const outcome = await service.listVoices("account-1");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    });

    it("normalizes a provider auth failure without ever returning fake voices", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), { status: 401 })));
      const outcome = await service.listVoices("account-1");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_AUTH_INVALID" });
    });

    it("fetches a single voice detail", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ voice_id: "v1", name: "Alex", category: null, preview_url: null }), { status: 200 })));
      const outcome = await service.getVoice("account-1", "v1");
      expect(outcome).toMatchObject({ ok: true, data: { voiceId: "v1", name: "Alex" } });
    });
  });

  describe("createClone (consent evidence + audit)", () => {
    it("refuses to write an audit row or call the provider when consent is missing", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.createClone("account-1", "user-1", { name: "Clone A", consent: { statementVersion: "", statementText: "", acceptedAt: "" }, files: sampleFiles });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(prisma.voiceCloneConsentRecord.create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses when no sample file is provided", async () => {
      const outcome = await service.createClone("account-1", "user-1", { name: "Clone A", consent, files: [] });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(prisma.voiceCloneConsentRecord.create).not.toHaveBeenCalled();
    });

    it("writes a pending consent audit row before calling the provider, then marks it created on success", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ voice_id: "voice-new" }), { status: 200 })));
      const outcome = await service.createClone("account-1", "user-1", { name: "Clone A", consent, files: sampleFiles });
      expect(outcome).toMatchObject({ ok: true, data: { voiceId: "voice-new", consentRecordId: "consent-1" } });
      expect(prisma.voiceCloneConsentRecord.create).toHaveBeenCalledTimes(1);
      const created = prisma.voiceCloneConsentRecord.create.mock.calls[0]![0].data;
      expect(created.status).toBe("pending");
      expect(created.attestedByUserId).toBe("user-1");
      expect(prisma.voiceCloneConsentRecord.update).toHaveBeenCalledWith({ where: { id: "consent-1" }, data: { status: "created", externalVoiceId: "voice-new" } });
    });

    it("marks the consent audit row failed (never silently fake) when the provider rejects the clone", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { status: "missing_permissions", message: "requires a higher tier" } }), { status: 403 })));
      const outcome = await service.createClone("account-1", "user-1", { name: "Clone A", consent, files: sampleFiles });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
      expect(prisma.voiceCloneConsentRecord.update).toHaveBeenCalledWith({ where: { id: "consent-1" }, data: { status: "failed", failureReason: "PROVIDER_CAPABILITY_UNAVAILABLE" } });
    });
  });

  describe("deleteVoice", () => {
    it("deletes at the provider and revokes the matching consent audit rows", async () => {
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.method).toBe("DELETE");
        return new Response("{}", { status: 200 });
      }));
      const outcome = await service.deleteVoice("account-1", "voice-1", "user-1");
      expect(outcome).toMatchObject({ ok: true, data: { deleted: true } });
      expect(prisma.voiceCloneConsentRecord.updateMany).toHaveBeenCalledWith({
        where: { providerAccountId: "account-1", externalVoiceId: "voice-1", revokedAt: null },
        data: expect.objectContaining({ status: "revoked", revokedByUserId: "user-1" }),
      });
    });

    it("does not revoke any audit row when the provider delete call fails", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
      const outcome = await service.deleteVoice("account-1", "voice-1", "user-1");
      expect(outcome).toMatchObject({ ok: false });
      expect(prisma.voiceCloneConsentRecord.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("generateTts (validated audio + timestamps)", () => {
    it("validates, persists as a MediaAssetVersion and returns alignment + provider pin", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(alignedTtsBody), { status: 200 })));
      const outcome = await service.generateTts("account-1", "user-1", "staff", { projectId: "project-1", voiceId: "v1", text: "Xin chao" });
      expect(outcome).toMatchObject({
        ok: true,
        data: {
          asset: { id: "asset-1" },
          alignment: { characters: ["h", "i"] },
          durationMs: 300,
          providerPin: { accountId: "account-1", provider: "elevenlabs", voiceId: "v1", modelId: "eleven_multilingual_v2" },
        },
      });
      expect(media.registerAsset).toHaveBeenCalledTimes(1);
      const [, , , registerInput] = (media.registerAsset as any).mock.calls[0];
      expect(registerInput).toMatchObject({ kind: "audio", origin: "generated", reusable: false });
    });

    it("refuses empty text without calling the provider", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.generateTts("account-1", "user-1", "staff", { projectId: "project-1", voiceId: "v1", text: "   " });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects an unrecognized/invalid audio container instead of storing it", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        audio_base64: Buffer.from("not-real-audio").toString("base64"),
        alignment: { characters: ["a"], character_start_times_seconds: [0], character_end_times_seconds: [0.1] },
      }), { status: 200 })));
      const outcome = await service.generateTts("account-1", "user-1", "staff", { projectId: "project-1", voiceId: "v1", text: "Xin chao" });
      expect(outcome).toMatchObject({ ok: false, code: "UNSUPPORTED_MEDIA" });
      expect(media.registerAsset).not.toHaveBeenCalled();
    });

    it("normalizes a rate-limit failure without generating any placeholder audio", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "3" } })));
      const outcome = await service.generateTts("account-1", "user-1", "staff", { projectId: "project-1", voiceId: "v1", text: "Xin chao" });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_RATE_LIMITED" });
      expect(media.registerAsset).not.toHaveBeenCalled();
    });
  });
});

describe("ElevenLabsVoiceService voice preview (create-video Voice Picker)", () => {
  const sampleOk = () => new Response(JSON.stringify(alignedTtsBody), { status: 200 });
  const setup = (opts: { visibleToStaff?: boolean } = {}) => {
    const findFirst = vi.fn(async (args: any) => (args?.select ? (opts.visibleToStaff === false ? null : { id: "account-1" }) : accountRow()));
    const service = new ElevenLabsVoiceService({ providerAccount: { findFirst } } as any, { registerAsset: vi.fn() } as unknown as MediaService);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("sk-test");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sampleOk());
    vi.stubGlobal("fetch", fetchMock);
    return { service, fetchMock };
  };
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("speaks the fixed sample of the script language with the account's model (the render default) for exactly that voiceId", async () => {
    const { service, fetchMock } = setup();
    const outcome = await service.previewVoice("account-1", "EXAVITQu4vr4xnSDxMaL", "user-1", "admin", "ja", 1_000);
    expect(outcome).toMatchObject({ ok: true, data: { cached: false, voiceId: "EXAVITQu4vr4xnSDxMaL", modelId: "eleven_multilingual_v2", mimeType: "audio/mpeg" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/with-timestamps");
    expect(JSON.parse(String(init?.body))).toEqual({ text: VOICE_PREVIEW_SAMPLES.ja, model_id: "eleven_multilingual_v2" });
  });

  it("is cached per account + voice + model + sentence: a replay never calls ElevenLabs again until the TTL ends", async () => {
    const { service, fetchMock } = setup();
    await service.previewVoice("account-1", "voiceAAAA", "user-1", "admin", "vi", 1_000);
    const again = await service.previewVoice("account-1", "voiceAAAA", "user-1", "admin", "vi", 2_000);
    expect(again).toMatchObject({ ok: true, data: { cached: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await service.previewVoice("account-1", "voiceAAAA", "user-1", "admin", "en", 2_000); // another sentence
    await service.previewVoice("account-1", "voiceBBBB", "user-1", "admin", "vi", 2_000); // another voice
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await service.previewVoice("account-1", "voiceAAAA", "user-1", "admin", "vi", 1_000 + VOICE_PREVIEW_CACHE.ttlMs + 1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("provider errors come back as clear codes and are not cached (the next Play tries again)", async () => {
    const { service, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: "This request exceeds your quota" } }), { status: 401 }));
    expect(await service.previewVoice("account-1", "voiceAAAA", "user-1", "admin", "vi", 1_000)).toMatchObject({ ok: false, code: "PROVIDER_QUOTA_EXHAUSTED", status: 429 });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 }));
    expect(await service.previewVoice("account-1", "voiceAAAA", "user-1", "admin", "vi", 1_000)).toMatchObject({ ok: false, code: "PROVIDER_RATE_LIMITED" });
    expect(await service.previewVoice("account-1", "voiceAAAA", "user-1", "admin", "vi", 1_000)).toMatchObject({ ok: true, data: { cached: false } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("spends credits only for an account the user may use; a malformed voiceId is refused before any call", async () => {
    const hidden = setup({ visibleToStaff: false });
    expect(await hidden.service.previewVoice("account-1", "voiceAAAA", "user-2", "staff", "vi")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await hidden.service.previewVoice("account-1", "../x", "user-1", "admin", "vi")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(hidden.fetchMock).not.toHaveBeenCalled();
  });
});
