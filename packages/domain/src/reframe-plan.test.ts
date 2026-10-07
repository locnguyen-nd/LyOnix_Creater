import { describe, expect, it } from "vitest";
import { planReframe, reframeOptionsFromEnv, type ExclusionRegion, type PixelBox, type SubjectTrack } from "./reframe-plan.js";

const box = (xPx: number, yPx: number, widthPx: number, heightPx: number): PixelBox => ({ xPx, yPx, widthPx, heightPx });
const still = (id: string, b: PixelBox): SubjectTrack => ({ subjectId: id, kind: "person", samples: [{ tMs: 0, box: b }] });
const inside = (outer: PixelBox, inner: PixelBox) =>
  inner.xPx >= outer.xPx && inner.yPx >= outer.yPx && inner.xPx + inner.widthPx <= outer.xPx + outer.widthPx && inner.yPx + inner.heightPx <= outer.yPx + outer.heightPx;
const overlaps = (a: PixelBox, b: PixelBox) => a.xPx < b.xPx + b.widthPx && b.xPx < a.xPx + a.widthPx && a.yPx < b.yPx + b.heightPx && b.yPx < a.yPx + a.heightPx;
const win = (k: { xPx: number; yPx: number; widthPx: number; heightPx: number }) => box(k.xPx, k.yPx, k.widthPx, k.heightPx);

