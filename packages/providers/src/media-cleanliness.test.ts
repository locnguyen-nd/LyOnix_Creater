import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeApifyItems } from "./apify.js";
import { moderateMediaWithVision, moderateSceneCandidatesBatch } from "./vision-moderation.js";

// VE2E-152: the cleanliness fields ride on the existing vision call; TikTok effect stickers become a candidate edit signal.
afterEach(() => { vi.unstubAllGlobals(); });

const gemini = (result: Record<string, unknown>) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] }), { status: 200 });
const ctx = { beat: "hook", entities: [], action: [], setting: [], mood: [], exclusions: [], cleanliness: true };
const base = { safety_flag: false, safety_categories: [], scene_beat_relevance: 0.8, confidence: 0.9, notes: "ok" };
const cleanFields = {
  text_area_pct: 24,
  text_over_subject: false,
  burnt_in_subtitles: true,
  logo_size: "small",
  watermark_or_username: true,
  lower_third_or_banner: false,
  stickers_or_emoji: false,
  frame_or_template: false,
  split_screen_or_pip: false,
  social_ui_overlay: false,
  large_overlay: false,
};
const frame = { mimeType: "image/jpeg", base64: "AAAA" };

describe("VE2E-152 vision cleanliness fields", () => {
  it("a single cover image: the fields are asked in the same call and parsed", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => gemini({ ...base, ...cleanFields }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await moderateMediaWithVision({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash", operation: "image_moderation", sceneContext: ctx, frames: [frame] });
    const body = String(fetchMock.mock.calls[0]![1]!.body);
    for (const field of ["text_area_pct", "burnt_in_subtitles", "logo_size", "social_ui_overlay", "only overlays an editor added count"]) expect(body).toContain(field);
    expect(body).not.toContain("frames_heavy_text"); // one image: no frame counts
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.raw.cleanliness).toMatchObject({ textAreaPct: 24, subtitles: true, logo: "small", watermark: true, sampledFrames: 1 });
  });

  it("5 sampled frames: frame counts asked and returned (>= 2 heavy frames feeds the text-heavy rule)", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => gemini({ ...base, ...cleanFields, frames_heavy_text: 3, frames_with_watermark: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await moderateMediaWithVision({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash", operation: "video_frame_moderation", sceneContext: ctx, frames: Array.from({ length: 5 }, (_, i) => ({ ...frame, timestampMs: i * 1000 })) });
    expect(String(fetchMock.mock.calls[0]![1]!.body)).toContain("frames_heavy_text");
    expect(result.raw.cleanliness).toMatchObject({ heavyTextFrames: 3, watermarkFrames: 5, sampledFrames: 5 });
  });

  it("without the flag the request is unchanged; a malformed cleanliness answer is ignored (metadata ranking decides)", async () => {
    const plain = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => gemini(base));
    vi.stubGlobal("fetch", plain);
    await moderateMediaWithVision({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash", operation: "image_moderation", sceneContext: { ...ctx, cleanliness: false }, frames: [frame] });
    expect(String(plain.mock.calls[0]![1]!.body)).not.toContain("text_area_pct");

    vi.stubGlobal("fetch", vi.fn(async () => gemini({ ...base, ...cleanFields, logo_size: "medium" })));
    const bad = await moderateMediaWithVision({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash", operation: "image_moderation", sceneContext: ctx, frames: [frame] });
    expect(bad.raw.cleanliness).toBeUndefined();
  });

  it("the cover batch carries the cleanliness per image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gemini({ items: [{ index: 1, ...base, ...cleanFields }, { index: 2, ...base, ...cleanFields, text_area_pct: 3, burnt_in_subtitles: false }] })));
    const outcome = await moderateSceneCandidatesBatch({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash", sceneContext: ctx, capabilityEvidence: { verifiedAt: new Date().toISOString() }, items: [{ id: "a", frame }, { id: "b", frame }] });
    expect(outcome.verdicts.get("a")?.cleanliness?.subtitles).toBe(true);
    expect(outcome.verdicts.get("b")?.cleanliness?.textAreaPct).toBe(3);
  });
});

describe("VE2E-152 TikTok edit signals", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: "7000000000000000009",
    text: "Felix dance",
    textLanguage: "ja",
    hashtags: [],
    webVideoUrl: "https://www.tiktok.com/@fake/video/7000000000000000009",
    authorMeta: { name: "fake" },
    videoMeta: { duration: 30, width: 720, height: 1280 },
    mediaUrls: ["https://api.apify.com/v2/key-value-stores/FAKEKV/records/video-7000000000000000009.mp4"],
    ...over,
  });
  const actor = { actorId: "clockworks/tiktok-scraper", version: "0.0.611", role: "primary" as const, runId: "run1" };
  const context = { query: "k", providerAccountId: "acct-1", fetchedAt: "2026-10-09T00:00:00.000Z" };

  it("effect stickers mark the candidate (stickers_or_emoji); none -> no edit signal", () => {
    const [withStickers] = normalizeApifyItems("tiktok", [item({ effectStickers: [{ name: "sparkle", ID: "1" }] })], actor, context);
    const [plain] = normalizeApifyItems("tiktok", [item()], actor, context);
    expect(withStickers!.candidate.editSignals).toEqual(["stickers_or_emoji"]);
    expect(plain!.candidate.editSignals).toBeUndefined();
  });
});
