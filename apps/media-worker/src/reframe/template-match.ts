import { resizeBilinear, type Box, type RgbImage } from "./image-io.js";

/**
 * Optional known-logo finder (CR §6: "template tuỳ chọn"). Normalised cross-correlation of a grey template against a grey, downscaled
 * frame at ONE scale (the template is resized to `widthPct` of the frame width). Only runs when the operator configures reference logo
 * JPEGs (REFRAME_LOGO_TEMPLATES); with none configured it costs nothing. Opaque rectangular logos only (no alpha, single scale).
 */

export const TEMPLATE_WORK_WIDTH = 160;
export const DEFAULT_TEMPLATE_THRESHOLD = 0.8;

export type GreyImage = { width: number; height: number; data: Float32Array };

export function toGrey(image: RgbImage, width: number): GreyImage {
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const small = image.width === width ? image : resizeBilinear(image, width, height);
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i += 1) data[i] = 0.299 * small.data[i * 3]! + 0.587 * small.data[i * 3 + 1]! + 0.114 * small.data[i * 3 + 2]!;
  return { width, height, data };
}

/** Template scaled so its width is `widthPct` % of the work width; the aspect is kept. */
export function scaleTemplate(template: RgbImage, workWidth: number, widthPct: number): GreyImage {
  const w = Math.max(6, Math.round((workWidth * widthPct) / 100));
  return toGrey(template, w);
}

/** Best NCC position of `template` in `frame` (grey, same scale). Returns null when the template does not fit or is flat. */
export function matchTemplate(frame: GreyImage, template: GreyImage): { x: number; y: number; score: number } | null {
  const tw = template.width;
  const th = template.height;
  if (tw >= frame.width || th >= frame.height) return null;
  const n = tw * th;
  let tMean = 0;
  for (let i = 0; i < n; i += 1) tMean += template.data[i]! / n;
  let tNorm = 0;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { t[i] = template.data[i]! - tMean; tNorm += t[i]! * t[i]!; }
  if (tNorm < 1e-3) return null;
  let best: { x: number; y: number; score: number } | null = null;
  for (let y = 0; y + th <= frame.height; y += 1) {
    for (let x = 0; x + tw <= frame.width; x += 1) {
      let mean = 0;
      for (let j = 0; j < th; j += 1) for (let i = 0; i < tw; i += 1) mean += frame.data[(y + j) * frame.width + x + i]!;
      mean /= n;
      let dot = 0;
      let norm = 0;
      for (let j = 0; j < th; j += 1) {
        for (let i = 0; i < tw; i += 1) {
          const v = frame.data[(y + j) * frame.width + x + i]! - mean;
          dot += v * t[j * tw + i]!;
          norm += v * v;
        }
      }
      if (norm < 1e-3) continue;
      const score = dot / Math.sqrt(norm * tNorm);
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  return best;
}

/** Match -> box in SOURCE pixels. */
export function matchToSourceBox(match: { x: number; y: number }, template: GreyImage, workWidth: number, srcWidth: number, srcHeight: number): Box {
  const s = srcWidth / workWidth;
  return { x: match.x * s, y: match.y * s, w: Math.min(srcWidth, template.width * s), h: Math.min(srcHeight, template.height * s) };
}
