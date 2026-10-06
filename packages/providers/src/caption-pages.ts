/**
 * V03-03 (owner request): a caption over the background shows at most 2 lines at a time, on every render path.
 *
 * The internal engine already lays captions out with `buildCaptionAss` (maxLines 2: shrink, then split into consecutive cues). A
 * Creatomate text element, however, wraps by itself inside its box, so a long voice-timed cue - and above all the static whole-scene
 * block used when a scene has no timed cues - could show 3-4+ lines at once. This module lays each caption block out with the SAME
 * line breaker (BudouX/kinsoku for Japanese, phrase boundaries, no font shrinking because the element's font size is fixed) and
 * splits it into consecutive pages of at most `MAX_CAPTION_LINES` lines, with explicit line breaks so the element does not re-wrap.
 *
 * Glyph widths are estimated (fonts are not measured), so a conservative width safety factor is used: a page may hold slightly fewer
 * characters than would really fit, never more. Page timing comes from the block's own span (proportional to its characters), the
 * same honest estimate the internal engine uses for a cue without per-character timing.
 */
import { buildCaptionAss, CREATOMATE_CAPTION_WIDTH_SAFETY, CREATOMATE_DEFAULT_CAPTION_WIDTH_FRACTION } from "@lyonix/domain";

export const MAX_CAPTION_LINES = 2;

/** Estimated glyph widths vs. the real Creatomate fonts (bold display fonts run wide): keep a clear margin. */
const CREATOMATE_WIDTH_SAFETY = CREATOMATE_CAPTION_WIDTH_SAFETY;
const DEFAULT_FONT_VMIN = 8;
const DEFAULT_WIDTH_FRACTION = CREATOMATE_DEFAULT_CAPTION_WIDTH_FRACTION;

export type CaptionBlock = { text: string; time: number; duration: number };
/** VE2E-93: `maxLines` comes from the caption style (1 or 2, never more than `MAX_CAPTION_LINES`). */
export type CaptionBox = { fontSize?: string | undefined; width?: string | undefined; maxLines?: 1 | 2 | undefined };
export type Canvas = { width: number; height: number };

/**
 * Creatomate length (`"8 vmin"`, `"6vw"`, `"86%"`, `"64 px"`, `"64"`) in canvas pixels; `null` when the unit is unknown. `percentOf`
 * is what `%` refers to (the composition width for a text box width); `%` is not accepted for a font size (its reference is unclear).
 */
export function creatomateLengthPx(value: string | undefined, canvas: Canvas, percentOf: number | null): number | null {
  const match = value?.trim().match(/^(-?\d+(?:\.\d+)?)\s*(vmin|vmax|vw|vh|px|%)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  switch ((match[2] ?? "px").toLowerCase()) {
    case "px": return amount;
    case "vw": return (amount / 100) * canvas.width;
    case "vh": return (amount / 100) * canvas.height;
    case "vmin": return (amount / 100) * Math.min(canvas.width, canvas.height);
    case "vmax": return (amount / 100) * Math.max(canvas.width, canvas.height);
    case "%": return percentOf === null ? null : (amount / 100) * percentOf;
    default: return null;
  }
}

/** Splits every caption block into consecutive pages of at most `MAX_CAPTION_LINES` lines that fit the text box (explicit `\n` breaks). */
export function paginateCaptionBlocks(blocks: readonly CaptionBlock[], box: CaptionBox, canvas: Canvas): CaptionBlock[] {
  const fontPx = creatomateLengthPx(box.fontSize, canvas, null) ?? (DEFAULT_FONT_VMIN / 100) * Math.min(canvas.width, canvas.height);
  const widthPx = creatomateLengthPx(box.width, canvas, canvas.width) ?? DEFAULT_WIDTH_FRACTION * canvas.width;
  const pages: CaptionBlock[] = [];
  for (const block of blocks) {
    if (!block.text.trim() || block.duration <= 0) continue;
    const startMs = Math.round(block.time * 1000);
    const endMs = Math.round((block.time + block.duration) * 1000);
    const { cues } = buildCaptionAss([{ text: block.text, startMs, endMs }], {
      canvas,
      fontSizePx: Math.round(fontPx),
      minFontSizePx: Math.round(fontPx),
      maxLines: Math.min(MAX_CAPTION_LINES, box.maxLines ?? MAX_CAPTION_LINES),
      highlight: "none",
      widthSafety: CREATOMATE_WIDTH_SAFETY,
      placement: { x: canvas.width / 2, y: canvas.height / 2, widthPx },
    });
    if (cues.length === 0) {
      pages.push(block);
      continue;
    }
    cues.forEach((cue, index) => {
      // The first page keeps the block's exact start, the last its exact end (no frame snapping at the edges of the block).
      const pageStart = index === 0 ? block.time : cue.startMs / 1000;
      const pageEnd = index === cues.length - 1 ? block.time + block.duration : cue.endMs / 1000;
      pages.push({ text: cue.lines.join("\n"), time: pageStart, duration: Math.max(0.05, pageEnd - pageStart) });
    });
  }
  return pages;
}
