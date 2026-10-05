import { resizeBilinear, type Box, type RgbImage } from "./image-io.js";

/**
 * Last-resort subject finder (no person/face anywhere: animals, cartoons, objects). Frequency-tuned saliency (Achanta et al. 2009,
 * RGB distance instead of Lab): distance of the blurred image from the mean colour, threshold at 2x the mean saliency, bounding box of
 * the heaviest connected region. No model, deterministic, cheap - and weak: it is a fallback, flagged as low confidence by the caller.
 */

export const SALIENCY_WORK_WIDTH = 96;
/** PLACEHOLDER: a salient region must cover at least this share of the frame to count. */
export const SALIENCY_MIN_AREA_RATIO = 0.02;

function blur3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            sum += src[(yy * w + xx) * 3 + c]!;
            n += 1;
          }
        }
        out[(y * w + x) * 3 + c] = sum / n;
      }
    }
  }
  return out;
}

/** Salient bounding box in the pixel space of `image`, or null when nothing stands out. */
export function findSalientBox(image: RgbImage): { box: Box; score: number } | null {
  const w = Math.min(SALIENCY_WORK_WIDTH, image.width);
  const h = Math.max(1, Math.round((image.height * w) / image.width));
  const small = image.width === w ? image : resizeBilinear(image, w, h);
  let pixels: Float32Array = Float32Array.from(small.data);
  pixels = blur3(blur3(pixels, w, h), w, h);
  const mean = [0, 0, 0];
  for (let i = 0; i < w * h; i += 1) for (let c = 0; c < 3; c += 1) mean[c]! += pixels[i * 3 + c]! / (w * h);
  const sal = new Float32Array(w * h);
  let avg = 0;
  for (let i = 0; i < w * h; i += 1) {
    const dr = pixels[i * 3]! - mean[0]!;
    const dg = pixels[i * 3 + 1]! - mean[1]!;
    const db = pixels[i * 3 + 2]! - mean[2]!;
    sal[i] = Math.sqrt(dr * dr + dg * dg + db * db);
    avg += sal[i]! / (w * h);
  }
  if (avg < 1) return null; // flat image
  const threshold = 2 * avg;
  const label = new Int32Array(w * h);
  const stack: number[] = [];
  let best: { mass: number; minX: number; minY: number; maxX: number; maxY: number; count: number } | null = null;
  let next = 0;
  for (let start = 0; start < w * h; start += 1) {
    if (sal[start]! < threshold || label[start] !== 0) continue;
    next += 1;
    label[start] = next;
    stack.push(start);
    let mass = 0;
    let count = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    while (stack.length > 0) {
      const at = stack.pop()!;
      const x = at % w;
      const y = (at - x) / w;
      mass += sal[at]!;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const n of [x > 0 ? at - 1 : -1, x < w - 1 ? at + 1 : -1, y > 0 ? at - w : -1, y < h - 1 ? at + w : -1]) {
        if (n >= 0 && label[n] === 0 && sal[n]! >= threshold) { label[n] = next; stack.push(n); }
      }
    }
    if (!best || mass > best.mass) best = { mass, minX, minY, maxX, maxY, count };
  }
  if (!best) return null;
  const bw = best.maxX - best.minX + 1;
  const bh = best.maxY - best.minY + 1;
  if ((bw * bh) / (w * h) < SALIENCY_MIN_AREA_RATIO) return null;
  const sx = image.width / w;
  const sy = image.height / h;
  return { box: { x: best.minX * sx, y: best.minY * sy, w: bw * sx, h: bh * sy }, score: Math.min(1, best.mass / (best.count * 255)) };
}
