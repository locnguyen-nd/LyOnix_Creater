/**
 * VE2E-130 (CR-MEDIA-SLA §3.1, L6): the last rung of the media ladder. There is no per-channel brand-background asset mechanism yet,
 * so this builds a 1080x1920 PNG IN PROCESS (zlib only; no FFmpeg, no provider call) that the media step registers as a
 * `generated` asset flagged `placeholder: brand_background` + `qualityDegraded`. Colour: env `MEDIA_BRAND_BACKGROUND_COLOR` (`#RRGGBB`).
 *
 * VE2E-157: a designed SET instead of one flat colour. A flat picture is an empty frame on screen and does not move under the engine's zoom
 * (QC_FREEZE); each variant is built from the brand colour: a vertical gradient, a soft glow, diagonal light lines, a fine dot grid and a
 * vignette - texture the zoom visibly moves, never white, never text. Consecutive fallback scenes take the next variant.
 */
import { deflateSync } from "node:zlib";

export const BRAND_BACKGROUND_WIDTH = 1080;
export const BRAND_BACKGROUND_HEIGHT = 1920;
export const DEFAULT_BRAND_BACKGROUND_COLOR = "#0B1220";
export const BRAND_BACKGROUND_VARIANTS = 4;

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

/** Layout of one variant (fractions of the canvas): where the glow sits, the angle and phase of the light lines, the dot grid offset. */
const VARIANTS: ReadonlyArray<{ glow: [number, number]; angleDeg: number; phase: number; dotOffset: number }> = [
  { glow: [0.82, 0.16], angleDeg: 28, phase: 0, dotOffset: 0 },
  { glow: [0.18, 0.82], angleDeg: -28, phase: 0.35, dotOffset: 12 },
  { glow: [0.5, 0.06], angleDeg: 36, phase: 0.6, dotOffset: 24 },
  { glow: [0.9, 0.62], angleDeg: -36, phase: 0.15, dotOffset: 36 },
];

/** Highest luma of a brand background stays far from white (QC_WHITE_FRAMES, captions stay readable on it). */
export const BRAND_BACKGROUND_MAX_LIGHTEN = 0.45;

const cache = new Map<string, Buffer>();

/**
 * One variant of the designed brand background as an RGB PNG. Deterministic (same colour + variant + size => same bytes), cached; the
 * structured texture compresses to under a megabyte.
 */
export const buildBrandBackgroundPng = (color: string = DEFAULT_BRAND_BACKGROUND_COLOR, width = BRAND_BACKGROUND_WIDTH, height = BRAND_BACKGROUND_HEIGHT, variant = 0): Buffer => {
  const index = ((variant % BRAND_BACKGROUND_VARIANTS) + BRAND_BACKGROUND_VARIANTS) % BRAND_BACKGROUND_VARIANTS;
  const key = `${color}:${width}x${height}:${index}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const layout = VARIANTS[index]!;
  const base = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)] as const;
  const angle = (layout.angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Structure sized so the engine's slowest photo zoom (+5 % over a scene, in a 46 % picture band) still moves the picture beyond the QC's
  // freezedetect tolerance: broad soft bands, a fine line pattern and a dot grid (measured with the QC's own detector, see the tests).
  const bandPeriod = 520;
  const linePeriod = 90;
  const glowX = layout.glow[0] * width;
  const glowY = layout.glow[1] * height;
  const glowRadius = 0.85 * width;
  const grid = 36;
  const dot = 8;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    const t = y / (height - 1);
    const vy = (y - height / 2) / (height / 2);
    for (let x = 0; x < width; x += 1) {
      // lighten (towards white) and darken (towards black) amounts, 0..1
      let lighten = 0.1 * (1 - t);
      let darken = 0.35 * t;
      const dx = x - glowX;
      const dy = y - glowY;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / glowRadius);
      lighten += 0.24 * glow * glow;
      const along = x * cos + y * sin;
      const band = Math.sin(2 * Math.PI * (along / bandPeriod + layout.phase));
      lighten += 0.08 * band * band;
      const line = Math.sin(2 * Math.PI * (along / linePeriod + layout.phase));
      if (line > 0) lighten += 0.16 * line ** 16;
      if ((x + layout.dotOffset) % grid < dot && (y + layout.dotOffset) % grid < dot) lighten += 0.2;
      const vx = (x - width / 2) / (width / 2);
      darken += 0.3 * Math.min(1, (vx * vx + vy * vy) / 2);
      lighten = Math.min(BRAND_BACKGROUND_MAX_LIGHTEN, lighten);
      darken = Math.min(0.8, darken);
      const offset = row + 1 + x * 3;
      for (let c = 0; c < 3; c += 1) {
        const lit = base[c]! + (255 - base[c]!) * lighten;
        raw[offset + c] = Math.round(lit * (1 - darken));
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  cache.set(key, png);
  return png;
};
