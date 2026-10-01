/**
 * VE2E-30 pure logic for `frame.extract`: where to sample, the FFmpeg arguments and a JPEG size reader.
 * No I/O so every rule is unit-testable without FFmpeg.
 */

/** Head/tail margin skipped when no window is given (intros, outros, watermark end cards). */
export const FRAME_HEAD_MARGIN_RATIO = 0.05;
export const FRAME_TAIL_MARGIN_RATIO = 0.08;
/** JPEG `-q:v` tiers tried in order until a frame fits the byte cap (2 = best ... 31 = worst). */
export const FRAME_QUALITY_TIERS = [4, 8, 14, 22] as const;

const MIN_USABLE_MS = 200;

/**
 * Evenly spaced sample points (ms) inside `[start, start+duration]`, centred in equal slices so one frame never sits on the
 * very first/last instant. A source shorter than the window is sampled over its own length. At most `frameCount` points.
 */
export function sampleTimesMs(input: { sourceDurationMs: number; frameCount: number; windowStartMs?: number | null; windowDurationMs?: number | null }): number[] {
  const source = Math.max(0, Math.floor(input.sourceDurationMs));
  const count = Math.max(1, Math.floor(input.frameCount));
  let start: number;
  let length: number;
  if (input.windowStartMs !== null && input.windowStartMs !== undefined) {
    start = Math.min(Math.max(0, Math.floor(input.windowStartMs)), Math.max(0, source - MIN_USABLE_MS));
    const wanted = input.windowDurationMs ?? source - start;
    length = Math.min(Math.max(MIN_USABLE_MS, Math.floor(wanted)), Math.max(MIN_USABLE_MS, source - start));
  } else {
    start = Math.floor(source * FRAME_HEAD_MARGIN_RATIO);
    length = Math.max(MIN_USABLE_MS, source - start - Math.floor(source * FRAME_TAIL_MARGIN_RATIO));
  }
  if (source <= MIN_USABLE_MS) return [0];
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = Math.round(start + (length * (index + 0.5)) / count);
    times.push(Math.min(at, Math.max(0, source - 100)));
  }
  return [...new Set(times)];
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

/** One JPEG frame at `atMs`, scaled DOWN to `maxWidth` (never up), even height, no metadata. */
export function buildFrameArgs(inputPath: string, atMs: number, outputPath: string, maxWidth: number, quality: number): string[] {
  return [
    "-hide_banner", "-nostdin", "-v", "error", "-y",
    "-ss", seconds(atMs), "-i", inputPath,
    "-map", "0:v:0", "-frames:v", "1",
    "-vf", `scale='min(${maxWidth},iw)':-2`,
    "-q:v", String(quality),
    "-an", "-sn", "-dn", "-map_metadata", "-1",
    "-f", "image2", "-c:v", "mjpeg", outputPath,
  ];
}

/** Reads width/height from a JPEG's SOF marker; null when the bytes are not a readable JPEG. */
export function readJpegSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
