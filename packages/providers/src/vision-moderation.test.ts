import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { MAX_MODERATION_FRAMES, moderateMediaWithVision, moderateSceneCandidate } from "./vision-moderation.js";

afterEach(() => { vi.unstubAllGlobals(); });

const sceneContext = { beat: "hook", entities: ["person"], action: ["walking"], setting: ["beach"], mood: ["calm"], exclusions: ["logo"] };

const okBody = (result: Record<string, unknown>) => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] });

describe("moderateMediaWithVision", () => {
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
