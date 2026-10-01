import { describe, expect, it } from "vitest";
import type { TimelineSegmentResponse } from "@lyonix/contracts";
import { applyShortsPlan, planShortsFromSource, segmentDurations } from "./auto-shorts";

describe("planShortsFromSource", () => {
  it("spreads one window per segment evenly across the usable span without overlap", () => {
    const plan = planShortsFromSource({ segments: [{ segmentId: "a", durationMs: 10_000 }, { segmentId: "b", durationMs: 10_000 }, { segmentId: "c", durationMs: 10_000 }], sourceDurationMs: 600_000 });
    expect(plan.needsMoreSource).toBe(false);
    expect(plan.windows.every((w) => w.fits)).toBe(true);
    const [a, b, c] = plan.windows;
    expect(a!.startMs).toBeGreaterThanOrEqual(1000);
    expect(b!.startMs).toBeGreaterThanOrEqual(a!.startMs + 10_000);
    expect(c!.startMs).toBeGreaterThanOrEqual(b!.startMs + 10_000);
    expect(c!.startMs + 10_000).toBeLessThanOrEqual(600_000 - 1500);
    expect(b!.startMs - a!.startMs).toBeGreaterThan(100_000); // spread, not packed at the start
  });

  it("packs back to back and flags the shortfall when the source is too short", () => {
    const plan = planShortsFromSource({ segments: [{ segmentId: "a", durationMs: 10_000 }, { segmentId: "b", durationMs: 10_000 }], sourceDurationMs: 15_000 });
    expect(plan.needsMoreSource).toBe(true);
    expect(plan.windows[0]).toMatchObject({ segmentId: "a", startMs: 1000, fits: true });
    expect(plan.windows[1]!.fits).toBe(false);
    expect(plan.windows[1]!.startMs + plan.windows[1]!.durationMs).toBeLessThanOrEqual(15_000 - 1500);
  });

  it("returns an empty plan without segments", () => {
    expect(planShortsFromSource({ segments: [], sourceDurationMs: 60_000 }).windows).toEqual([]);
  });
});

describe("applyShortsPlan", () => {
  const scene = (sceneId: string, segmentId: string, sourceDurationMs: number | null) => ({
    sceneId, segmentId, sourceDurationMs, sourceStartMs: null, mediaAssetVersionId: null, audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false,
  });
  const segments: TimelineSegmentResponse[] = [
    { segmentId: "s1", sceneIds: ["a", "b"], mediaAssetVersionId: null, subject: null, priority: null },
    { segmentId: "s2", sceneIds: ["c"], mediaAssetVersionId: null, subject: null, priority: null },
  ];
  const scenes = [scene("a", "s1", 4000), scene("b", "s1", 6000), scene("c", "s2", null)];
  const fallback = (id: string) => (id === "c" ? 5000 : 3000);

  it("binds each segment to its window with contiguous per-scene ranges", () => {
    const durations = segmentDurations(scenes, segments, fallback);
    expect(durations).toEqual([{ segmentId: "s1", durationMs: 10_000 }, { segmentId: "s2", durationMs: 5000 }]);
    const plan = planShortsFromSource({ segments: durations, sourceDurationMs: 300_000 });
    const next = applyShortsPlan(scenes, segments, { id: "long-1", durationMs: 300_000 }, plan, fallback);
    const byId = Object.fromEntries(next.scenes.map((s) => [s.sceneId, s]));
    expect(byId.a).toMatchObject({ mediaAssetVersionId: "long-1", sourceStartMs: plan.windows[0]!.startMs, sourceDurationMs: 4000 });
    expect(byId.b).toMatchObject({ sourceStartMs: plan.windows[0]!.startMs + 4000, sourceDurationMs: 6000 });
    expect(byId.c).toMatchObject({ mediaAssetVersionId: "long-1", sourceStartMs: plan.windows[1]!.startMs, sourceDurationMs: 5000 });
    expect(next.segments.every((s) => s.mediaAssetVersionId === "long-1")).toBe(true);
  });
});
