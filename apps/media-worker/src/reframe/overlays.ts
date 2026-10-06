import type { ExclusionRegion } from "@lyonix/domain";
import { boxArea, boxIou, type Box, type RgbImage } from "./image-io.js";

/**
 * Overlay (logo/text) side of reframe.analyze, all pure. Spike VE2E-64 showed that frame statistics cannot find a translucent jumping
 * watermark, so for TikTok/Apify sources the logo is handled by PRESET corner margins (no CPU), plus the text detector for the @handle,
 * plus optional template matching. Numbers marked PLACEHOLDER are untuned (VE2E-69).
 */

export type PresetMargins = { widthPct: number; heightPct: number };
/** PLACEHOLDER: each corner box covers this share of the frame width/height (TikTok's mark + @handle jump between corners). */
export const DEFAULT_PRESET_MARGINS: PresetMargins = { widthPct: 30, heightPct: 10 };
/** PLACEHOLDER: text boxes smaller than this are detector noise. */
export const MIN_TEXT_HEIGHT_RATIO = 0.012;
export const MIN_TEXT_AREA_RATIO = 0.0004;
/** Keep at most this many text regions (largest first) so the planner stays cheap. */
export const MAX_TEXT_REGIONS = 40;
/** Consecutive-frame boxes with at least this IoU are the same on-screen text. */
export const SAME_TEXT_IOU = 0.4;

const px = (box: Box) => ({ xPx: Math.round(box.x), yPx: Math.round(box.y), widthPx: Math.max(1, Math.round(box.w)), heightPx: Math.max(1, Math.round(box.h)) });

/** Four corner "logo" regions covering the whole clip. Free of CPU: no detector involved. */
export function presetLogoRegions(width: number, height: number, margins: PresetMargins = DEFAULT_PRESET_MARGINS): ExclusionRegion[] {
  const w = Math.round((width * margins.widthPct) / 100);
  const h = Math.round((height * margins.heightPct) / 100);
  const corners: Box[] = [
    { x: 0, y: 0, w, h },
    { x: width - w, y: 0, w, h },
    { x: 0, y: height - h, w, h },
    { x: width - w, y: height - h, w, h },
  ];
  return corners.map((box) => ({ kind: "logo" as const, box: px(box), soft: true }));
}

/** Horizontal strips (top margin, bottom band) where burned-in captions/handles/lower-thirds live; the middle is not scanned (capacity). */
export function textBands(height: number, topPct: number, bottomPct: number): Array<{ y0: number; y1: number }> {
  const bands: Array<{ y0: number; y1: number }> = [];
  const top = Math.round((height * topPct) / 100);
  const bottom = Math.round((height * bottomPct) / 100);
  if (top >= 16) bands.push({ y0: 0, y1: Math.min(height, top) });
  if (bottom >= 16) bands.push({ y0: Math.max(0, height - bottom), y1: height });
  if (top + bottom >= height) return [{ y0: 0, y1: height }]; // overlapping bands => scan the whole frame once
  return bands;
}

/** Rows [y0, y1) of an RGB raster as its own image (rows are contiguous, so this is a cheap slice). */
export function cropRows(image: RgbImage, y0: number, y1: number): RgbImage {
  const stride = image.width * 3;
  return { width: image.width, height: y1 - y0, data: image.data.subarray(y0 * stride, y1 * stride) };
}

export const isUsableTextBox = (box: Box, frameWidth: number, frameHeight: number): boolean =>
  box.h >= frameHeight * MIN_TEXT_HEIGHT_RATIO && boxArea(box) >= frameWidth * frameHeight * MIN_TEXT_AREA_RATIO;

export type TimedBoxes = { tMs: number; boxes: Box[] };

const union = (a: Box, b: Box): Box => {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
};

/**
 * Time-bounded exclusion regions from per-sample boxes. A box seen at sample i is active from the midpoint to the previous sample to the
 * midpoint to the next one; boxes of consecutive samples that overlap (IoU >= 0.4) are the same text and merge into one region.
 * A region active for the whole analysed span carries no start/end. `scannedTimes` = every sample time that was scanned (also those with
 * no boxes), so a caption that disappears gets an end time.
 */
export function temporalRegions(kind: "text" | "logo", samples: TimedBoxes[], scannedTimes: number[], durationMs: number): ExclusionRegion[] {
  const times = [...new Set(scannedTimes)].sort((a, b) => a - b);
  if (times.length === 0) return [];
  const startOf = (t: number) => { const i = times.indexOf(t); return i <= 0 ? 0 : Math.round((times[i - 1]! + t) / 2); };
  const endOf = (t: number) => { const i = times.indexOf(t); return i >= times.length - 1 ? durationMs : Math.round((t + times[i + 1]!) / 2); };
  type Run = { box: Box; startMs: number; endMs: number; lastT: number };
  const open: Run[] = [];
  const done: Run[] = [];
  for (const t of times) {
    const sample = samples.find((s) => s.tMs === t);
    const boxes = sample?.boxes ?? [];
    const stillOpen: Run[] = [];
    const used = new Set<Box>();
    for (const run of open) {
      const hit = boxes.find((b) => !used.has(b) && boxIou(run.box, b) >= SAME_TEXT_IOU);
      if (hit) {
        used.add(hit);
        run.box = union(run.box, hit);
        run.endMs = endOf(t);
        run.lastT = t;
        stillOpen.push(run);
      } else {
        done.push(run);
      }
    }
    for (const b of boxes) if (!used.has(b)) stillOpen.push({ box: b, startMs: startOf(t), endMs: endOf(t), lastT: t });
    open.length = 0;
    open.push(...stillOpen);
  }
  done.push(...open);
  return done
    .sort((a, b) => boxArea(b.box) - boxArea(a.box))
    .slice(0, MAX_TEXT_REGIONS)
    .map((run) => {
      const whole = run.startMs <= 0 && run.endMs >= durationMs;
      return { kind, box: px(run.box), ...(whole ? {} : { startMs: run.startMs, endMs: run.endMs }) };
    });
}
