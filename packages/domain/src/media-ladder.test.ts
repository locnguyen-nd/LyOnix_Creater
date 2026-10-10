import { describe, expect, it, vi } from "vitest";
import { findFreeWindow, gateTiers, kenBurnsFor, mediaSegmentDeadlineMs, mediaTierMode, parseSegmentKeywords, raceByPriority, segmentTierKeywords } from "./media-ladder.js";

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

describe("mediaTierMode", () => {
  it("defaults to race and ignores anything unknown", () => {
    expect(mediaTierMode({})).toBe("race");
    expect(mediaTierMode({ MEDIA_TIER_MODE: "" })).toBe("race");
    expect(mediaTierMode({ MEDIA_TIER_MODE: "bogus" })).toBe("race");
    expect(mediaTierMode({ MEDIA_TIER_MODE: " Sequential " })).toBe("sequential");
    expect(mediaTierMode({ MEDIA_TIER_MODE: "cheap_first" })).toBe("cheap_first");
  });
});

describe("gateTiers", () => {
  const specs = [
    { name: "ja", paid: true, social: false },
    { name: "en", paid: true, social: false },
    { name: "shorts", paid: false, social: true },
    { name: "broad", paid: true, social: false },
    { name: "pexels", paid: false, social: false },
  ];
  /** Runs the tiers through gateTiers + raceByPriority; `calls` lists the tiers that really ran. */
  const run = async (mode: "race" | "sequential" | "cheap_first", answers: Record<string, string | null>, deadline = 1000, delays: Record<string, number> = {}) => {
    const calls: string[] = [];
    const tasks = specs.map((spec) => async () => {
      calls.push(spec.name);
      await new Promise((resolve) => setTimeout(resolve, delays[spec.name] ?? 5));
      return answers[spec.name] ?? null;
    });
    const winner = await raceByPriority(gateTiers(mode, specs, tasks, deadline), deadline);
    await new Promise((resolve) => setTimeout(resolve, 60)); // let gated tasks that were skipped settle
    return { winner: winner?.value ?? null, calls };
  };

  it("race starts every tier at once (the old behaviour)", async () => {
    const out = await run("race", { ja: "ja-clip", en: "en-clip", pexels: "stock" });
    expect(out.winner).toBe("ja-clip");
    expect([...out.calls].sort()).toEqual(["broad", "en", "ja", "pexels", "shorts"]);
  });

  it("sequential: a winning ja pays for nothing else; the free tiers still start at once", async () => {
    const out = await run("sequential", { ja: "ja-clip", en: "en-clip" });
    expect(out.winner).toBe("ja-clip");
    expect(out.calls).toContain("shorts");
    expect(out.calls).toContain("pexels");
    expect(out.calls).not.toContain("en");
    expect(out.calls).not.toContain("broad");
  });

  it("sequential: a paid tier runs only after the better ones came back empty", async () => {
    const out = await run("sequential", { en: "en-clip" });
    expect(out.winner).toBe("en-clip");
    expect(out.calls.indexOf("ja")).toBeLessThan(out.calls.indexOf("en"));
    expect(out.calls).not.toContain("broad");
  });

  it("sequential: falls down to the last paid tier, then Pexels, when every search is empty", async () => {
    expect((await run("sequential", { pexels: "stock" })).winner).toBe("stock");
    expect((await run("sequential", { broad: "broad-clip", pexels: "stock" })).winner).toBe("broad-clip");
    expect((await run("sequential", {})).winner).toBeNull();
  });

  it("sequential: a free tier ranked above a paid one (shorts above broad) spares that paid search", async () => {
    const out = await run("sequential", { shorts: "short-clip" });
    expect(out.winner).toBe("short-clip");
    expect(out.calls).not.toContain("broad");
    expect(out.calls).toContain("ja");
    expect(out.calls).toContain("en");
  });

  it("cheap_first: a free social clip means no paid search at all", async () => {
    const out = await run("cheap_first", { shorts: "short-clip", ja: "ja-clip" });
    expect(out.winner).toBe("short-clip");
    expect(out.calls.filter((name) => ["ja", "en", "broad"].includes(name))).toEqual([]);
  });

  it("cheap_first: with no social clip it falls back to the paid tiers one at a time", async () => {
    const out = await run("cheap_first", { en: "en-clip" });
    expect(out.winner).toBe("en-clip");
    expect(out.calls.indexOf("ja")).toBeLessThan(out.calls.indexOf("en"));
    expect(out.calls).not.toContain("broad");
  });

  it("a tier that throws counts as empty and never blocks the next paid tier", async () => {
    const tasks = [
      async () => { throw new Error("boom"); },
      async () => "en-clip",
    ];
    const winner = await raceByPriority(gateTiers("sequential", [{ name: "ja", paid: true, social: false }, { name: "en", paid: true, social: false }], tasks, 1000), 1000);
    expect(winner?.value).toBe("en-clip");
  });

  it("never starts a paid search once the deadline has passed (the race is over, the money would be wasted)", async () => {
    const calls: string[] = [];
    let clock = 0;
    const tasks = [
      async () => { calls.push("ja"); clock = 500; return null; },
      async () => { calls.push("en"); return "en-clip"; },
    ];
    const gated = gateTiers("sequential", [{ name: "ja", paid: true, social: false }, { name: "en", paid: true, social: false }], tasks, 400, () => clock);
    await Promise.all(gated.map((task) => task()));
    expect(calls).toEqual(["ja"]);
  });
});
