import { describe, expect, it } from "vitest";
import {
  MEDIA_PLAN_MAX_SEGMENT_MS,
  chooseFallbackSegmentCount,
  computeSegmentSourceRanges,
  fitSegmentsToRange,
  groupScenesByDuration,
  planBackgroundSegments,
  type MediaPlanScene,
  type MediaPlanVisualSegment,
} from "./media-plan.js";

const scenes = (durations: number[]): MediaPlanScene[] => durations.map((durationMs, i) => ({ sceneId: `s${i + 1}`, durationMs }));
const seg = (segmentId: string, sceneIds: string[], priority = 2, en = `kw ${segmentId}`): MediaPlanVisualSegment => ({ segmentId, sceneIds, subject: `subj ${segmentId}`, priority, keywords: { ja: `ja ${segmentId}`, en } });

describe("chooseFallbackSegmentCount", () => {
  it("stays inside the range and the scene count", () => {
    expect(chooseFallbackSegmentCount(60_000, 12, { min: 3, max: 5 })).toBe(3); // 20s avg already <= MAX
    expect(chooseFallbackSegmentCount(90_000, 12, { min: 3, max: 5 })).toBe(5); // 30s avg -> grow until <= 20s or max
    expect(chooseFallbackSegmentCount(25_000, 6, { min: 2, max: 3 })).toBe(2);
    expect(chooseFallbackSegmentCount(60_000, 2, { min: 3, max: 5 })).toBe(2); // only 2 scenes
    expect(chooseFallbackSegmentCount(60_000, 10, { min: 4, max: 4 })).toBe(4); // fixed count
  });

  it("does not grow past the preferred minimum segment length", () => {
    // 20s total: 1 segment is 20s (<= MAX), never grows to 4x5s
    expect(chooseFallbackSegmentCount(MEDIA_PLAN_MAX_SEGMENT_MS, 8, { min: 1, max: 6 })).toBe(1);
  });
});

describe("groupScenesByDuration", () => {
  it("makes consecutive, non-empty, duration-balanced groups covering every scene once", () => {
    const groups = groupScenesByDuration(scenes([5000, 5000, 5000, 5000, 10_000, 10_000]), 3);
    expect(groups.map((g) => g.map((s) => s.sceneId))).toEqual([["s1", "s2", "s3"], ["s4", "s5"], ["s6"]]);
  });

  it("never produces more groups than scenes", () => {
    expect(groupScenesByDuration(scenes([1000, 1000]), 5)).toHaveLength(2);
  });
});

