import { describe, expect, it } from "vitest";
import { dbInputSize, dbTensor, decodeDbText } from "./dbtext.js";
import { boxIou, nonMaxSuppression, resizeBilinear, type RgbImage } from "./image-io.js";
import { decodeYoloxPersons, YOLOX_INPUT, yoloxAnchors, yoloxLetterbox } from "./yolox.js";
import { decodeYunet, mergeYunetTiles, YUNET_INPUT, yunetTensor, yunetTiles } from "./yunet.js";

const solid = (width: number, height: number, rgb: [number, number, number]): RgbImage => {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) data.set(rgb, i * 3);
  return { width, height, data };
};

describe("image-io", () => {
  it("resizes bilinear and keeps a flat colour", () => {
    const out = resizeBilinear(solid(8, 4, [10, 20, 30]), 16, 8);
    expect(out.width).toBe(16);
    expect([...out.data.slice(0, 3)]).toEqual([10, 20, 30]);
  });
  it("NMS keeps the highest score of overlapping boxes, deterministic on ties", () => {
    const kept = nonMaxSuppression([
      { box: { x: 0, y: 0, w: 10, h: 10 }, score: 0.9 },
      { box: { x: 1, y: 1, w: 10, h: 10 }, score: 0.8 },
      { box: { x: 50, y: 50, w: 10, h: 10 }, score: 0.7 },
    ], 0.5);
    expect(kept.map((k) => k.score)).toEqual([0.9, 0.7]);
    expect(boxIou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBe(0);
  });
});

describe("YuNet pre/post", () => {
  it("uses one pass over the whole frame, scaled so the long side fills 640", () => {
    expect(yunetTiles(252, 448)).toEqual([{ x: 0, y: 0, w: 252, h: 448, scale: 640 / 448 }]);
  });
  it("builds a BGR NCHW 640x640 tensor, zero padded", () => {
    const tile = yunetTiles(64, 128)[0]!;
    const tensor = yunetTensor(solid(64, 128, [200, 100, 50]), tile);
    const plane = YUNET_INPUT * YUNET_INPUT;
    expect(tensor.length).toBe(3 * plane);
    expect([tensor[0], tensor[plane], tensor[2 * plane]]).toEqual([50, 100, 200]); // B, G, R
    expect(tensor[YUNET_INPUT - 1]).toBe(0); // right padding
  });
  it("decodes a synthetic output cell into a box (score = sqrt(cls*obj)) and merges duplicates", () => {
    const out: Record<string, { data: Float32Array }> = {};
    for (const stride of [8, 16, 32]) {
      const cells = YUNET_INPUT / stride;
      out[`cls_${stride}`] = { data: new Float32Array(cells * cells) };
      out[`obj_${stride}`] = { data: new Float32Array(cells * cells) };
      out[`bbox_${stride}`] = { data: new Float32Array(cells * cells * 4) };
    }
    // stride 16, cell row 10 col 20, cls .81 obj 1 => score .9; bbox offset (0.5, 0.5), w = h = exp(0) * 16
    const idx = 10 * 40 + 20;
    out.cls_16!.data[idx] = 0.81;
    out.obj_16!.data[idx] = 1;
    out.bbox_16!.data.set([0.5, 0.5, 0, 0], idx * 4);
    const found = decodeYunet(out, 0.6);
    expect(found).toHaveLength(1);
    expect(found[0]!.score).toBeCloseTo(0.9, 5);
    expect(found[0]!.box).toEqual({ x: 20.5 * 16 - 8, y: 10.5 * 16 - 8, w: 16, h: 16 });
    const merged = mergeYunetTiles([{ tile: yunetTiles(640, 640)[0]!, detections: [found[0]!, { ...found[0]!, score: 0.7 }] }], 640, 640);
    expect(merged).toHaveLength(1);
  });
});

describe("YOLOX pre/post", () => {
  it("letterboxes top-left with 114 padding on a 0..255 RGB tensor", () => {
    const { tensor, ratio } = yoloxLetterbox(solid(320, 640, [255, 0, 0]));
    expect(ratio).toBe(1);
    const plane = YOLOX_INPUT * YOLOX_INPUT;
    expect([tensor[0], tensor[plane], tensor[2 * plane]]).toEqual([255, 0, 0]);
    expect(tensor[400]).toBe(114); // x = 400 is right of the 320 px picture
  });
  it("has 8400 anchors in stride order", () => {
    const anchors = yoloxAnchors();
    expect(anchors.stride.length).toBe(8400);
    expect(anchors.stride[0]).toBe(8);
    expect(anchors.stride[6400]).toBe(16);
    expect(anchors.stride[8399]).toBe(32);
  });
  it("decodes only person boxes above the threshold and un-letterboxes", () => {
    const rows = 8400;
    const out = new Float32Array(rows * 85);
    const set = (row: number, v: { x: number; y: number; w: number; h: number; obj: number; cls0: number; cls1?: number }) => {
      out.set([v.x, v.y, v.w, v.h, v.obj, v.cls0, v.cls1 ?? 0], row * 85);
    };
    // stride-8 anchor (grid 10,20): centre = (10.5*8, 20.5*8) in 640 space, w = h = exp(ln 10) * 8 = 80
    set(20 * 80 + 10, { x: 0.5, y: 0.5, w: Math.log(10), h: Math.log(10), obj: 0.9, cls0: 0.9 });
    set(5, { x: 0.5, y: 0.5, w: Math.log(10), h: Math.log(10), obj: 0.9, cls0: 0.1, cls1: 0.95 }); // not a person
    const found = decodeYoloxPersons(out, 0.5, 320, 320, 0.35);
    expect(found).toHaveLength(1);
    expect(found[0]!.score).toBeCloseTo(0.81, 5);
    expect(found[0]!.box.x).toBeCloseTo((10.5 * 8 - 40) / 0.5, 3);
  });
});

describe("DB text post-processing", () => {
  it("sizes inputs as multiples of 32 within the long-side cap", () => {
    expect(dbInputSize(252, 448, 960)).toEqual({ w: 256, h: 448 });
    expect(dbInputSize(1280, 720, 640)).toEqual({ w: 640, h: 352 });
  });
  it("normalises per channel in B,G,R order with the (123.675, 116.28, 103.53) means", () => {
    const tensor = dbTensor(solid(32, 32, [104, 116, 124]), 32, 32); // R=104 ~ third mean, B=124 ~ first mean
    const plane = 32 * 32;
    expect(Math.abs(tensor[0]!)).toBeLessThan(0.02);
    expect(Math.abs(tensor[plane]!)).toBeLessThan(0.02);
    expect(Math.abs(tensor[2 * plane]!)).toBeLessThan(0.02);
  });
  it("finds connected high-probability blobs, unclips them and maps to source pixels", () => {
    const w = 64;
    const h = 64;
    const prob = new Float32Array(w * h);
    for (let y = 20; y < 24; y += 1) for (let x = 10; x < 40; x += 1) prob[y * w + x] = 0.9;
    for (let y = 50; y < 52; y += 1) prob[y * w + 5] = 0.9; // 1x2: below the min side
    for (let y = 40; y < 44; y += 1) for (let x = 10; x < 20; x += 1) prob[y * w + x] = 0.35; // above the binary threshold but under the 0.5 mean score
    const found = decodeDbText(prob, w, h, 128, 128);
    expect(found).toHaveLength(1);
    const box = found[0]!.box;
    expect(box.x).toBeLessThan(20); // unclipped outwards, x scaled by 2
    expect(box.x + box.w).toBeGreaterThan(80);
    expect(box.y).toBeLessThan(40);
  });
});
