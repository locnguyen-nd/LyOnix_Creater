import { describe, expect, it } from "vitest";
import { computeWindowRangesWithLoopFallback, deriveSceneVisualKinds, splitSegmentsByVisualKind } from "./media-plan-kinds.js";
import { computeSegmentSourceRanges, type PlannedSegment } from "./media-plan.js";

const scenes = (...ms: number[]) => ms.map((durationMs, index) => ({ sceneId: `s${index + 1}`, durationMs }));
const ids = (n: number) => Array.from({ length: n }, (_, index) => `s${index + 1}`);

describe("deriveSceneVisualKinds", () => {
  it("maps scenes to the template's ordered visual slots and repeats the pattern for extra scenes", () => {
    const kinds = deriveSceneVisualKinds(["image", "video", "video", "text", "audio"], ids(7));
    expect([...kinds!.values()]).toEqual(["image", "video", "video", "image", "video", "video", "image"]);
  });

  it("a video-only template keeps every scene video; no visual slot means no kind info", () => {
    expect([...deriveSceneVisualKinds(["video", "video", "audio"], ids(3))!.values()]).toEqual(["video", "video", "video"]);
    expect(deriveSceneVisualKinds(["text", "audio"], ids(3))).toBeNull();
    expect(deriveSceneVisualKinds(["video"], [])).toBeNull();
  });
});

describe("splitSegmentsByVisualKind", () => {
  const segment = (segmentId: string, sceneIds: string[]): PlannedSegment => ({ segmentId, sceneIds, subject: "x", priority: 1, keywords: null, durationMs: 99, origin: "fallback" });
  const durations = new Map(ids(6).map((id) => [id, 5000] as const));

  it("never lets one segment mix an image scene with a video scene", () => {
    const kinds = deriveSceneVisualKinds(["image", "video", "video"], ids(6))!; // i v v i v v
    const out = splitSegmentsByVisualKind([segment("seg-1", ["s1", "s2", "s3"]), segment("seg-2", ["s4", "s5", "s6"])], kinds, durations);
    expect(out.map((s) => [s.segmentId, s.sceneIds, s.visualKind, s.durationMs])).toEqual([
      ["seg-1", ["s1"], "image", 5000],
      ["seg-1-k2", ["s2", "s3"], "video", 10_000],
      ["seg-2", ["s4"], "image", 5000],
      ["seg-2-k2", ["s5", "s6"], "video", 10_000],
    ]);
  });

  it("leaves a single-kind segment intact (id and duration) and only tags its kind", () => {
    const kinds = deriveSceneVisualKinds(["video"], ids(3))!;
    const out = splitSegmentsByVisualKind([segment("seg-1", ["s1", "s2", "s3"])], kinds, durations);
    expect(out).toEqual([{ ...segment("seg-1", ["s1", "s2", "s3"]), visualKind: "video" }]);
  });
});

describe("computeWindowRangesWithLoopFallback (no replayed opening seconds)", () => {
  it("covers every scene with distinct, non-overlapping ranges when the clip is long enough", () => {
    const plan = computeWindowRangesWithLoopFallback(scenes(6000, 5000, 4000), 30_000, { startGuardMs: 0, endGuardMs: 0 })!;
    expect(plan.needsSecondSource).toBe(false);
    expect(plan.ranges.map((r) => [r.sourceStartMs, r.sourceDurationMs, r.looped])).toEqual([[0, 6000, false], [6000, 5000, false], [11_000, 4000, false]]);
  });

  it("the old stock-clip policy replayed scene 1's footage in scene 3; the new plan flags a second source instead", () => {
    // Real job e87d7e32 seg-3: Pexels clip of 15 s, scenes of 6037 + 5155 + 3901 ms.
    const sceneList = scenes(6037, 5155, 3901);
    const old = computeSegmentSourceRanges(sceneList, 15_000)!;
    expect(old[2]!.sourceStartMs).toBe(0); // restart at 0 = the first scene's footage again
    const next = computeWindowRangesWithLoopFallback(sceneList, 15_000, { startGuardMs: 0, endGuardMs: 0 })!;
    expect(next.needsSecondSource).toBe(true);
    expect(next.uncoveredSceneIds).toContain("s3");
  });

  it("when no second source exists, uncovered scenes are laid out one after another instead of all restarting at the same start", () => {
    const plan = computeWindowRangesWithLoopFallback(scenes(3000, 3000, 3000, 3000, 3000, 3000), 10_000, { startGuardMs: 1000, endGuardMs: 1000 })!; // usable [1000, 9000]
    expect(plan.ranges.map((r) => r.sourceStartMs)).toEqual([1000, 4000, 7000, 1000, 4000, 1000]);
    expect(plan.ranges[2]!.sourceDurationMs).toBe(2000); // the scene the window could only partly cover
    expect(plan.ranges.filter((r) => r.looped).map((r) => r.sceneId)).toEqual(["s4", "s5", "s6"]);
    expect(plan.ranges.every((r) => r.sourceStartMs >= 1000 && r.sourceStartMs + r.sourceDurationMs <= 9000)).toBe(true);
  });

  it("returns null for an unknown source duration (caller keeps the legacy no-range binding)", () => {
    expect(computeWindowRangesWithLoopFallback(scenes(3000), null)).toBeNull();
  });
});
