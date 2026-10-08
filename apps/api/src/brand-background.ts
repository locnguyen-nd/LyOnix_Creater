/**
 * VE2E-130 (CR-MEDIA-SLA §3.1, L6): the last rung of the media ladder. There is no per-channel brand-background asset mechanism yet,
 * so this builds a flat-colour 1080x1920 PNG IN PROCESS (zlib only; no FFmpeg, no provider call) that the media step registers as a
 * `generated` asset flagged `placeholder: brand_background` + `qualityDegraded`. Colour: env `MEDIA_BRAND_BACKGROUND_COLOR` (`#RRGGBB`).
 */
import { deflateSync } from "node:zlib";

export const BRAND_BACKGROUND_WIDTH = 1080;
export const BRAND_BACKGROUND_HEIGHT = 1920;
export const DEFAULT_BRAND_BACKGROUND_COLOR = "#0B1220";

export const brandBackgroundColorFromEnv = (env: Record<string, string | undefined> = process.env): string => {
  const value = env.MEDIA_BRAND_BACKGROUND_COLOR?.trim();
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : DEFAULT_BRAND_BACKGROUND_COLOR;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const cache = new Map<string, Buffer>();

/** Solid-colour RGB PNG. Cached per colour (the compressed result is a few KB). */
export const buildBrandBackgroundPng = (color: string = DEFAULT_BRAND_BACKGROUND_COLOR, width = BRAND_BACKGROUND_WIDTH, height = BRAND_BACKGROUND_HEIGHT): Buffer => {
  const key = `${color}:${width}x${height}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  cache.set(key, png);
  return png;
};
