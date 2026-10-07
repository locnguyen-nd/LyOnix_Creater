import { describe, expect, it } from "vitest";
import { DEFAULT_SUBJECT_SHARE_TARGET, mainSubjectShare, planBackgroundSegments, subjectShareTargetFromEnv, type MediaPlanScene, type MediaPlanVisualSegment } from "./media-plan.js";

const scenes = (durations: number[]): MediaPlanScene[] => durations.map((durationMs, i) => ({ sceneId: `s${i + 1}`, durationMs }));
const seg = (segmentId: string, sceneIds: string[], priority: number, keywords: MediaPlanVisualSegment["keywords"] = { ja: "", en: "x" }): MediaPlanVisualSegment => ({ segmentId, sceneIds, subject: segmentId, priority, keywords });

describe("PlannedSegment.keywords (VE2E-88)", () => {
  it("legacy {ja,en} stays exactly {ja,en}", () => {
    const [a] = planBackgroundSegments(scenes([5000, 5000]), { segments: [seg("a", ["s1", "s2"], 1, { ja: "渋谷", en: "shibuya" })] }, null);
    expect(a!.keywords).toEqual({ ja: "渋谷", en: "shibuya" });
  });
  it("carries tiers + video subject additively", () => {
    const [a] = planBackgroundSegments(
      scenes([5000, 5000]),
      { segments: [seg("a", ["s1", "s2"], 1, { ja: "エムバペ", en: "Mbappe", enAll: ["Mbappe"], broadEn: ["Mbappe highlights"], moodEn: "night" })], videoSubject: { main: "Mbappe", aliases: ["エムバペ"], mustExclude: ["Haaland"] } },
      null,
    );
    expect(a!.keywords).toEqual({ ja: "エムバペ", en: "Mbappe", enAll: ["Mbappe"], broadEn: ["Mbappe highlights"], moodEn: "night", subject: "Mbappe", aliases: ["エムバペ"], mustExclude: ["Haaland"] });
  });
});

describe("weighted subject allocation (VE2E-88)", () => {
  const plan = { segments: [seg("a", ["s1", "s2"], 1), seg("b", ["s3", "s4", "s5", "s6"], 2), seg("c", ["s7", "s8"], 3)] };
  const sc = scenes([5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);

  it("is a no-op unless a target is passed (pre-88 behaviour)", () => {
    expect(mainSubjectShare(planBackgroundSegments(sc, plan, null))).toBeCloseTo(0.25);
  });
  it("grows the main subject toward the target, keeps order/coverage and leaves each other segment >= 1 scene", () => {
    const out = planBackgroundSegments(sc, plan, null, { subjectShareTarget: 0.6 });
    expect(mainSubjectShare(out)).toBeGreaterThanOrEqual(0.6);
    expect(out.flatMap((s) => s.sceneIds)).toEqual(sc.map((s) => s.sceneId));
    expect(out.every((s) => s.sceneIds.length >= 1)).toBe(true);
    expect(out.reduce((n, s) => n + s.durationMs, 0)).toBe(40_000);
  });
  it("stops when it cannot move more without emptying other segments", () => {
    const out = planBackgroundSegments(sc, plan, null, { subjectShareTarget: 0.95 });
    expect(out.every((s) => s.sceneIds.length >= 1)).toBe(true);
    expect(out[0]!.sceneIds.length).toBe(5);
  });
  it("no main segment or fallback grouping = untouched", () => {
    const out = planBackgroundSegments(sc, null, null, { subjectShareTarget: 0.6 });
    expect(out.every((s) => s.origin === "fallback")).toBe(true);
  });
  it("reads the target from env with a 60% default", () => {
    expect(subjectShareTargetFromEnv({})).toBe(DEFAULT_SUBJECT_SHARE_TARGET);
    expect(subjectShareTargetFromEnv({ SUBJECT_SHARE_TARGET: "70" })).toBeCloseTo(0.7);
    expect(subjectShareTargetFromEnv({ SUBJECT_SHARE_TARGET: "0.5" })).toBe(0.5);
    expect(subjectShareTargetFromEnv({ SUBJECT_SHARE_TARGET: "abc" })).toBe(0.6);
    expect(subjectShareTargetFromEnv({ SUBJECT_SHARE_TARGET: "500" })).toBe(0.95);
  });
});
