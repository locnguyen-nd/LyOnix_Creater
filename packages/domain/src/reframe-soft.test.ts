import { describe, expect, it } from "vitest";
import { planReframe, reframeOptionsFromEnv, type ExclusionRegion } from "./reframe-plan.js";

const corners = (w: number, h: number, soft: boolean): ExclusionRegion[] => {
  const bw = Math.round(w * 0.3);
  const bh = Math.round(h * 0.1);
  return [
    { kind: "logo", box: { xPx: 0, yPx: 0, widthPx: bw, heightPx: bh }, soft },
    { kind: "logo", box: { xPx: w - bw, yPx: 0, widthPx: bw, heightPx: bh }, soft },
    { kind: "logo", box: { xPx: 0, yPx: h - bh, widthPx: bw, heightPx: bh }, soft },
    { kind: "logo", box: { xPx: w - bw, yPx: h - bh, widthPx: bw, heightPx: bh }, soft },
  ];
};
const subject = { subjectId: "s", kind: "person" as const, samples: [{ tMs: 0, box: { xPx: 200, yPx: 300, widthPx: 320, heightPx: 700 } }] };

describe("soft (preset) overlay regions", () => {
  it("a 9:16 TikTok clip with only preset corners is not 'unavoidable' and zooms at most the soft cap", () => {
    const plan = planReframe({ sourceWidthPx: 720, sourceHeightPx: 1280, durationMs: 4000, subjects: [subject], exclusions: corners(720, 1280, true) }, { maxZoomPermille: 1350 });
    expect(plan.overlayUnavoidable).toBe(false);
    expect(plan.residualOverlayPct).toBe(0);
    expect(plan.zoomPermille).toBeLessThanOrEqual(1150);
    expect(plan.subjectCoveragePct).toBe(100);
  });

  it("the same corners as HARD overlays zoom beyond the soft cap (previous behaviour: more zoom to avoid them)", () => {
    const plan = planReframe({ sourceWidthPx: 720, sourceHeightPx: 1280, durationMs: 4000, subjects: [subject], exclusions: corners(720, 1280, false) }, { maxZoomPermille: 1350 });
    expect(plan.zoomPermille).toBeGreaterThan(1150);
  });

  it("a detected text band stays a hard overlay even next to soft corners", () => {
    const band: ExclusionRegion = { kind: "text", box: { xPx: 0, yPx: 1000, widthPx: 720, heightPx: 120 } };
    const plan = planReframe({ sourceWidthPx: 720, sourceHeightPx: 1280, durationMs: 4000, subjects: [subject], exclusions: [...corners(720, 1280, true), band] }, { maxZoomPermille: 1350 });
    expect(plan.residualOverlayPct).toBeGreaterThanOrEqual(0);
    expect(plan.zoomPermille).toBeGreaterThan(1000);
  });

  it("unavoidableMinPct tolerates a small hard residual", () => {
    const edge: ExclusionRegion = { kind: "text", box: { xPx: 0, yPx: 0, widthPx: 720, heightPx: 60 } };
    const input = { sourceWidthPx: 720, sourceHeightPx: 1280, durationMs: 4000, subjects: [subject], exclusions: [edge] };
    const strict = planReframe(input, { maxZoomPermille: 1000 });
    expect(strict.residualOverlayPct).toBeGreaterThan(0);
    expect(strict.overlayUnavoidable).toBe(true);
    const tolerant = planReframe(input, { maxZoomPermille: 1000, unavoidableMinPct: 100 });
    expect(tolerant.overlayUnavoidable).toBe(false);
    expect(tolerant.residualOverlayPct).toBe(strict.residualOverlayPct);
  });

  it("reads the soft cap and tolerance from the environment", () => {
    expect(reframeOptionsFromEnv({ REFRAME_SOFT_MAX_ZOOM: "1.2", REFRAME_UNAVOIDABLE_MIN_PCT: "15" })).toMatchObject({ softMaxZoomPermille: 1200, unavoidableMinPct: 15 });
    expect(reframeOptionsFromEnv({ REFRAME_SOFT_MAX_ZOOM: "0.5", REFRAME_UNAVOIDABLE_MIN_PCT: "400" })).not.toHaveProperty("softMaxZoomPermille");
  });
});
