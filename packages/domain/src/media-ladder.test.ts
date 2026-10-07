import { describe, expect, it, vi } from "vitest";
import { findFreeWindow, kenBurnsFor, mediaSegmentDeadlineMs, parseSegmentKeywords, raceByPriority, segmentTierKeywords } from "./media-ladder.js";

const later = <T>(ms: number, value: T | null) => () => new Promise<T | null>((resolve) => setTimeout(() => resolve(value), ms));
const fails = (ms: number) => () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("boom")), ms));

describe("parseSegmentKeywords", () => {
  it("reads the legacy {ja,en} format", () => {
    expect(parseSegmentKeywords({ ja: "東京 夜景", en: "tokyo night" })).toEqual({ ja: ["東京 夜景"], en: ["tokyo night"], broad: [], mood: null });
  });
  it("reads the multi-tier format (arrays, snake/camel aliases) and ignores junk", () => {
    expect(parseSegmentKeywords({ ja: ["大谷翔平", " 大谷翔平 ", 3], en: ["Ohtani"], broad_en: ["baseball homerun"], mood_en: "stadium night" })).toEqual({ ja: ["大谷翔平"], en: ["Ohtani"], broad: ["baseball homerun"], mood: "stadium night" });
    expect(parseSegmentKeywords({ broadEn: "x", moodEn: "y" })).toMatchObject({ broad: ["x"], mood: "y" });
    expect(parseSegmentKeywords(null)).toEqual({ ja: [], en: [], broad: [], mood: null });
  });
});

describe("segmentTierKeywords", () => {
  it("orders ja > en > broad, falls back to the subject for broad, never to mood, and drops duplicates", () => {
    expect(segmentTierKeywords({ ja: "大谷", en: "Ohtani", mood_en: "city night" }, "Shohei Ohtani")).toEqual([
      { tier: "ja", keyword: "大谷" },
      { tier: "en", keyword: "Ohtani" },
      { tier: "broad", keyword: "Shohei Ohtani" },
    ]);
    expect(segmentTierKeywords({ ja: "x", en: "x" }, null)).toEqual([{ tier: "ja", keyword: "x" }]);
    expect(segmentTierKeywords({ mood_en: "city night" }, null)).toEqual([]);
  });
  it("skips an invalid ja keyword but keeps the other tiers", () => {
    const out = segmentTierKeywords({ ja: ["english only"], en: "tokyo" }, null, (v) => /[ぁ-んァ-ン一-龥]/.test(v));
    expect(out).toEqual([{ tier: "en", keyword: "tokyo" }]);
  });
});

describe("mediaSegmentDeadlineMs", () => {
  it("defaults to 75 s and honours the env", () => {
    expect(mediaSegmentDeadlineMs({})).toBe(75_000);
    expect(mediaSegmentDeadlineMs({ MEDIA_SEGMENT_DEADLINE_MS: "1200" })).toBe(1200);
    expect(mediaSegmentDeadlineMs({ MEDIA_SEGMENT_DEADLINE_MS: "abc" })).toBe(75_000);
  });
});

describe("raceByPriority", () => {
  it("waits for the higher-priority tier when it is still running, then picks it over a faster lower tier", async () => {
    const result = await raceByPriority([later(40, "ja"), later(5, "en"), later(1, "pexels")], 1000);
    expect(result).toEqual({ index: 0, value: "ja" });
  });
  it("moves on as soon as every higher-priority tier finished empty/failed", async () => {
    const started = Date.now();
    const result = await raceByPriority([later(5, null), fails(5), later(10, "broad"), later(500, "pexels")], 1000);
    expect(result).toEqual({ index: 2, value: "broad" });
    expect(Date.now() - started).toBeLessThan(300);
  });
  it("at the deadline takes the best tier that already has a value and discards the rest (also late ones)", async () => {
    const discarded = vi.fn();
    const result = await raceByPriority([later(400, "ja"), later(5, "en"), later(10, "pexels")], 60, discarded);
    expect(result).toEqual({ index: 1, value: "en" });
    expect(discarded).toHaveBeenCalledWith(2, "pexels");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(discarded).toHaveBeenCalledWith(0, "ja");
  });
  it("returns null when nothing produced a value (all empty, or deadline with none)", async () => {
    expect(await raceByPriority([later(1, null), fails(1)], 100)).toBeNull();
    expect(await raceByPriority([later(300, "late")], 30)).toBeNull();
    expect(await raceByPriority([], 30)).toBeNull();
  });
});

describe("findFreeWindow (L4)", () => {
  it("returns the first gap that fits, outside windows used by other segments", () => {
    const pick = findFreeWindow([{ id: "a", durationMs: 30_000, usedWindows: [{ startMs: 0, endMs: 10_000 }] }], 8_000);
    expect(pick).toEqual({ clipId: "a", startMs: 10_000, durationMs: 8_000, full: true });
  });
  it("respects start/end guards and prefers a full fit on a later clip over a partial gap", () => {
    const pick = findFreeWindow(
      [
        { id: "a", durationMs: 12_000, usedWindows: [{ startMs: 1_000, endMs: 7_000 }], startGuardMs: 1_000, endGuardMs: 1_500 },
        { id: "b", durationMs: 20_000, usedWindows: [] },
      ],
      8_000,
    );
    expect(pick).toMatchObject({ clipId: "b", startMs: 0, full: true });
  });
  it("falls back to the largest partial gap (>= 60% of the need) and returns null when nothing is free", () => {
    const partial = findFreeWindow([{ id: "a", durationMs: 14_000, usedWindows: [{ startMs: 0, endMs: 9_000 }] }], 8_000);
    expect(partial).toEqual({ clipId: "a", startMs: 9_000, durationMs: 5_000, full: false });
    expect(findFreeWindow([{ id: "a", durationMs: 10_000, usedWindows: [{ startMs: 0, endMs: 9_000 }] }], 8_000)).toBeNull();
    expect(findFreeWindow([], 5_000)).toBeNull();
  });
});

describe("kenBurnsFor (L5)", () => {
  it("is deterministic, cycles presets and carries the duration", () => {
    expect(kenBurnsFor(0, 4_200)).toEqual({ zoomFrom: 1, zoomTo: 1.15, fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5, durationMs: 4_200 });
    expect(kenBurnsFor(4, 1000).zoomTo).toBe(kenBurnsFor(0, 1000).zoomTo);
    expect(kenBurnsFor(1, 1000).zoomFrom).toBeGreaterThan(kenBurnsFor(1, 1000).zoomTo);
  });
});
