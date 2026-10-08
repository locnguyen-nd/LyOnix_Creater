import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import {
  createElevenLabsVoiceClone,
  deleteElevenLabsVoice,
  getElevenLabsVoice,
  listElevenLabsVoices,
  probeElevenLabsAccount,
  probeElevenLabsTts,
  textToSpeechWithTimestamps,
} from "./elevenlabs.js";

afterEach(() => { vi.unstubAllGlobals(); });

const consent = {
  attestedByUserId: "user-1",
  attestedAt: "2026-09-24T00:00:00.000Z",
  statementVersion: "v1",
  statementText: "I confirm I have the legal right to clone this voice.",
};

describe("probeElevenLabsAccount", () => {
  it("reports tier and instant-voice-cloning entitlement without billing a generate call", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      subscription: { tier: "starter", character_count: 100, character_limit: 10000, can_use_instant_voice_cloning: true },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeElevenLabsAccount("key")).resolves.toEqual({ tier: "starter", characterCount: 100, characterLimit: 10000, canUseInstantVoiceCloning: true });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("/v1/user");
  });

  it("maps 401 to PROVIDER_AUTH_INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), { status: 401 })));
    await expect(probeElevenLabsAccount("bad")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" } satisfies Partial<ProviderError>);
  });
});

describe("listElevenLabsVoices / getElevenLabsVoice", () => {
  it("lists voices without exposing raw audio bytes, only provider preview URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      voices: [{ voice_id: "v1", name: "Alex", category: "cloned", preview_url: "https://cdn.elevenlabs.io/preview/v1.mp3" }],
    }), { status: 200 })));
    await expect(listElevenLabsVoices("key")).resolves.toEqual([{
      voiceId: "v1", name: "Alex", category: "cloned", previewUrl: "https://cdn.elevenlabs.io/preview/v1.mp3",
      gender: null, language: null, accent: null, age: null, useCase: null, descriptive: null, languages: [],
    }]);
  });

  it("keeps the search / filter metadata (labels, verified languages with their own previews), https previews only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      voices: [{
        voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah - Mature, Reassuring, Confident", category: "premade", preview_url: "https://storage.googleapis.com/eleven/sarah.mp3",
        labels: { gender: "female", language: "en", accent: "american", age: "young", use_case: "entertainment_tv", descriptive: "professional" },
        verified_languages: [
          { language: "en", accent: "american", locale: "en-US", model_id: "eleven_multilingual_v2", preview_url: "https://storage.googleapis.com/eleven/sarah-en.mp3" },
          { language: "ja", accent: "standard", locale: "ja-JP", model_id: "eleven_multilingual_v2", preview_url: "http://insecure.example/ja.mp3" },
          { accent: "no language", preview_url: "https://x.example/a.mp3" },
        ],
      }],
    }), { status: 200 })));
    const [sarah] = await listElevenLabsVoices("key");
    expect(sarah).toMatchObject({ gender: "female", language: "en", accent: "american", age: "young", useCase: "entertainment_tv", descriptive: "professional" });
    expect(sarah!.languages).toEqual([
      { language: "en", accent: "american", locale: "en-US", modelId: "eleven_multilingual_v2", previewUrl: "https://storage.googleapis.com/eleven/sarah-en.mp3" },
      { language: "ja", accent: "standard", locale: "ja-JP", modelId: "eleven_multilingual_v2", previewUrl: null },
    ]);
  });

  it("fetches a single voice detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ voice_id: "v1", name: "Alex", category: null, preview_url: null }), { status: 200 })));
    await expect(getElevenLabsVoice("key", "v1")).resolves.toMatchObject({ voiceId: "v1", name: "Alex", category: null, previewUrl: null, gender: null, languages: [] });
  });

  it("maps quota-exceeded to PROVIDER_QUOTA_EXHAUSTED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: "You have insufficient credits" } }), { status: 400 })));
    await expect(listElevenLabsVoices("key")).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" } satisfies Partial<ProviderError>);
  });

  it("maps a tier/entitlement 403 to PROVIDER_CAPABILITY_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { status: "missing_permissions", message: "requires a higher tier" } }), { status: 403 })));
    await expect(listElevenLabsVoices("key")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" } satisfies Partial<ProviderError>);
  });

  it("maps 429 to PROVIDER_RATE_LIMITED with retryAfterMs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "2" } })));
    await expect(listElevenLabsVoices("key")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterMs: 2000 } satisfies Partial<ProviderError>);
  });

  it("normalizes a network failure to PROVIDER_TIMEOUT", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(listElevenLabsVoices("key")).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" } satisfies Partial<ProviderError>);
  });
});

describe("createElevenLabsVoiceClone", () => {
  it("refuses to call the provider when consent is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createElevenLabsVoiceClone("key", {
      name: "Clone A",
      files: [{ fileName: "sample.mp3", mimeType: "audio/mpeg", data: Buffer.from([1, 2, 3]) }],
      consent: undefined as never,
    })).rejects.toThrow("voice_clone_consent_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to call the provider when no sample file is provided", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createElevenLabsVoiceClone("key", { name: "Clone A", files: [], consent })).rejects.toThrow("voice_clone_sample_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits multipart form data and returns the new voiceId when consent is present", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get("name")).toBe("Clone A");
      expect(form.getAll("files").length).toBe(1);
      return new Response(JSON.stringify({ voice_id: "voice-new" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(createElevenLabsVoiceClone("key", {
      name: "Clone A",
      files: [{ fileName: "sample.mp3", mimeType: "audio/mpeg", data: Buffer.from([1, 2, 3]) }],
      consent,
    })).resolves.toEqual({ voiceId: "voice-new" });
  });
});

describe("deleteElevenLabsVoice", () => {
  it("calls DELETE on the voice endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("DELETE");
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteElevenLabsVoice("key", "voice-1")).resolves.toBeUndefined();
  });
});

describe("textToSpeechWithTimestamps", () => {
  const alignedBody = {
    audio_base64: Buffer.from("fake-mp3-bytes").toString("base64"),
    alignment: {
      characters: ["h", "i"],
      character_start_times_seconds: [0, 0.1],
      character_end_times_seconds: [0.1, 0.25],
    },
  };

  it("decodes audio and derives durationMs from the last alignment end time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(alignedBody), { status: 200 })));
    const result = await textToSpeechWithTimestamps("key", { voiceId: "v1", modelId: "eleven_multilingual_v2", text: "hi" });
    expect(result.audio.toString("utf8")).toBe("fake-mp3-bytes");
    expect(result.durationMs).toBe(250);
    expect(result.alignment.characters).toEqual(["h", "i"]);
    expect(result.mimeType).toBe("audio/mpeg");
  });

  it("refuses to call the provider with empty text", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(textToSpeechWithTimestamps("key", { voiceId: "v1", modelId: "m", text: "   " })).rejects.toThrow("tts_text_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws PROVIDER_SCHEMA_INVALID when alignment is missing/mismatched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ audio_base64: Buffer.from("x").toString("base64"), alignment: { characters: ["a"], character_start_times_seconds: [0], character_end_times_seconds: [] } }), { status: 200 })));
    await expect(textToSpeechWithTimestamps("key", { voiceId: "v1", modelId: "m", text: "hi" })).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" } satisfies Partial<ProviderError>);
  });

  it("probeElevenLabsTts makes one real with-timestamps call and returns verifiedAt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(alignedBody), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeElevenLabsTts("key", "v1", "eleven_multilingual_v2");
    expect(result.verifiedAt).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
