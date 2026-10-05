import { describe, expect, it } from "vitest";
import { SUBTITLE_EDIT_LIMITS, mergeWithNext, normalizeCueText, nudgeCue, splitCue, validateSubtitleCues, type SubtitleCue } from "./subtitle-edit.js";

const cues: SubtitleCue[] = [
  { text: "東京の夜景。", startMs: 0, endMs: 1200 },
  { text: "人が多い。", startMs: 1200, endMs: 2400 },
  { text: "Messi plays.", startMs: 2600, endMs: 3600 },
];

describe("validateSubtitleCues (V03-03)", () => {
  it("accepts ordered cues inside the voice and normalizes whitespace", () => {
    const result = validateSubtitleCues([{ text: "  Xin   chào \n bạn ", startMs: 0, endMs: 900 }, ...cues.slice(1)], 3600);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.cues[0]!.text).toBe("Xin chào bạn");
  });

  it("reports every problem with its cue index", () => {
    const result = validateSubtitleCues([
      { text: " ", startMs: 0, endMs: 1000 },
      { text: "ok", startMs: 900, endMs: 1500 },
      { text: "short", startMs: 1500, endMs: 1550 },
      { text: "late", startMs: 1600, endMs: 9000 },
      { text: "x".repeat(SUBTITLE_EDIT_LIMITS.maxCueTextLength + 1), startMs: 9000, endMs: 9100 },
      { text: "float", startMs: 1.5, endMs: 2 },
    ], 3000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      { index: 0, code: "TEXT_EMPTY" },
      { index: 1, code: "OVERLAP" },
      { index: 2, code: "TOO_SHORT" },
      { index: 3, code: "OUT_OF_RANGE" },
      { index: 4, code: "TEXT_TOO_LONG" },
      { index: 5, code: "NOT_INTEGER" },
    ]));
  });

  it("rejects an empty list and tolerates an automatic cue ending a few ms past the measured duration", () => {
    expect(validateSubtitleCues([], 1000)).toEqual({ ok: false, errors: [{ index: -1, code: "NO_CUES" }] });
    expect(validateSubtitleCues("nope", 1000)).toEqual({ ok: false, errors: [{ index: -1, code: "NO_CUES" }] });
    expect(validateSubtitleCues([{ text: "a", startMs: 0, endMs: 1040 }], 1000)).toMatchObject({ ok: true });
  });
});

describe("cue operations (V03-03)", () => {
  it("splits one cue's span in proportion to its characters", () => {
    const split = splitCue(cues, 0, 3); // 東京の | 夜景。
    expect(split).not.toBeNull();
    expect(split!.slice(0, 2)).toEqual([
      { text: "東京の", startMs: 0, endMs: 600 },
      { text: "夜景。", startMs: 600, endMs: 1200 },
    ]);
    expect(split).toHaveLength(4);
  });

  it("refuses a split that leaves an empty side", () => {
    expect(splitCue(cues, 0, 0)).toBeNull();
    expect(splitCue(cues, 0, 99)).toBeNull();
  });

  it("merges with the next cue, adding a space only between word-script words", () => {
    expect(mergeWithNext(cues, 0)![0]).toEqual({ text: "東京の夜景。人が多い。", startMs: 0, endMs: 2400 });
    const latin = mergeWithNext([{ text: "Messi", startMs: 0, endMs: 500 }, { text: "plays", startMs: 500, endMs: 900 }], 0);
    expect(latin![0]!.text).toBe("Messi plays");
    expect(mergeWithNext(cues, 2)).toBeNull();
  });

  it("nudges an edge without overlapping a neighbour or shrinking below the minimum", () => {
    expect(nudgeCue(cues, 1, "end", 100, 3600)[1]).toMatchObject({ endMs: 2500 });
    expect(nudgeCue(cues, 1, "end", 1000, 3600)[1]).toMatchObject({ endMs: 2600 }); // stops at the next cue
    expect(nudgeCue(cues, 1, "start", -100, 3600)[1]).toMatchObject({ startMs: 1200 }); // previous cue ends at 1200
    expect(nudgeCue(cues, 2, "start", 5000, 3600)[2]).toMatchObject({ startMs: 3600 - SUBTITLE_EDIT_LIMITS.minCueMs });
    expect(nudgeCue(cues, 2, "end", 1000, 3600)[2]).toMatchObject({ endMs: 3600 });
  });

  it("normalizes caption text to one run of words", () => {
    expect(normalizeCueText("  a \n\t b ")).toBe("a b");
  });
});
