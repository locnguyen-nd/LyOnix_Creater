import { describe, expect, it } from "vitest";
import { computeSegmentSourceRanges, computeSocialWindowRanges, socialWindowOptionsFromEnv, type MediaPlanScene } from "./media-plan.js";

describe("computeSocialWindowRanges (VE2E-53)", () => {
  const scene = (id: string, ms: number): MediaPlanScene => ({ sceneId: id, durationMs: ms });
  const contiguous = (ranges: { sourceStartMs: number; sourceDurationMs: number }[]) =>
    ranges.every((r, i) => i === 0 || r.sourceStartMs === ranges[i - 1]!.sourceStartMs + ranges[i - 1]!.sourceDurationMs);

  it("62 s source, 3 scenes: starts after the start guard, contiguous, no loop", () => {
    const plan = computeSocialWindowRanges([scene("a", 6700), scene("b", 7900), scene("c", 6900)], 62_000)!;
    expect(plan.needsSecondSource).toBe(false);
    expect(plan.ranges[0]!.sourceStartMs).toBe(1000);
    expect(contiguous(plan.ranges)).toBe(true);
    expect(plan.ranges.every((r) => !r.looped && !r.short)).toBe(true);
    const last = plan.ranges[2]!;
    expect(last.sourceStartMs + last.sourceDurationMs).toBeLessThanOrEqual(62_000 - 1500);
    expect(plan.coveredMs).toBe(21_500);
  });

  it("19 s source for 19.9 s need: no overlap, no loop, needs a second source", () => {
    const plan = computeSocialWindowRanges([scene("13", 10_000), scene("14", 9_900)], 19_000)!;
    expect(plan.needsSecondSource).toBe(true);
    expect(plan.ranges.some((r) => r.looped)).toBe(false);
    expect(contiguous(plan.ranges)).toBe(true);
    expect(plan.ranges.at(-1)!.sourceStartMs + plan.ranges.at(-1)!.sourceDurationMs).toBe(17_500);
    expect(plan.coveredMs).toBe(16_500);
    expect(plan.ranges[1]!.short).toBe(true);
    expect(plan.uncoveredSceneIds).toEqual(["14"]);
  });

  it("scenes after the window get no range", () => {
    // 7.5 s source with default guards (1 s start, 1.5 s end) -> usable window is exactly 5 s: scene "a" fills it, "b"/"c" are uncovered.
    const plan = computeSocialWindowRanges([scene("a", 5000), scene("b", 5000), scene("c", 5000)], 7_500)!;
    expect(plan.ranges.map((r) => r.sceneId)).toEqual(["a"]);
    expect(plan.ranges[0]).toMatchObject({ sourceStartMs: 1000, sourceDurationMs: 5000, short: false });
    expect(plan.uncoveredSceneIds).toEqual(["b", "c"]);
    expect(plan.needsSecondSource).toBe(true);
  });

  it("tiny sources (window <= 0) yield no ranges", () => {
    const plan = computeSocialWindowRanges([scene("a", 3000)], 2_000)!;
    expect(plan.ranges).toEqual([]);
    expect(plan.coveredMs).toBe(0);
    expect(plan.needsSecondSource).toBe(true);
  });

  it("custom guards are respected; unknown duration returns null", () => {
    const plan = computeSocialWindowRanges([scene("a", 4000)], 10_000, { startGuardMs: 2000, endGuardMs: 500 })!;
    expect(plan.ranges[0]).toMatchObject({ sourceStartMs: 2000, sourceDurationMs: 4000 });
    expect(computeSocialWindowRanges([scene("a", 4000)], null)).toBeNull();
    expect(computeSocialWindowRanges([scene("a", 4000)], 0)).toBeNull();
  });

  it("non-apify legacy planner is unchanged (still loops at a scene boundary)", () => {
    const ranges = computeSegmentSourceRanges([scene("a", 6000), scene("b", 6000)], 10_000)!;
    expect(ranges[0]!.sourceStartMs).toBe(0);
    expect(ranges[1]).toMatchObject({ sourceStartMs: 0, looped: true });
  });

  it("env overrides guards, invalid values fall back", () => {
    expect(socialWindowOptionsFromEnv({ SOCIAL_CLIP_START_GUARD_MS: "2500", SOCIAL_CLIP_END_GUARD_MS: "abc" })).toEqual({ startGuardMs: 2500, endGuardMs: 1500 });
    expect(socialWindowOptionsFromEnv({})).toEqual({ startGuardMs: 1000, endGuardMs: 1500 });
  });
});
