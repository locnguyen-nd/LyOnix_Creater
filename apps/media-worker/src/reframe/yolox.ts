import { nonMaxSuppression, type Detection, type RgbImage } from "./image-io.js";

/**
 * YOLOX (OpenCV Zoo `object_detection_yolox_2022nov`, Apache-2.0) COCO detector, only class 0 (person) is kept. Pre-processing as in
 * the zoo demo: RGB, letterbox into 640x640 at the top-left with 114 padding, raw 0..255 floats (no mean/std), NCHW.
 * Output `[1, 8400, 85]` = (cx, cy, w, h) grid-encoded + objectness + 80 class scores.
 */

export const YOLOX_INPUT = 640;
export const YOLOX_STRIDES = [8, 16, 32] as const;
export const YOLOX_PERSON_CLASS = 0;
const PAD_VALUE = 114;

export type YoloxLetterbox = { tensor: Float32Array; ratio: number };

export function yoloxLetterbox(image: RgbImage): YoloxLetterbox {
  const size = YOLOX_INPUT;
  const plane = size * size;
  const tensor = new Float32Array(3 * plane).fill(PAD_VALUE);
  const ratio = Math.min(size / image.height, size / image.width);
  const dstW = Math.min(size, Math.floor(image.width * ratio));
  const dstH = Math.min(size, Math.floor(image.height * ratio));
  for (let y = 0; y < dstH; y += 1) {
    const fy = Math.min(Math.max((y + 0.5) / ratio - 0.5, 0), image.height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, image.height - 1);
    const wy = fy - y0;
    for (let x = 0; x < dstW; x += 1) {
      const fx = Math.min(Math.max((x + 0.5) / ratio - 0.5, 0), image.width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, image.width - 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c += 1) {
        const a = image.data[(y0 * image.width + x0) * 3 + c]!;
        const b = image.data[(y0 * image.width + x1) * 3 + c]!;
        const d = image.data[(y1 * image.width + x0) * 3 + c]!;
        const e = image.data[(y1 * image.width + x1) * 3 + c]!;
        const top = a + (b - a) * wx;
        tensor[c * plane + y * size + x] = top + (d + (e - d) * wx - top) * wy;
      }
    }
  }
  return { tensor, ratio };
}

/** Grid (x, y) and stride per anchor, in the order the exported graph concatenates them (stride 8, 16, 32; row-major `meshgrid`). */
export function yoloxAnchors(): { grid: Int16Array; stride: Uint8Array } {
  const count = YOLOX_STRIDES.reduce((total, s) => total + (YOLOX_INPUT / s) ** 2, 0);
  const grid = new Int16Array(count * 2);
  const stride = new Uint8Array(count);
  let i = 0;
  for (const s of YOLOX_STRIDES) {
    const n = YOLOX_INPUT / s;
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        grid[i * 2] = x;
        grid[i * 2 + 1] = y;
        stride[i] = s;
        i += 1;
      }
    }
  }
  return { grid, stride };
}

const ANCHORS = yoloxAnchors();

/** Decodes the raw output into person boxes in ORIGINAL image pixels. `scoreThreshold` applies to objectness * personScore. */
export function decodeYoloxPersons(output: Float32Array | number[], ratio: number, imageWidth: number, imageHeight: number, scoreThreshold = 0.35, nmsIou = 0.5): Detection[] {
  const rowLen = 85;
  const rows = ANCHORS.stride.length;
  if (output.length < rows * rowLen) throw new Error(`YOLOX output too small (${output.length} < ${rows * rowLen})`);
  const found: Detection[] = [];
  for (let i = 0; i < rows; i += 1) {
    const base = i * rowLen;
    const score = output[base + 4]! * output[base + 5 + YOLOX_PERSON_CLASS]!;
    if (score < scoreThreshold) continue;
    const s = ANCHORS.stride[i]!;
    const cx = (output[base]! + ANCHORS.grid[i * 2]!) * s;
    const cy = (output[base + 1]! + ANCHORS.grid[i * 2 + 1]!) * s;
    const w = Math.exp(output[base + 2]!) * s;
    const h = Math.exp(output[base + 3]!) * s;
    const x0 = Math.max(0, (cx - w / 2) / ratio);
    const y0 = Math.max(0, (cy - h / 2) / ratio);
    const x1 = Math.min(imageWidth, (cx + w / 2) / ratio);
    const y1 = Math.min(imageHeight, (cy + h / 2) / ratio);
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    found.push({ box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, score });
  }
  return nonMaxSuppression(found, nmsIou);
}