describe("planReframe (VE2E-65)", () => {
  it("off-centre subject in a 16:9 source: static 1.0x window centred on the subject, aspect 9:16", () => {
    const subject = box(1400, 300, 200, 500);
    const plan = planReframe({ sourceWidthPx: 1920, sourceHeightPx: 1080, subjects: [still("a", subject)] });
    expect(plan.mode).toBe("static");
    expect(plan.zoomPermille).toBe(1000);
    const k = plan.keyframes[0]!;
    expect([k.widthPx, k.heightPx]).toEqual([607, 1080]);
    expect(k.xPx).toBe(1197);
    expect(inside(win(k), subject)).toBe(true);
    expect(plan).toMatchObject({ overlayUnavoidable: false, residualOverlayPct: 0, subjectCoveragePct: 100, primarySubjectId: "a" });
  });

  it("corner logo: pans away from it without zooming", () => {
    const logo: ExclusionRegion = { kind: "logo", box: box(1500, 20, 380, 120) };
    const plan = planReframe({ sourceWidthPx: 1920, sourceHeightPx: 1080, subjects: [still("a", box(1000, 300, 300, 600))], exclusions: [logo] });
    expect(plan.zoomPermille).toBe(1000);
    expect(overlaps(win(plan.keyframes[0]!), logo.box)).toBe(false);
    expect(plan).toMatchObject({ overlayUnavoidable: false, subjectCoveragePct: 100 });
  });

  it("bottom lower-third band: zooms just enough and keeps the window above the band", () => {
    const band: ExclusionRegion = { kind: "text", box: box(0, 880, 1920, 200) };
    const subject = box(800, 200, 300, 500);
    const plan = planReframe({ sourceWidthPx: 1920, sourceHeightPx: 1080, subjects: [still("a", subject)], exclusions: [band] });
    expect(plan.zoomPermille).toBe(1250);
    const k = plan.keyframes[0]!;
    expect(k.yPx + k.heightPx).toBeLessThanOrEqual(880);
    expect(inside(win(k), subject)).toBe(true);
    expect(plan.overlayUnavoidable).toBe(false);
  });

  it("multiple people: bigger/longer-lived track is primary; preferredSubjectId overrides", () => {
    const big = still("big", box(300, 200, 300, 700));
    const small = still("small", box(1500, 400, 100, 250));
    const input = { sourceWidthPx: 1920, sourceHeightPx: 1080, subjects: [small, big] };
    const auto = planReframe(input);
    expect(auto.primarySubjectId).toBe("big");
    expect(auto.keyframes[0]!.xPx).toBeLessThan(500);
    const forced = planReframe(input, { preferredSubjectId: "small" });
    expect(forced.primarySubjectId).toBe("small");
    expect(forced.keyframes[0]!.xPx).toBeGreaterThan(1200);
    expect(planReframe(input).primarySubjectId).toBe("big");
    expect(planReframe({ ...input, subjects: [still("b", box(0, 0, 100, 100)), still("a", box(0, 0, 100, 100))] }).primarySubjectId).toBe("a");
  });

  it("already-portrait source with a corner logo: only zoom-in can avoid it", () => {
    const logo: ExclusionRegion = { kind: "logo", box: box(0, 0, 300, 120) };
    const subject = box(340, 600, 400, 800);
    const plan = planReframe({ sourceWidthPx: 1080, sourceHeightPx: 1920, subjects: [still("a", subject)], exclusions: [logo] });
    expect(plan.zoomPermille).toBe(1100);
    const k = plan.keyframes[0]!;
    expect([k.widthPx, k.heightPx]).toEqual([981, 1745]);
    expect(overlaps(win(k), logo.box)).toBe(false);
    expect(inside(win(k), subject)).toBe(true);
    expect(plan.overlayUnavoidable).toBe(false);
  });

  it("already-portrait source, no overlay: window is the full frame", () => {
    const plan = planReframe({ sourceWidthPx: 1080, sourceHeightPx: 1920, subjects: [still("a", box(300, 500, 400, 900))] });
    expect(plan.keyframes).toEqual([{ tMs: 0, xPx: 0, yPx: 0, widthPx: 1080, heightPx: 1920 }]);
    expect(plan.zoomPermille).toBe(1000);
  });

  it("unavoidable overlay: flagged with the residual percentage, zoom never above the cap", () => {
    const logo: ExclusionRegion = { kind: "text", box: box(340, 800, 400, 300) };
    const plan = planReframe({ sourceWidthPx: 1080, sourceHeightPx: 1920, subjects: [still("a", box(300, 700, 480, 600))], exclusions: [logo] }, { maxZoomPermille: 1350 });
    expect(plan.overlayUnavoidable).toBe(true);
    expect(plan.residualOverlayPct).toBeGreaterThan(0);
    expect(plan.residualOverlayPct).toBeLessThanOrEqual(100);
    expect(plan.zoomPermille).toBeLessThanOrEqual(1350);
  });

  it("zoom cap comes from options: a lower cap turns an avoidable band into unavoidable", () => {
    const input = { sourceWidthPx: 1920, sourceHeightPx: 1080, subjects: [still("a", box(800, 200, 300, 500))], exclusions: [{ kind: "text" as const, box: box(0, 880, 1920, 200) }] };
    const capped = planReframe(input, { maxZoomPermille: 1100 });
    expect(capped.overlayUnavoidable).toBe(true);
    expect(capped.zoomPermille).toBeLessThanOrEqual(1100);
    expect(capped.residualOverlayPct).toBeLessThan(100);
  });

  it("moving subject: keyframed, smoothed, pan speed limited, subject stays in frame", () => {
    const track: SubjectTrack = {
      subjectId: "a",
      kind: "person",
      samples: [0, 1, 2, 3, 4].map((i) => ({ tMs: i * 1000, box: box(800 + i * 60, 300, 200, 500) })),
    };
    const plan = planReframe({ sourceWidthPx: 1920, sourceHeightPx: 1080, subjects: [track] });
    expect(plan.mode).toBe("keyframes");
    expect(plan.subjectCoveragePct).toBe(100);
    const ks = plan.keyframes;
    for (let i = 1; i < ks.length; i += 1) {
      expect(ks[i]!.xPx).toBeGreaterThanOrEqual(ks[i - 1]!.xPx);
      expect(ks[i]!.xPx - ks[i - 1]!.xPx).toBeLessThanOrEqual(Math.floor((607 * 60) / 100));
    }
  });

  it("starts a moving crop at t=0 when the first detector sample is later", () => {
    const track: SubjectTrack = {
      subjectId: "late",
      kind: "person",
      samples: [296, 888, 1480, 2072].map((tMs, i) => ({ tMs, box: box(100 + i * 400, 300, 200, 500) })),
    };
    const plan = planReframe({ sourceWidthPx: 1920, sourceHeightPx: 1080, durationMs: 2400, subjects: [track] });
    expect(plan.mode).toBe("keyframes");
    expect(plan.keyframes[0]!.tMs).toBe(0);
    expect(plan.keyframes.map((frame) => frame.tMs)).toEqual([...new Set(plan.keyframes.map((frame) => frame.tMs))]);
  });

  it("overlay active only for part of the clip is dodged during that part", () => {
    const track: SubjectTrack = { subjectId: "a", kind: "person", samples: [{ tMs: 0, box: box(1300, 300, 200, 500) }, { tMs: 4000, box: box(1300, 300, 200, 500) }] };
    const logo: ExclusionRegion = { kind: "logo", box: box(1500, 0, 400, 150), startMs: 2000, endMs: 4000 };
    const plan = planReframe({ sourceWidthPx: 1920, sourceHeightPx: 1080, durationMs: 4000, subjects: [track], exclusions: [logo] });
    expect(plan.overlayUnavoidable).toBe(false);
    for (const k of plan.keyframes.filter((f) => f.tMs >= 2000 && f.tMs < 4000)) expect(overlaps(win(k), logo.box)).toBe(false);
    expect(plan.subjectCoveragePct).toBe(100);
  });

  it("no subject: centred static window; stills need no duration", () => {
    const plan = planReframe({ sourceWidthPx: 1920, sourceHeightPx: 1080 });
    expect(plan).toMatchObject({ mode: "static", durationMs: 0, primarySubjectId: null, subjectCoveragePct: 100 });
    expect(plan.keyframes[0]!.xPx).toBe(657);
  });

  it("is deterministic and integer-only", () => {
    const input = { sourceWidthPx: 1920, sourceHeightPx: 1080, subjects: [still("a", box(1000, 300, 220, 500))], exclusions: [{ kind: "logo" as const, box: box(1500, 20, 380, 120) }] };
    const a = planReframe(input);
    expect(planReframe(input)).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    for (const k of a.keyframes) for (const v of [k.tMs, k.xPx, k.yPx, k.widthPx, k.heightPx]) expect(Number.isInteger(v)).toBe(true);
  });

  it("rejects non-positive sizes", () => {
    expect(() => planReframe({ sourceWidthPx: 0, sourceHeightPx: 1080 })).toThrow(RangeError);
  });
});

describe("reframeOptionsFromEnv", () => {
  it("defaults to 1.35x and parses overrides", () => {
    expect(reframeOptionsFromEnv({}).maxZoomPermille).toBe(1350);
    expect(reframeOptionsFromEnv({ REFRAME_MAX_ZOOM: "1.5" }).maxZoomPermille).toBe(1500);
    expect(reframeOptionsFromEnv({ REFRAME_MAX_ZOOM: "abc" }).maxZoomPermille).toBe(1350);
    expect(reframeOptionsFromEnv({ REFRAME_MAX_ZOOM: "0.5" }).maxZoomPermille).toBe(1350);
    expect(reframeOptionsFromEnv({ REFRAME_MAX_PAN_PX_PER_SEC: "200", REFRAME_SMOOTHING_MS: "300" })).toMatchObject({ maxPanPxPerSec: 200, smoothingMs: 300 });
  });
});
