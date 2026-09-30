import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import * as secretCrypto from "./secret-crypto.js";
import {
  TTS_PROVIDER_DISABLED_VALUE,
  classifyCreatomateRenderError,
  slotsWithTtsProvider,
  templateTtsConflictMessage,
  templateTtsWarnings,
  ttsProviderOverrideKey,
  unfilledTtsSlotKeys,
} from "./template-tts.js";

const PROVIDER = "elevenlabs model_id=eleven_multilingual_v2 voice_id=XrExE9yKIg1WjnnlVkGX";
const jpTemplate = {
  elements: [
    { name: "Voiceover-1", type: "audio", source: "", provider: PROVIDER, dynamic: true },
    { name: "Voiceover-2", type: "audio", source: "", provider: PROVIDER, dynamic: true },
    { name: "Music", type: "audio", source: "https://cdn/music.mp3", dynamic: true },
    { name: "Jingle", type: "audio", source: "hello", provider: PROVIDER },
  ],
};

describe("VE2E-47 template TTS helpers", () => {
  it("override key/value: <name>.source -> <name>.provider = empty string", () => {
    expect(ttsProviderOverrideKey("Voiceover-1.source")).toBe("Voiceover-1.provider");
    expect(TTS_PROVIDER_DISABLED_VALUE).toBe("");
  });

  it("warns for every audio element with a provider (dynamic -> slotKey, fixed -> null) and not for plain audio", () => {
    expect(templateTtsWarnings(jpTemplate)).toEqual([
      { code: "TEMPLATE_TTS_PROVIDER", elementName: "Voiceover-1", slotKey: "Voiceover-1.source", provider: PROVIDER },
      { code: "TEMPLATE_TTS_PROVIDER", elementName: "Voiceover-2", slotKey: "Voiceover-2.source", provider: PROVIDER },
      { code: "TEMPLATE_TTS_PROVIDER", elementName: "Jingle", slotKey: null, provider: PROVIDER },
    ]);
    expect(templateTtsWarnings({ elements: [{ name: "Music", type: "audio", source: "x", dynamic: true }] })).toEqual([]);
  });

  it("backfills ttsProvider on slots pinned before VE2E-47 from rawTemplate, leaving other slots alone", () => {
    const old = [
      { key: "Voiceover-1.source", kind: "audio" as const, label: "Voiceover-1.source", required: false },
      { key: "Music.source", kind: "audio" as const, label: "Music.source", required: false },
      { key: "Voiceover-1.volume", kind: "volume" as const, label: "Voiceover-1.volume", required: false },
    ];
    const out = slotsWithTtsProvider(old, jpTemplate);
    expect(out[0]).toMatchObject({ key: "Voiceover-1.source", ttsProvider: PROVIDER });
    expect(out[1]).not.toHaveProperty("ttsProvider");
    expect(out[2]).not.toHaveProperty("ttsProvider");
    expect(slotsWithTtsProvider(old, null)).toBe(old);
  });

  it("lists only TTS audio slots that received no LyOnix audio", () => {
    const slots = slotsWithTtsProvider(
      [
        { key: "Voiceover-1.source", kind: "audio", label: "", required: false },
        { key: "Voiceover-2.source", kind: "audio", label: "", required: false },
        { key: "Music.source", kind: "audio", label: "", required: false },
      ],
      jpTemplate,
    );
    expect(unfilledTtsSlotKeys(slots, ["Voiceover-1.source"])).toEqual(["Voiceover-2.source"]);
    expect(unfilledTtsSlotKeys(slots, ["Voiceover-1.source", "Voiceover-2.source"])).toEqual([]);
    expect(templateTtsConflictMessage(["Voiceover-2.source"])).toContain("Voiceover-2.source");
  });

  describe("classifyCreatomateRenderError", () => {
    it("maps the 28/09 integration failure to TEMPLATE_TTS_FAILED with the real message", () => {
      const out = classifyCreatomateRenderError("There is no third-party integration set up for ElevenLabs");
      expect(out.code).toBe("TEMPLATE_TTS_FAILED");
      expect(out.message).toContain("no third-party integration set up for ElevenLabs");
    });
    it("maps the 30/09 quota failure to PROVIDER_QUOTA_EXHAUSTED with the real message", () => {
      const out = classifyCreatomateRenderError("ElevenLabs error: quota_exceeded, 0 credits remaining, 118 required");
      expect(out.code).toBe("PROVIDER_QUOTA_EXHAUSTED");
      expect(out.message).toContain("quota_exceeded");
    });
    it("keeps unrelated failures as PROVIDER_SUBMIT_UNKNOWN unchanged, and defaults the empty message", () => {
      expect(classifyCreatomateRenderError("Invalid font")).toEqual({ code: "PROVIDER_SUBMIT_UNKNOWN", message: "Invalid font" });
      expect(classifyCreatomateRenderError(null)).toEqual({ code: "PROVIDER_SUBMIT_UNKNOWN", message: "Creatomate render failed" });
    });
  });
});

describe("VE2E-47 template snapshot pin", () => {
  let prisma: any;
  let service: CreatomateTemplatesService;
  beforeEach(() => {
    prisma = {
      providerAccount: { findFirst: async () => ({ id: "account-1", provider: "creatomate", role: "render", status: "verified", encryptedSecret: "e", isFake: false, deletedAt: null }) },
      templateSnapshot: { create: vi.fn(async ({ data }: any) => ({ id: "snap-1", capturedAt: new Date("2026-09-30T00:00:00Z"), ...data })) },
    };
    service = new CreatomateTemplatesService(prisma);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("ctm-test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes ttsProvider on the audio slot and a TEMPLATE_TTS_PROVIDER warning when an audio element carries a provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "tpl_jp", name: "News Recap JP", source: jpTemplate }), { status: 200 })));
    const outcome = await service.snapshot("account-1", "tpl_jp", "user-1");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.data.modifications.find((m) => m.key === "Voiceover-1.source")).toMatchObject({ ttsProvider: PROVIDER });
    expect(outcome.data.modifications.find((m) => m.key === "Music.source")).not.toHaveProperty("ttsProvider");
    expect(outcome.data.warnings?.map((w) => w.elementName)).toEqual(["Voiceover-1", "Voiceover-2", "Jingle"]);
  });

  it("a template without any provider has no warnings key and no ttsProvider (unchanged)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "tpl_ok", name: "Plain", source: { elements: [{ name: "Music", type: "audio", dynamic: true }, { name: "Text-1", type: "text", dynamic: true }] } }), { status: 200 })));
    const outcome = await service.snapshot("account-1", "tpl_ok", "user-1");
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.data).not.toHaveProperty("warnings");
    expect(outcome.data.modifications.some((m) => "ttsProvider" in m)).toBe(false);
  });
});
