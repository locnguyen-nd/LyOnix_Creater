import { nonMaxSuppression, type Box, type Detection, type RgbImage } from "./image-io.js";

/**
 * YuNet 2023mar face detector (OpenCV Zoo, MIT) - pre/post-processing for onnxruntime. The exported graph has a FIXED 640x640
 * input (OpenCV's `FaceDetectorYN` hides this by reshaping), so the whole frame is letterboxed into it (zero padded right/bottom).
 * Input is BGR float 0..255, NCHW. Outputs per stride 8/16/32: cls, obj, bbox (4) and kps (10, unused).
 */

export const YUNET_INPUT = 640;
export const YUNET_STRIDES = [8, 16, 32] as const;

export type YunetOutputs = Record<string, { data: Float32Array | number[] }>;

export type YunetTile = { x: number; y: number; w: number; h: number; scale: number };

/**
 * One pass over the whole frame, scaled (up or down) so its long side fills the 640 input: analysis frames are small (long side
 * ~320-480 px, DEC-2026-10-02-CAPACITY-250), and upscaling lets YuNet see small faces while the cost stays one 640x640 inference.
 */
export function yunetTiles(width: number, height: number): YunetTile[] {
  return [{ x: 0, y: 0, w: width, h: height, scale: YUNET_INPUT / Math.max(width, height) }];
}

/** Crops (and scales) a tile into a 640x640 BGR NCHW float tensor, zero padded at the right/bottom. */
export function yunetTensor(image: RgbImage, tile: YunetTile): Float32Array {
  const size = YUNET_INPUT;
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  const dstW = Math.min(size, Math.round(tile.w * tile.scale));
  const dstH = Math.min(size, Math.round(tile.h * tile.scale));
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.min(image.height - 1, tile.y + Math.min(tile.h - 1, Math.floor((y + 0.5) / tile.scale)));
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.min(image.width - 1, tile.x + Math.min(tile.w - 1, Math.floor((x + 0.5) / tile.scale)));
      const p = (sy * image.width + sx) * 3;
      const o = y * size + x;
      out[o] = image.data[p + 2]!; // B
      out[plane + o] = image.data[p + 1]!; // G
      out[2 * plane + o] = image.data[p]!; // R
    }
  }
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Decodes one tile's outputs into boxes in the tile's input pixels (before un-scaling), score = sqrt(cls * obj) like OpenCV. */
export function decodeYunet(outputs: YunetOutputs, scoreThreshold: number): Detection[] {
  const found: Detection[] = [];
  for (const stride of YUNET_STRIDES) {
    const cls = outputs[`cls_${stride}`]?.data;
    const obj = outputs[`obj_${stride}`]?.data;
    const bbox = outputs[`bbox_${stride}`]?.data;
    if (!cls || !obj || !bbox) throw new Error(`YuNet output cls_${stride}/obj_${stride}/bbox_${stride} missing`);
    const cells = YUNET_INPUT / stride;
    for (let r = 0; r < cells; r += 1) {
      for (let c = 0; c < cells; c += 1) {
        const idx = r * cells + c;
        const score = Math.sqrt(clamp01(cls[idx]!) * clamp01(obj[idx]!));
        if (score < scoreThreshold) continue;
        const cx = (c + bbox[idx * 4]!) * stride;
        const cy = (r + bbox[idx * 4 + 1]!) * stride;
        const w = Math.exp(bbox[idx * 4 + 2]!) * stride;
        const h = Math.exp(bbox[idx * 4 + 3]!) * stride;
        found.push({ box: { x: cx - w / 2, y: cy - h / 2, w, h }, score });
      }
    }
  }
  return found;
}

/** Maps tile-space detections to image space, clips to the frame, and merges duplicates across tiles. */
export function mergeYunetTiles(perTile: Array<{ tile: YunetTile; detections: Detection[] }>, width: number, height: number, nmsIou = 0.3): Detection[] {
  const all: Detection[] = [];
  for (const { tile, detections } of perTile) {
    for (const d of detections) {
      const x0 = Math.max(0, tile.x + d.box.x / tile.scale);
      const y0 = Math.max(0, tile.y + d.box.y / tile.scale);
      const x1 = Math.min(width, tile.x + (d.box.x + d.box.w) / tile.scale);
      const y1 = Math.min(height, tile.y + (d.box.y + d.box.h) / tile.scale);
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      const box: Box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      all.push({ box, score: d.score });
    }
  }
  return nonMaxSuppression(all, nmsIou);
}
