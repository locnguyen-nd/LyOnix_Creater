import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { probeVisionCapability, tryProbeVisionCapability } from "./vision-probe.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("probeVisionCapability", () => {
  it("sends exactly one inline image part alongside the probe prompt to the real generate endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain(":generateContent");
      const body = JSON.parse(String(init?.body));
      const parts = body.contents[0].parts;
      expect(parts).toHaveLength(2);
      expect(parts[1].inlineData.mimeType).toBe("image/png");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeVisionCapability("gemini", "key", "gemini-2.5-flash", "image");
    expect(result).toMatchObject({ modelId: "gemini-2.5-flash", inputKind: "image" });
    expect(result.verifiedAt).toBeTruthy();
  });

  it("records the caller's declared inputKind (image vs video_frame) without changing the call shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 })));
    const result = await probeVisionCapability("gemini", "key", "gemini-2.5-flash", "video_frame");
    expect(result.inputKind).toBe("video_frame");
  });

  it("propagates a ProviderError (PROVIDER_SCHEMA_INVALID) when the model rejects the image input payload (e.g. a text-only model)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "This model does not support image input" } }), { status: 400 })));
    await expect(probeVisionCapability("openai", "key", "gpt-text-only")).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" } satisfies Partial<ProviderError>);
  });
});

describe("tryProbeVisionCapability", () => {
  it("never throws - resolves ok:false with a ProviderError on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "auth failed" } }), { status: 401 })));
    const outcome = await tryProbeVisionCapability("gemini", "bad", "gemini-2.5-flash");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("PROVIDER_AUTH_INVALID");
  });

  it("resolves ok:true on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 })));
    const outcome = await tryProbeVisionCapability("gemini", "key", "gemini-2.5-flash");
    expect(outcome.ok).toBe(true);
  });
});
