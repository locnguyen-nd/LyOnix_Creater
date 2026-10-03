import { type Box, type Detection, type RgbImage, resizeBilinear } from "./image-io.js";

/**
 * PP-OCRv3 DB text detector (OpenCV Zoo `text_detection_*_ppocrv3_2023may`, Apache-2.0; the cn and en files are byte-identical).
 * Dynamic input `[1,3,H,W]` (H, W multiples of 32); output = probability map `[H,W]`. Pre-processing as the zoo/OpenCV
 * `TextDetectionModel_DB`: BGR, (px - mean) / (255 * std) with mean (123.675, 116.28, 103.53) and std (0.229, 0.224, 0.225) applied per
 * channel in B,G,R order. Post-processing here is axis-aligned (the crop planner only needs rectangles): binarise at 0.3,
 * connected components, mean-probability filter, unclip by the DB rule `d = area * ratio / perimeter`.
 */

export const DB_MEAN = [123.675, 116.28, 103.53] as const;
export const DB_STD = [0.229, 0.224, 0.225] as const;
export const DB_BINARY_THRESHOLD = 0.3;
export const DB_BOX_SCORE_THRESHOLD = 0.5;
export const DB_UNCLIP_RATIO = 2.0;
export const DB_MIN_SIDE_PX = 3;

const round32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);

/** Input size keeping the aspect: long side capped at `maxLongSide`, both sides multiples of 32. */
export function dbInputSize(width: number, height: number, maxLongSide: number): { w: number; h: number } {
  const scale = Math.min(1, maxLongSide / Math.max(width, height));
  return { w: round32(width * scale), h: round32(height * scale) };
}

export function dbTensor(image: RgbImage, w: number, h: number): Float32Array {
  const resized = image.width === w && image.height === h ? image : resizeBilinear(image, w, h);
  const plane = w * h;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    const r = resized.data[i * 3]!;
    const g = resized.data[i * 3 + 1]!;
    const b = resized.data[i * 3 + 2]!;
    out[i] = (b - DB_MEAN[0]) / (255 * DB_STD[0]);
    out[plane + i] = (g - DB_MEAN[1]) / (255 * DB_STD[1]);
    out[2 * plane + i] = (r - DB_MEAN[2]) / (255 * DB_STD[2]);
  }
  return out;
}

/** Text boxes (in the pixel space of the `srcWidth` x `srcHeight` image) from a `w` x `h` probability map. */
export function decodeDbText(prob: Float32Array | number[], w: number, h: number, srcWidth: number, srcHeight: number, options: { maxCandidates?: number; unclipRatio?: number } = {}): Detection[] {
  if (prob.length < w * h) throw new Error(`DB output too small (${prob.length} < ${w * h})`);
  const unclipRatio = options.unclipRatio ?? DB_UNCLIP_RATIO;
  const maxCandidates = options.maxCandidates ?? 200;
  const label = new Int32Array(w * h);
  const stack: number[] = [];
  const found: Detection[] = [];
  let next = 0;
  for (let start = 0; start < w * h; start += 1) {
    if (prob[start]! <= DB_BINARY_THRESHOLD || label[start] !== 0) continue;
    next += 1;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    let sum = 0;
    let count = 0;
    label[start] = next;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop()!;
      const x = at % w;
      const y = (at - x) / w;
      sum += prob[at]!;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && label[at - 1] === 0 && prob[at - 1]! > DB_BINARY_THRESHOLD) { label[at - 1] = next; stack.push(at - 1); }
      if (x < w - 1 && label[at + 1] === 0 && prob[at + 1]! > DB_BINARY_THRESHOLD) { label[at + 1] = next; stack.push(at + 1); }
      if (y > 0 && label[at - w] === 0 && prob[at - w]! > DB_BINARY_THRESHOLD) { label[at - w] = next; stack.push(at - w); }
      if (y < h - 1 && label[at + w] === 0 && prob[at + w]! > DB_BINARY_THRESHOLD) { label[at + w] = next; stack.push(at + w); }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (Math.min(bw, bh) < DB_MIN_SIDE_PX) continue;
    const score = sum / count;
    if (score < DB_BOX_SCORE_THRESHOLD) continue;
    const distance = (bw * bh * unclipRatio) / (2 * (bw + bh));
    const x0 = Math.max(0, minX - distance);
    const y0 = Math.max(0, minY - distance);
    const x1 = Math.min(w, maxX + 1 + distance);
    const y1 = Math.min(h, maxY + 1 + distance);
    const sx = srcWidth / w;
    const sy = srcHeight / h;
    const box: Box = { x: x0 * sx, y: y0 * sy, w: (x1 - x0) * sx, h: (y1 - y0) * sy };
    found.push({ box, score });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, maxCandidates);
}
