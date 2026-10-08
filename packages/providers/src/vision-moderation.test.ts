import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { MAX_MODERATION_FRAMES, moderateMediaWithVision, moderateSceneCandidate, moderateSceneCandidatesBatch } from "./vision-moderation.js";
import { probeVisionCapability } from "./vision-probe.js";

afterEach(() => { vi.unstubAllGlobals(); });

const sceneContext = { beat: "hook", entities: ["person"], action: ["walking"], setting: ["beach"], mood: ["calm"], exclusions: ["logo"] };

const okBody = (result: Record<string, unknown>) => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] });

describe("moderateMediaWithVision", () => {
  it("VE2E-123: the capability probe and the real moderation send the same Responses API request shape (OpenAI)", async () => {
    const result = { safety_flag: false, safety_categories: [], scene_beat_relevance: 0.9, confidence: 0.9, notes: "ok" };
    // Raw REST Responses shape: text in output[] message parts, no top-level output_text.
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(result) }] }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await probeVisionCapability("openai", "sk-test", "gpt-4o-mini");
    const moderated = await moderateMediaWithVision({ kind: "openai", apiKey: "sk-test", modelId: "gpt-4o-mini", operation: "image_moderation", sceneContext, frames: [{ mimeType: "image/jpeg", base64: "AAAA" }] });
    expect(moderated.raw).toMatchObject({ safetyFlag: false, sceneBeatRelevance: 0.9 });
    const [probe, real] = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { instructions: string; input: Array<{ content: Array<{ type: string }> }>; text: { format: { name: string } } });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"]);
    expect(Object.keys(probe!).sort()).toEqual(Object.keys(real!).sort());
    expect(probe!.instructions).toBe(real!.instructions);
    expect(probe!.text.format.name).toBe(real!.text.format.name);
    expect(probe!.input[0]!.content.map((part) => part.type)).toEqual(["input_text", "input_image"]);
    expect(real!.input[0]!.content.map((part) => part.type)).toEqual(["input_text", "input_image"]);
  });

  it("sends a bounded, well-formed request and returns the parsed structured result plus sampled metadata", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.contents[0].parts).toHaveLength(2); // prompt text + 1 frame
      return new Response(okBody({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.9, confidence: 0.95, notes: "ok" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await moderateMediaWithVision({
      kind: "gemini", apiKey: "key", modelId: "gemini-2.5-flash", operation: "image_moderation", sceneContext,
      frames: [{ mimeType: "image/jpeg", base64: "AAAA" }],
    });
    expect(result.raw).toMatchObject({ safetyFlag: false, sceneBeatRelevance: 0.9, confidence: 0.95 });
    expect(result.sampledFrameCount).toBe(1);
  });

  it("caps the frame count at MAX_MODERATION_FRAMES even when the caller passes more", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.contents[0].parts).toHaveLength(MAX_MODERATION_FRAMES + 1); // prompt text + capped frames
      return new Response(okBody({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.5, confidence: 0.5, notes: "n" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manyFrames = Array.from({ length: MAX_MODERATION_FRAMES + 10 }, (_, i) => ({ mimeType: "image/jpeg", base64: "AAAA", timestampMs: i * 500 }));
    const result = await moderateMediaWithVision({ kind: "gemini", apiKey: "key", modelId: "m", operation: "video_frame_moderation", sceneContext, frames: manyFrames });
    expect(result.sampledFrameCount).toBe(MAX_MODERATION_FRAMES);
    expect(result.sampledTimestampsMs).toHaveLength(MAX_MODERATION_FRAMES);
  });

  it("drops an oversized frame instead of sending it, bounding request egress", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.contents[0].parts).toHaveLength(2); // prompt text + 1 (the normal-size) frame - the oversized one was dropped
      return new Response(okBody({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.5, confidence: 0.5, notes: "n" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const oversized = "A".repeat(3_000_001);
    await moderateMediaWithVision({
      kind: "gemini", apiKey: "key", modelId: "m", operation: "image_moderation", sceneContext,
      frames: [{ mimeType: "image/jpeg", base64: oversized }, { mimeType: "image/jpeg", base64: "AAAA" }],
    });
  });

  it("throws PROVIDER_CAPABILITY_UNAVAILABLE when given zero frames", async () => {
    await expect(moderateMediaWithVision({ kind: "gemini", apiKey: "key", modelId: "m", operation: "image_moderation", sceneContext, frames: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" } satisfies Partial<ProviderError>);
  });

  it("throws PROVIDER_SCHEMA_INVALID (never accepts) on a malformed/out-of-range structured response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(okBody({ safety_flag: false, safety_categories: [], scene_beat_relevance: 1.5, confidence: 0.9, notes: "n" }), { status: 200 })));
    await expect(moderateMediaWithVision({ kind: "gemini", apiKey: "key", modelId: "m", operation: "image_moderation", sceneContext, frames: [{ mimeType: "image/jpeg", base64: "AAAA" }] }))
      .rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" } satisfies Partial<ProviderError>);
  });

  it("never logs/echoes the raw base64 frame payload anywhere in the returned result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(okBody({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.5, confidence: 0.5, notes: "n" }), { status: 200 })));
    const result = await moderateMediaWithVision({ kind: "gemini", apiKey: "key", modelId: "m", operation: "image_moderation", sceneContext, frames: [{ mimeType: "image/jpeg", base64: "SECRETFRAMEDATA" }] });
    expect(JSON.stringify(result)).not.toContain("SECRETFRAMEDATA");
  });
});

describe("moderateSceneCandidate (capability-checked, always-fail-closed orchestration)", () => {
  it("reuses fresh capability evidence and skips a redundant probe call before the real moderation call", async () => {
    const fetchMock = vi.fn(async () => new Response(okBody({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.7, confidence: 0.9, notes: "n" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await moderateSceneCandidate({
      kind: "gemini", apiKey: "key", modelId: "m", operation: "image_moderation", sceneContext,
      frames: [{ mimeType: "image/jpeg", base64: "AAAA" }],
      capabilityEvidence: { verifiedAt: new Date().toISOString() },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the real moderation call, no separate probe call
    expect(outcome.raw).toMatchObject({ confidence: 0.9 });
    expect(outcome.capabilityVerifiedAt).toBeTruthy();
  });

  it("re-probes capability first when evidence is stale, then makes the real call", async () => {
    const fetchMock = vi.fn(async () => new Response(okBody({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.7, confidence: 0.9, notes: "n" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await moderateSceneCandidate({
      kind: "gemini", apiKey: "key", modelId: "m", operation: "image_moderation", sceneContext,
      frames: [{ mimeType: "image/jpeg", base64: "AAAA" }],
      capabilityEvidence: { verifiedAt: new Date(0).toISOString() }, // ancient - stale
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // probe + real call
    expect(outcome.raw).toMatchObject({ confidence: 0.9 });
  });

  it("fails closed to raw:null (never throws) when the capability probe itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "no image support" } }), { status: 400 })));
    const outcome = await moderateSceneCandidate({ kind: "gemini", apiKey: "key", modelId: "m", operation: "image_moderation", sceneContext, frames: [{ mimeType: "image/jpeg", base64: "AAAA" }] });
    expect(outcome.raw).toBeNull();
    expect(outcome.capabilityVerifiedAt).toBeNull();
  });

  it("fails closed to raw:null (never throws) when the real moderation call errors after a successful probe", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "retry-after": "5" } });
    }));
    const outcome = await moderateSceneCandidate({ kind: "gemini", apiKey: "key", modelId: "m", operation: "image_moderation", sceneContext, frames: [{ mimeType: "image/jpeg", base64: "AAAA" }] });
    expect(outcome.raw).toBeNull();
    expect(outcome.capabilityVerifiedAt).toBeTruthy(); // the probe itself did succeed
  });

  it("evidenceRefs never contains the raw frame payload, only request id and sampled timestamps", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(okBody({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.5, confidence: 0.5, notes: "n" }), { status: 200 })));
    const outcome = await moderateSceneCandidate({
      kind: "gemini", apiKey: "key", modelId: "m", operation: "video_frame_moderation", sceneContext,
      frames: [{ mimeType: "image/jpeg", base64: "SECRETFRAMEDATA", timestampMs: 1200 }],
      capabilityEvidence: { verifiedAt: new Date().toISOString() },
    });
    expect(outcome.evidenceRefs.some((ref) => ref.includes("SECRETFRAMEDATA"))).toBe(false);
    expect(outcome.evidenceRefs).toContain("frame_ts_ms:1200");
  });
});

describe("VE2E-131 batch + deadline", () => {
  const verdict = (over: Record<string, unknown> = {}) => ({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.8, confidence: 0.9, notes: "n", ...over });
  const items = ["a", "b", "c"].map((id) => ({ id, frame: { mimeType: "image/jpeg", base64: "AAAA" } }));

  it("judges several covers in one request and maps verdicts by index (missing index stays absent)", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(okBody({ items: [{ index: 1, ...verdict() }, { index: 3, ...verdict({ safety_flag: true }) }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await moderateSceneCandidatesBatch({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash-lite", sceneContext, items, capabilityEvidence: { verifiedAt: new Date().toISOString() } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).contents[0].parts.filter((p: Record<string, unknown>) => p.inline_data || p.inlineData)).toHaveLength(3);
    expect([...out.verdicts.keys()]).toEqual(["a", "c"]);
    expect(out.verdicts.get("c")?.safetyFlag).toBe(true);
    expect(out.failureCode).toBeUndefined();
  });

  it("a call slower than the deadline resolves to PROVIDER_TIMEOUT without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const out = await moderateSceneCandidatesBatch({ kind: "gemini", apiKey: "k", modelId: "m", sceneContext, items, capabilityEvidence: { verifiedAt: new Date().toISOString() }, timeoutMs: 30 });
    expect(out.failureCode).toBe("PROVIDER_TIMEOUT");
    expect(out.verdicts.size).toBe(0);
    const single = await moderateSceneCandidate({ kind: "gemini", apiKey: "k", modelId: "m", operation: "image_moderation", sceneContext, frames: [items[0]!.frame], capabilityEvidence: { verifiedAt: new Date().toISOString() }, timeoutMs: 30 });
    expect(single).toMatchObject({ raw: null, failureCode: "PROVIDER_TIMEOUT" });
  });
});
