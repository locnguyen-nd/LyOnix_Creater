import { describe, expect, it } from "vitest";
import { buildCaptionSegmentsFromAlignment, type CharacterAlignment } from "./caption-segmentation.js";

/** Builds a synthetic character alignment for `text`, each character lasting `msPerChar` ms back-to-back, starting at `startMs`. */
const alignmentFor = (text: string, msPerChar = 60, startMs = 0): CharacterAlignment => {
  const characters = text.split("");
  const characterStartTimesSeconds: number[] = [];
  const characterEndTimesSeconds: number[] = [];
  characters.forEach((_, i) => {
    characterStartTimesSeconds.push((startMs + i * msPerChar) / 1000);
    characterEndTimesSeconds.push((startMs + (i + 1) * msPerChar) / 1000);
  });
  return { characters, characterStartTimesSeconds, characterEndTimesSeconds };
};

describe("buildCaptionSegmentsFromAlignment", () => {
  it("returns [] for an unusable/mismatched alignment", () => {
    expect(buildCaptionSegmentsFromAlignment({ characters: [], characterStartTimesSeconds: [], characterEndTimesSeconds: [] })).toEqual([]);
    expect(
      buildCaptionSegmentsFromAlignment({ characters: ["a", "b"], characterStartTimesSeconds: [0], characterEndTimesSeconds: [0.1, 0.2] }),
    ).toEqual([]);
  });

  it("groups a short phrase into a single segment with real start/end timestamps", () => {
    const alignment = alignmentFor("hi there");
    const segments = buildCaptionSegmentsFromAlignment(alignment);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe("hi there");
    expect(segments[0]!.startMs).toBe(0);
    // last character of "hi there" is index 7, ends at (7+1)*60 = 480ms
    expect(segments[0]!.endMs).toBe(480);
  });

  it("never invents timestamps: every segment boundary matches an actual character time", () => {
    const alignment = alignmentFor("one two three four five six seven eight nine ten", 50);
    const segments = buildCaptionSegmentsFromAlignment(alignment, { maxCharsPerSegment: 12 });
    expect(segments.length).toBeGreaterThan(1);
    const validStarts = new Set(alignment.characterStartTimesSeconds.map((s) => Math.round(s * 1000)));
    const validEnds = new Set(alignment.characterEndTimesSeconds.map((e) => Math.round(e * 1000)));
    for (const segment of segments) {
      expect(validStarts.has(segment.startMs)).toBe(true);
      expect(validEnds.has(segment.endMs)).toBe(true);
      expect(segment.text.length).toBeLessThanOrEqual(12 + 10); // a lone overlong word may still exceed the cap
    }
  });

  it("breaks a segment when the max duration cap would be exceeded even if under the char cap", () => {
    const alignment = alignmentFor("a b c d e f g h", 500); // 500ms per character -> long word durations
    const segments = buildCaptionSegmentsFromAlignment(alignment, { maxCharsPerSegment: 100, maxDurationMs: 1000 });
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(1000);
    }
  });

  it("keeps a single very long word as its own segment instead of splitting characters", () => {
    const alignment = alignmentFor("supercalifragilisticexpialidocious", 30);
    const segments = buildCaptionSegmentsFromAlignment(alignment, { maxCharsPerSegment: 10 });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe("supercalifragilisticexpialidocious");
  });

  it("closes a segment at sentence-terminal punctuation even when well under the char/duration caps", () => {
    const alignment = alignmentFor("Hi there. How are you?", 60);
    const segments = buildCaptionSegmentsFromAlignment(alignment);
    expect(segments.map((s) => s.text)).toEqual(["Hi there.", "How are you?"]);
  });

  it("still applies the char/duration cap fallback inside one long run-on sentence with no punctuation", () => {
    const alignment = alignmentFor("one two three four five six seven eight nine ten", 50);
    const segments = buildCaptionSegmentsFromAlignment(alignment, { maxCharsPerSegment: 12 });
    expect(segments.length).toBeGreaterThan(1);
  });

  it("segments are ordered and non-overlapping (monotonic time)", () => {
    const alignment = alignmentFor("the quick brown fox jumps over the lazy dog again and again", 40);
    const segments = buildCaptionSegmentsFromAlignment(alignment, { maxCharsPerSegment: 20 });
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.startMs).toBeGreaterThanOrEqual(segments[i - 1]!.endMs);
    }
  });
});
