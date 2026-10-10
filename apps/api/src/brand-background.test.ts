import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BRAND_BACKGROUND_MAX_LIGHTEN, BRAND_BACKGROUND_VARIANTS, buildBrandBackgroundPng } from "./brand-background.js";

/** Decodes the PNGs this module writes (8-bit RGB, one IDAT, filter 0 on every row) into luma rows. */
function lumaOf(png: Buffer): { width: number; height: number; luma: Float64Array } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const luma = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    expect(raw[row]).toBe(0);
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 3;
      luma[y * width + x] = 0.2126 * raw[p]! + 0.7152 * raw[p + 1]! + 0.0722 * raw[p + 2]!;
    }
  }
  return { width, height, luma };
}

describe("VE2E-157 designed brand background set (L6 fallback)", () => {
  it("is a 1080x1920 PNG per variant, deterministic, and the variants differ", () => {
    const pngs = Array.from({ length: BRAND_BACKGROUND_VARIANTS }, (_, variant) => buildBrandBackgroundPng("#0B1220", 1080, 1920, variant));
    expect(new Set(pngs.map((png) => png.toString("base64"))).size).toBe(BRAND_BACKGROUND_VARIANTS);
    expect(buildBrandBackgroundPng("#0B1220", 1080, 1920, 1).equals(pngs[1]!)).toBe(true);
    expect(buildBrandBackgroundPng("#0B1220", 1080, 1920, BRAND_BACKGROUND_VARIANTS + 1).equals(pngs[1]!)).toBe(true); // wraps around
    expect(pngs[0]!.readUInt32BE(16)).toBe(1080);
    expect(pngs[0]!.readUInt32BE(20)).toBe(1920);
    for (const png of pngs) expect(png.byteLength).toBeLessThan(1_500_000);
  });

  it("is never blank: textured (the engine's zoom visibly moves it, no QC_FREEZE) and never close to white (no QC_WHITE_FRAMES), even for a light brand colour", () => {
    for (const color of ["#0B1220", "#C8102E", "#E8E8E8"]) {
      for (let variant = 0; variant < BRAND_BACKGROUND_VARIANTS; variant += 1) {
        const { luma } = lumaOf(buildBrandBackgroundPng(color, 270, 480, variant));
        const mean = luma.reduce((sum, value) => sum + value, 0) / luma.length;
        const sd = Math.sqrt(luma.reduce((sum, value) => sum + (value - mean) ** 2, 0) / luma.length);
        expect(sd, `${color} v${variant}`).toBeGreaterThan(3); // gradient + glow + lines + dots
        const nearWhite = luma.filter((value) => value > 0.94 * 255).length / luma.length;
        expect(nearWhite, `${color} v${variant}`).toBeLessThan(0.5);
      }
    }
    const dark = lumaOf(buildBrandBackgroundPng("#0B1220", 270, 480, 0)).luma;
    expect(dark.reduce((max, value) => Math.max(max, value), 0)).toBeLessThan(255 * (BRAND_BACKGROUND_MAX_LIGHTEN + 0.05));
  });
});

// The engine's slowest photo zoom must visibly move every variant, also in the 46 % picture band of a band recipe: the QC's own
// freezedetect (-55 dB, 1 s, on a 360x640 copy) over the engine's scale expression. Needs FFmpeg (FFMPEG_PATH or on PATH); skipped otherwise.
const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout?.includes("freezedetect") ?? false;

describe.skipIf(!hasFfmpeg)("VE2E-157 brand background under the engine's zoom (real FFmpeg)", () => {
  it("no variant is a frozen picture for the QC, full frame or picture band, at the slowest library zoom (+5 % over 4 s)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyonix-brand-bg-"));
    try {
      const frozen: string[] = [];
      for (let variant = 0; variant < BRAND_BACKGROUND_VARIANTS; variant += 1) {
        const file = join(dir, `v${variant}.png`);
        writeFileSync(file, buildBrandBackgroundPng("#0B1220", 1080, 1920, variant));
        for (const [label, w, h, pad] of [["full", 1080, 1920, ""], ["band", 1080, 884, ",pad=1080:1920:0:710:color=0x121212"]] as const) {
          const zoom = "1+0.05*t/4";
          const graph = `fps=60,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},scale=w='trunc(${w}*(${zoom})/2)*2':h='trunc(${h}*(${zoom})/2)*2':eval=frame:flags=bicubic,crop=${w}:${h}${pad},format=yuv420p,scale=360:640:flags=fast_bilinear,freezedetect=n=-55dB:d=1`;
          const run = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-nostats", "-v", "info", "-loop", "1", "-framerate", "60", "-t", "4", "-i", file, "-vf", graph, "-f", "null", "-"], { encoding: "utf8" });
          expect(run.status, run.stderr.slice(-300)).toBe(0);
          if (/freeze_start/.test(run.stderr)) frozen.push(`v${variant}/${label}`);
        }
      }
      expect(frozen).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
