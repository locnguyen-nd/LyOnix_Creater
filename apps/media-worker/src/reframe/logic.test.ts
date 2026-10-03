import { describe, expect, it } from "vitest";
import { computeConfidence } from "./confidence.js";
import { loadReframeConfig } from "./config.js";
import type { RgbImage } from "./image-io.js";
import { cropRows, presetLogoRegions, temporalRegions, textBands } from "./overlays.js";
import { findSalientBox } from "./saliency.js";
import { Semaphore } from "./semaphore.js";
import { expandFaceBox, frameCandidates, rankSubjects, type FrameDetections } from "./subjects.js";
import { matchTemplate, scaleTemplate, toGrey } from "./template-match.js";

const det = (x: number, y: number, w: number, h: number, score = 0.9) => ({ box: { x, y, w, h }, score });

describe("subjects", () => {
  it("expands a face to head+shoulders inside the frame", () => {
    const box = expandFaceBox({ x: 100, y: 100, w: 50, h: 60 }, 1000, 1000);
    expect(box.w).toBeCloseTo(120, 5);
    expect(box.y).toBeLessThan(100);
    expect(box.h).toBeGreaterThan(150);
    expect(expandFaceBox({ x: 0, y: 0, w: 50, h: 60 }, 1000, 1000).x).toBe(0);
  });

  it("uses faces first, falls back to persons only for frames without a usable face, ignores tiny crowd faces", () => {
    const withFace: FrameDetections = { tMs: 0, faces: [det(400, 200, 100, 120)], persons: null };
    expect(frameCandidates(withFace, 1000, 1000).map((c) => c.origin)).toEqual(["face"]);
    const tinyFaceOnly: FrameDetections = { tMs: 0, faces: [det(10, 10, 20, 25)], persons: [det(300, 100, 200, 600)] };
    expect(frameCandidates(tinyFaceOnly, 1000, 1000).map((c) => c.origin)).toEqual(["person"]);
    expect(frameCandidates({ tMs: 0, faces: [], persons: [det(0, 0, 10, 40)] }, 1000, 1000)).toEqual([]);
  });

  it("ranks the large, stable person over a small crowd member (default) and the centred one with preference=center", () => {
    const big = (t: number): FrameDetections => ({ tMs: t, faces: [], persons: [det(30, 100, 400, 800), det(700, 300, 150, 300)] });
    const frames = [big(0), big(1000), big(2000), big(3000)];
    const largest = rankSubjects(frames, 1000, 1000, null);
    expect(largest.source).toBe("person");
    const primary = largest.tracks.find((t) => t.subjectId === largest.primaryId)!;
    expect(primary.samples[0]!.box.widthPx).toBe(400);
    expect(largest.dominance).toBeGreaterThan(0.5);
    // two comparable people: the one near the centre wins with preference=center, the larger with the default
    const centred = (t: number): FrameDetections => ({ tMs: t, faces: [], persons: [det(0, 200, 330, 600), det(360, 200, 280, 600)] });
    const center = rankSubjects([centred(0), centred(1000)], 1000, 1000, "center");
    const chosen = center.tracks.find((t) => t.subjectId === center.primaryId)!;
    expect(chosen.samples[0]!.box.widthPx).toBe(280);
    expect(rankSubjects([centred(0), centred(1000)], 1000, 1000, "largest").tracks.find((t) => t.subjectId === "s1")!.samples[0]!.box.widthPx).toBe(330);
  });

  it("returns no subject when nothing usable is found", () => {
    expect(rankSubjects([{ tMs: 0, faces: [], persons: [] }], 1000, 1000, null)).toMatchObject({ primaryId: null, source: "none", tracks: [] });
  });
});

describe("overlays", () => {
  it("builds four corner logo regions from percent margins", () => {
    const regions = presetLogoRegions(720, 1280, { widthPct: 30, heightPct: 10 });
    expect(regions).toHaveLength(4);
    expect(regions.every((r) => r.kind === "logo" && r.startMs === undefined)).toBe(true);
    expect(regions[0]!.box).toEqual({ xPx: 0, yPx: 0, widthPx: 216, heightPx: 128 });
    expect(regions[3]!.box).toEqual({ xPx: 504, yPx: 1152, widthPx: 216, heightPx: 128 });
  });

  it("scans only the top and bottom bands, the whole frame when they overlap, and slices rows cheaply", () => {
    expect(textBands(1000, 25, 60)).toEqual([{ y0: 0, y1: 250 }, { y0: 400, y1: 1000 }]);
    expect(textBands(1000, 50, 50)).toEqual([{ y0: 0, y1: 1000 }]);
    expect(textBands(1000, 0, 0)).toEqual([]);
    const image: RgbImage = { width: 4, height: 10, data: new Uint8Array(4 * 10 * 3).map((_, i) => i % 251) };
    const strip = cropRows(image, 2, 5);
    expect(strip.height).toBe(3);
    expect(strip.data.length).toBe(4 * 3 * 3);
    expect(strip.data[0]).toBe(image.data[2 * 4 * 3]);
  });

  it("merges text seen in consecutive samples, closes a caption that disappears, and drops the interval for always-on text", () => {
    const logo = { x: 10, y: 10, w: 100, h: 30 };
    const caption = { x: 50, y: 500, w: 300, h: 40 };
    const samples = [
      { tMs: 1000, boxes: [logo, caption] },
      { tMs: 3000, boxes: [logo] },
      { tMs: 5000, boxes: [logo, { x: 50, y: 800, w: 200, h: 40 }] },
    ];
    const regions = temporalRegions("text", samples, [1000, 3000, 5000], 6000);
    const always = regions.find((r) => r.box.xPx === 10)!;
    expect(always.startMs).toBeUndefined();
    expect(always.endMs).toBeUndefined();
    const first = regions.find((r) => r.box.yPx === 500)!;
    expect(first).toMatchObject({ startMs: 0, endMs: 2000 });
    const last = regions.find((r) => r.box.yPx === 800)!;
    expect(last).toMatchObject({ startMs: 4000, endMs: 6000 });
  });
});