describe("planBackgroundSegments", () => {
  it("uses a valid visual plan as-is when its count fits the range", () => {
    const planned = planBackgroundSegments(scenes([5000, 5000, 5000, 5000]), { segments: [seg("a", ["s1", "s2"], 1), seg("b", ["s3", "s4"])] }, { min: 2, max: 3 });
    expect(planned.map((p) => [p.segmentId, p.sceneIds, p.origin, p.durationMs])).toEqual([["a", ["s1", "s2"], "visual_plan", 10_000], ["b", ["s3", "s4"], "visual_plan", 10_000]]);
    expect(planned[0]!.keywords).toEqual({ ja: "ja a", en: "kw a" });
  });

  it("falls back to deterministic grouping without a plan, or when the plan no longer matches the scenes", () => {
    const list = scenes([6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000]);
    const fallback = planBackgroundSegments(list, null, { min: 3, max: 5 });
    expect(fallback.map((p) => p.segmentId)).toEqual(["seg-1", "seg-2", "seg-3"]);
    expect(fallback.every((p) => p.origin === "fallback" && p.keywords === null)).toBe(true);
    expect(fallback.flatMap((p) => p.sceneIds)).toEqual(list.map((s) => s.sceneId));
    const stale = planBackgroundSegments(list, { segments: [seg("a", ["s1", "s2"])] }, { min: 3, max: 5 });
    expect(stale[0]!.origin).toBe("fallback");
    // deterministic
    expect(planBackgroundSegments(list, null, { min: 3, max: 5 })).toEqual(fallback);
  });

  it("merges the smallest adjacent pair when the plan has too many segments, never splitting the main subject", () => {
    const planned = planBackgroundSegments(
      scenes([3000, 3000, 20_000, 3000, 3000]),
      { segments: [seg("a", ["s1"]), seg("b", ["s2"]), seg("main", ["s3"], 1), seg("c", ["s4"]), seg("d", ["s5"])] },
      { min: 2, max: 3 },
    );
    expect(planned.map((p) => p.sceneIds)).toEqual([["s1", "s2"], ["s3"], ["s4", "s5"]]);
    expect(planned[1]).toMatchObject({ segmentId: "main", priority: 1 });
  });

  it("splits the longest non-main segment when the plan has too few, and keeps a main-subject-only plan whole", () => {
    const planned = planBackgroundSegments(scenes([5000, 5000, 5000, 5000, 5000, 5000]), { segments: [seg("main", ["s1", "s2"], 1), seg("b", ["s3", "s4", "s5", "s6"])] }, { min: 3, max: 5 });
    expect(planned.map((p) => [p.segmentId, p.sceneIds])).toEqual([["main", ["s1", "s2"]], ["b", ["s3", "s4"]], ["b-b", ["s5", "s6"]]]);
    const onlyMain = planBackgroundSegments(scenes([5000, 5000]), { segments: [seg("main", ["s1", "s2"], 1)] }, { min: 2, max: 3 });
    expect(onlyMain.map((p) => p.sceneIds)).toEqual([["s1", "s2"]]);
  });

  it("fitSegmentsToRange is a no-op without a range", () => {
    const list = [{ segmentId: "a", sceneIds: ["s1"], subject: null, priority: null, keywords: null, durationMs: 1, origin: "fallback" as const }];
    expect(fitSegmentsToRange(list, null, new Map())).toBe(list);
  });
});

describe("computeSegmentSourceRanges", () => {
  it("cuts contiguous, non-overlapping ranges by voice duration", () => {
    expect(computeSegmentSourceRanges(scenes([3000, 4500, 2000]), 20_000)).toEqual([
      { sceneId: "s1", sourceStartMs: 0, sourceDurationMs: 3000, looped: false, short: false },
      { sceneId: "s2", sourceStartMs: 3000, sourceDurationMs: 4500, looped: false, short: false },
      { sceneId: "s3", sourceStartMs: 7500, sourceDurationMs: 2000, looped: false, short: false },
    ]);
  });

  it("loops back to 0 at a scene boundary when the source runs out, and caps a scene longer than the whole source", () => {
    expect(computeSegmentSourceRanges(scenes([4000, 4000, 4000]), 10_000)).toEqual([
      { sceneId: "s1", sourceStartMs: 0, sourceDurationMs: 4000, looped: false, short: false },
      { sceneId: "s2", sourceStartMs: 4000, sourceDurationMs: 4000, looped: false, short: false },
      { sceneId: "s3", sourceStartMs: 0, sourceDurationMs: 4000, looped: true, short: false },
    ]);
    expect(computeSegmentSourceRanges(scenes([12_000]), 10_000)).toEqual([{ sceneId: "s1", sourceStartMs: 0, sourceDurationMs: 10_000, looped: false, short: true }]);
  });

  it("every range stays inside the source", () => {
    const ranges = computeSegmentSourceRanges(scenes([7000, 7000, 7000, 7000, 7000]), 15_000)!;
    expect(ranges.every((r) => r.sourceStartMs >= 0 && r.sourceStartMs + r.sourceDurationMs <= 15_000)).toBe(true);
  });

  it("returns null for an unknown/non-positive source duration (photo or legacy asset)", () => {
    expect(computeSegmentSourceRanges(scenes([1000]), null)).toBeNull();
    expect(computeSegmentSourceRanges(scenes([1000]), 0)).toBeNull();
  });
});
