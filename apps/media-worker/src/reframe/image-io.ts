import jpeg from "jpeg-js";

/** Interleaved 8-bit RGB raster. Pure data: every detector pre-processor works on this, so they stay unit-testable without FFmpeg. */
export type RgbImage = { width: number; height: number; data: Uint8Array };

/** Box in the pixel space of whatever image produced it (detectors) - the analyzer scales to source pixels. */
export type Box = { x: number; y: number; w: number; h: number };
export type Detection = { box: Box; score: number };

/** Largest raster accepted from a frame JPEG (frames are <= ~1280 wide by contract; this guards a corrupt/hostile file). */
const MAX_DECODE_MB = 64;

export function decodeJpegToRgb(buffer: Uint8Array): RgbImage {
  const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: MAX_DECODE_MB });
  const { width, height } = decoded;
  const rgba = decoded.data;
  const data = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    data[j] = rgba[i]!;
    data[j + 1] = rgba[i + 1]!;
    data[j + 2] = rgba[i + 2]!;
  }
  return { width, height, data };
}

/** Writes an RGB raster as JPEG (debug overlays only). */
export function encodeRgbToJpeg(image: RgbImage, quality = 85): Uint8Array {
  const rgba = new Uint8Array(image.width * image.height * 4);
  for (let i = 0, j = 0; j < image.data.length; i += 4, j += 3) {
    rgba[i] = image.data[j]!;
    rgba[i + 1] = image.data[j + 1]!;
    rgba[i + 2] = image.data[j + 2]!;
    rgba[i + 3] = 255;
  }
  return jpeg.encode({ data: rgba, width: image.width, height: image.height }, quality).data;
}

/** Bilinear resize (pixel-centre aligned like OpenCV INTER_LINEAR). */
export function resizeBilinear(src: RgbImage, width: number, height: number): RgbImage {
  const out = new Uint8Array(width * height * 3);
  const xRatio = src.width / width;
  const yRatio = src.height / height;
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(Math.max((y + 0.5) * yRatio - 0.5, 0), src.height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, src.height - 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(Math.max((x + 0.5) * xRatio - 0.5, 0), src.width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, src.width - 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c += 1) {
        const p00 = src.data[(y0 * src.width + x0) * 3 + c]!;
        const p10 = src.data[(y0 * src.width + x1) * 3 + c]!;
        const p01 = src.data[(y1 * src.width + x0) * 3 + c]!;
        const p11 = src.data[(y1 * src.width + x1) * 3 + c]!;
        const top = p00 + (p10 - p00) * wx;
        const bottom = p01 + (p11 - p01) * wx;
        out[(y * width + x) * 3 + c] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return { width, height, data: out };
}

export const boxArea = (box: Box): number => Math.max(0, box.w) * Math.max(0, box.h);

export function boxIou(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (boxArea(a) + boxArea(b) - inter);
}

/** Greedy non-maximum suppression, highest score first. Deterministic (stable on ties by input order). */
export function nonMaxSuppression(detections: Detection[], iouThreshold: number, topK = 500): Detection[] {
  const sorted = detections.map((d, i) => ({ d, i })).sort((p, q) => q.d.score - p.d.score || p.i - q.i).map((p) => p.d);
  const kept: Detection[] = [];
  for (const candidate of sorted) {
    if (kept.length >= topK) break;
    if (kept.every((k) => boxIou(k.box, candidate.box) <= iouThreshold)) kept.push(candidate);
  }
  return kept;
}