describe("saliency", () => {
  it("finds a contrasting blob and returns null for a flat image", () => {
    const w = 96;
    const h = 96;
    const data = new Uint8Array(w * h * 3).fill(40);
    for (let y = 30; y < 70; y += 1) for (let x = 20; x < 50; x += 1) data.set([240, 60, 60], (y * w + x) * 3);
    const found = findSalientBox({ width: w, height: h, data })!;
    expect(found.box.x).toBeGreaterThanOrEqual(10);
    expect(found.box.x + found.box.w).toBeLessThanOrEqual(65);
    expect(found.box.y).toBeGreaterThanOrEqual(20);
    expect(findSalientBox({ width: w, height: h, data: new Uint8Array(w * h * 3).fill(90) })).toBeNull();
  });
});

describe("template matching (optional logo)", () => {
  it("locates a known logo patch at one scale and refuses a flat template", () => {
    const w = 160;
    const h = 120;
    const data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i += 1) data.set([(i * 7) % 90, (i * 13) % 90, 50], i * 3); // textured background
    const logo: RgbImage = { width: 16, height: 16, data: new Uint8Array(16 * 16 * 3) };
    for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) logo.data.set(((x >> 2) + (y >> 2)) % 2 === 0 ? [250, 250, 250] : [10, 10, 10], (y * 16 + x) * 3);
    for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) data.set(logo.data.slice((y * 16 + x) * 3, (y * 16 + x) * 3 + 3), ((40 + y) * w + 100 + x) * 3);
    const match = matchTemplate(toGrey({ width: w, height: h, data }, 160), scaleTemplate(logo, 160, 10))!;
    expect(match.score).toBeGreaterThan(0.9);
    expect(Math.abs(match.x - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(match.y - 40)).toBeLessThanOrEqual(1);
    const flat: RgbImage = { width: 16, height: 16, data: new Uint8Array(16 * 16 * 3).fill(128) };
    expect(matchTemplate(toGrey({ width: w, height: h, data }, 160), scaleTemplate(flat, 160, 10))).toBeNull();
  });
});

describe("confidence", () => {
  const base = { subjectSource: "face" as const, framesAnalysed: 8, framesWithSubject: 8, dominance: 1, social: false, windowDurationMs: 12_000, isImage: false, overlayUnavoidable: false, textScanned: true, templatesConfigured: false };
  it("is high for a clean, well-sampled face clip and low without a subject", () => {
    expect(computeConfidence(base).level).toBe("high");
    expect(computeConfidence({ ...base, subjectSource: "none", framesWithSubject: 0 })).toMatchObject({ level: "low", reasons: ["no_subject_found_center_crop"] });
  });
  it("lowers overlay confidence for social sources, and further for short clips", () => {
    const long = computeConfidence({ ...base, social: true });
    const short = computeConfidence({ ...base, social: true, windowDurationMs: 4000, framesAnalysed: 4, framesWithSubject: 4 });
    expect(long.overlay).toBe(0.6);
    expect(short.overlay).toBe(0.35);
    expect(short.reasons).toContain("short_clip_low_watermark_confidence");
    expect(short.level).toBe("low");
  });
  it("flags ambiguity and the salient fallback", () => {
    expect(computeConfidence({ ...base, dominance: 0.3 }).reasons).toContain("ambiguous_multi_person");
    expect(computeConfidence({ ...base, subjectSource: "salient" })).toMatchObject({ subject: 0.35, level: "low" });
  });
});

describe("Semaphore", () => {
  it("never lets more than `limit` tasks run at once and runs the rest FIFO", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (n: number) => sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(n);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    await Promise.all([1, 2, 3, 4, 5].map(task));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(sem.running).toBe(0);
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
  it("releases the slot when a task throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("loadReframeConfig", () => {
  it("has the capacity-minded defaults and reads env overrides", () => {
    const cfg = loadReframeConfig({}, "/repo", 8);
    expect(cfg).toMatchObject({ analysisLongSide: 448, maxFrames: 12, textMaxFrames: 4, concurrency: 2, ortThreads: 1 });
    expect(cfg.plan.maxZoomPermille).toBe(1350);
    expect(cfg.modelsDir.replaceAll("\\", "/")).toMatch(/\/repo\/data\/models$/);
    const custom = loadReframeConfig({ REFRAME_CONCURRENCY: "3", REFRAME_MAX_ZOOM: "1.5", REFRAME_MODELS_DIR: "/models", REFRAME_LOGO_TEMPLATES: "/a.jpg, /b.jpg" }, "/repo", 8);
    expect(custom).toMatchObject({ concurrency: 3, modelsDir: "/models", logoTemplates: ["/a.jpg", "/b.jpg"] });
    expect(custom.plan.maxZoomPermille).toBe(1500);
    expect(() => loadReframeConfig({ REFRAME_CONCURRENCY: "0" }, "/repo")).toThrow(/REFRAME_CONCURRENCY/);
  });
});
