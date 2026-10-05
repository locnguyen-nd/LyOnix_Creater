import { describe, expect, it } from "vitest";
import {
  FULL_PREVIEW_FALLBACK_DURATION_MS,
  FULL_PREVIEW_MIN_SEGMENT_MS,
  buildFullPreviewSequence,
  clampTime,
  formatClock,
  locateAt,
  sceneStartMs,
  summarizeReadiness,
  videoSourceTimeSec,
  type FullPreviewSceneInput,
} from "./full-preview";

const scene = (id: string, over: Partial<FullPreviewSceneInput> = {}): FullPreviewSceneInput => ({
  sceneId: id,
  excluded: false,
  narration: `narration ${id}`,
  screenText: null,
  durationHintMs: 4000,
  mediaKind: "image",
  mediaUrl: `https://m/${id}`,
  sourceStartMs: null,
  sourceDurationMs: null,
  audioUrl: `https://a/${id}`,
  audioDurationMs: 2000,
  ...over,
});

describe("buildFullPreviewSequence", () => {
  it("keeps timeline order and accumulates start times", () => {
    const seq = buildFullPreviewSequence([scene("b"), scene("a", { audioDurationMs: 3000 }), scene("c")]);
    expect(seq.segments.map((s) => s.sceneId)).toEqual(["b", "a", "c"]);
    expect(seq.segments.map((s) => s.startMs)).toEqual([0, 2000, 5000]);
    expect(seq.totalDurationMs).toBe(7000);
    expect(seq.segments.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("skips excluded scenes and re-indexes", () => {
    const seq = buildFullPreviewSequence([scene("a"), scene("x", { excluded: true }), scene("b")]);
    expect(seq.segments.map((s) => s.sceneId)).toEqual(["a", "b"]);
    expect(seq.segments[1]!.index).toBe(1);
    expect(sceneStartMs(seq, "x")).toBeNull();
    expect(sceneStartMs(seq, "b")).toBe(2000);
  });

  it("prefers voice duration, then video source slice, then hint, then fallback", () => {
    const seq = buildFullPreviewSequence([
      scene("voice"),
      scene("slice", { audioUrl: null, audioDurationMs: null, mediaKind: "video", sourceStartMs: 1000, sourceDurationMs: 2500 }),
      scene("hint", { audioUrl: null, audioDurationMs: null }),
      scene("fb", { audioUrl: null, audioDurationMs: null, durationHintMs: 0 }),
    ]);
    expect(seq.segments.map((s) => [s.durationMs, s.durationSource])).toEqual([
      [2000, "audio"],
      [2500, "source"],
      [4000, "hint"],
      [FULL_PREVIEW_FALLBACK_DURATION_MS, "fallback"],
    ]);
  });

  it("enforces a minimum segment length", () => {
    const seq = buildFullPreviewSequence([scene("a", { audioDurationMs: 10 })]);
    expect(seq.segments[0]!.durationMs).toBe(FULL_PREVIEW_MIN_SEGMENT_MS);
  });

  it("computes the video source range and ignores it for images", () => {
    const seq = buildFullPreviewSequence([
      scene("v", { mediaKind: "video", sourceStartMs: 5000, sourceDurationMs: 2000 }),
      scene("i", { mediaKind: "image", sourceStartMs: 5000, sourceDurationMs: 2000 }),
    ]);
    expect([seq.segments[0]!.sourceStartMs, seq.segments[0]!.sourceEndMs]).toEqual([5000, 7000]);
    expect([seq.segments[1]!.sourceStartMs, seq.segments[1]!.sourceEndMs]).toEqual([null, null]);
  });

  it("flags missing media / voice without stalling (durations still resolved)", () => {
    const seq = buildFullPreviewSequence([
      scene("ok"),
      scene("nomedia", { mediaUrl: null }),
      scene("novoice", { audioUrl: undefined, audioDurationMs: undefined }),
      scene("none", { mediaUrl: undefined, mediaKind: null, audioUrl: null, audioDurationMs: null }),
    ]);
    expect(seq.segments.map((s) => [s.missingMedia, s.missingVoice])).toEqual([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]);
    expect(seq.segments[1]!.mediaUrl).toBeNull();
    expect(seq.segments.every((s) => s.durationMs > 0)).toBe(true);
    const ready = summarizeReadiness(seq);
    expect(ready.missingMedia).toEqual(["nomedia", "none"]);
    expect(ready.missingVoice).toEqual(["novoice", "none"]);
    expect(ready.notReady).toEqual(["nomedia", "novoice", "none"]);
  });

  it("uses narration as caption, falling back to screenText", () => {
    const seq = buildFullPreviewSequence([scene("a", { narration: "  hi  " }), scene("b", { narration: "", screenText: "on screen" })]);
    expect(seq.segments.map((s) => s.caption)).toEqual(["hi", "on screen"]);
  });

  it("handles an empty / all-excluded list", () => {
    expect(buildFullPreviewSequence([])).toEqual({ segments: [], totalDurationMs: 0 });
    const seq = buildFullPreviewSequence([scene("a", { excluded: true })]);
    expect(seq.totalDurationMs).toBe(0);
    expect(locateAt(seq, 100)).toBeNull();
  });
});

describe("locateAt / scrub mapping", () => {
  const seq = buildFullPreviewSequence([scene("a"), scene("b", { audioDurationMs: 3000 }), scene("c")]);

  it("maps times inside segments", () => {
    expect(locateAt(seq, 0)).toEqual({ index: 0, offsetMs: 0 });
    expect(locateAt(seq, 1500)).toEqual({ index: 0, offsetMs: 1500 });
    expect(locateAt(seq, 3200)).toEqual({ index: 1, offsetMs: 1200 });
  });

  it("assigns a boundary to the next segment", () => {
    expect(locateAt(seq, 2000)).toEqual({ index: 1, offsetMs: 0 });
    expect(locateAt(seq, 5000)).toEqual({ index: 2, offsetMs: 0 });
  });

  it("clamps out-of-range and maps the end to the last segment", () => {
    expect(locateAt(seq, -50)).toEqual({ index: 0, offsetMs: 0 });
    expect(locateAt(seq, 7000)).toEqual({ index: 2, offsetMs: 2000 });
    expect(locateAt(seq, 99999)).toEqual({ index: 2, offsetMs: 2000 });
    expect(locateAt(seq, Number.NaN)).toEqual({ index: 0, offsetMs: 0 });
    expect(clampTime(seq, 99999)).toBe(7000);
  });
});

describe("videoSourceTimeSec", () => {
  it("adds source start and offset, capped at the slice end", () => {
    const seq = buildFullPreviewSequence([
      scene("v", { mediaKind: "video", sourceStartMs: 5000, sourceDurationMs: 1500, audioDurationMs: 4000 }),
    ]);
    const seg = seq.segments[0]!;
    expect(videoSourceTimeSec(seg, 0)).toBe(5);
    expect(videoSourceTimeSec(seg, 1000)).toBe(6);
    expect(videoSourceTimeSec(seg, 3000)).toBe(6.5);
  });

  it("starts at 0 for a whole video without a slice", () => {
    const seg = buildFullPreviewSequence([scene("v", { mediaKind: "video" })]).segments[0]!;
    expect(videoSourceTimeSec(seg, 1200)).toBe(1.2);
  });
});

describe("formatClock", () => {
  it("formats m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_900)).toBe("1:05");
  });
});
