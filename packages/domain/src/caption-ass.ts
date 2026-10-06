/**
 * VE2E-103: burned-in captions as an ASS (libass) document, shared by the internal FFmpeg engine and the
 * Studio player (same line-breaking function => the preview matches the render).
 *
 * Rules (docs/plans/self-render-engine.md §3):
 * - on-screen text is exactly the cue text (never rewritten); only line breaks / font size / cue splits are decided here;
 * - at most `maxLines` (2) lines; Japanese breaks only between BudouX phrases (a phrase is broken only when it alone
 *   exceeds a line) and obeys kinsoku (no `、。」』）！？`... at line start, no opening brackets at line end);
 * - too long for 2 lines: shrink the font down to `minFontSizePx`; still too long: split the cue into consecutive
 *   cues at phrase boundaries using the real per-character timing (or an honest proportional estimate, flagged);
 * - word highlight with `\k` per phrase; all event times are snapped to the video frame grid, then written with ASS's
 *   1/100 s resolution (extra error <= 5 ms, i.e. < 1 frame at 60 fps);
 * - text stays inside the TikTok safe zone (top 10 %, bottom 20 %, sides 12 % kept clear).
 *
 * Pure (no I/O, no fonts): text width is estimated with per-script em widths, so a conservative `widthSafety` factor
 * is applied. Browser-safe (subpath `@lyonix/domain/caption-ass`).
 */
import { loadDefaultJapaneseParser } from "budoux";
import { framesToMs } from "./render-plan.js";
import type { RenderPlan } from "./render-plan.js";

export const CAPTION_SAFE_ZONE = { top: 0.1, bottom: 0.2, side: 0.12 } as const;

/** Must not start a line (Japanese kinsoku, strict set incl. small kana and the long-vowel mark). */
export const KINSOKU_LINE_START = "、。，．,.」』）〕］｝〉》】！？!?：；:;ゝゞーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ々…‥・”’)]}";
/** Must not end a line. */
export const KINSOKU_LINE_END = "「『（〔［｛〈《【“‘([{";

export type CaptionLocale = "auto" | "ja" | "latin";

export type CaptionCharTiming = { startMs: number; endMs: number };

export type CaptionCueInput = {
  text: string;
  /** Absolute (video timeline) milliseconds. */
  startMs: number;
  endMs: number;
  /** One entry per code point of `text` (absolute ms). Without it the highlight timing is estimated. */
  charTimings?: readonly CaptionCharTiming[] | undefined;
  /** `#RRGGBB` colour of this cue's text (overrides the style colour; only meaningful with `highlight: "none"`). */
  color?: string | undefined;
  /**
   * VE2E-93: per-cue style (a scene's caption style override) on top of the document options. Each distinct style becomes its own ASS
   * `Style:` line (`Sub2`, `Sub3`, ...); cues without one use `Sub`, so a document without per-cue styles is unchanged.
   */
  style?: CaptionCueStyle | undefined;
};

/** The style fields a single cue may override (layout-wide settings - canvas, fps, placement, locale - stay document-wide). */
export type CaptionCueStyle = Partial<
  Pick<CaptionStyleOptions, "fontName" | "fontSizePx" | "minFontSizePx" | "maxLines" | "bold" | "textColor" | "highlightColor" | "outlineColor" | "outlinePx" | "highlight" | "verticalAnchor" | "marginVPercent">
>;

export type CaptionStyleOptions = {
  canvas?: { width: number; height: number };
  fps?: number;
  fontName?: string;
  fontSizePx?: number;
  minFontSizePx?: number;
  maxLines?: number;
  bold?: boolean;
  /** CSS hex colours. `highlightColor` is the already-spoken colour, `textColor` the not-yet-spoken one. */
  textColor?: string;
  highlightColor?: string;
  outlineColor?: string;
  outlinePx?: number;
  highlight?: "word" | "none";
  locale?: CaptionLocale;
  /** Safety factor on the available width, compensating the estimated (not measured) glyph widths. */
  widthSafety?: number;
  /**
   * Overlay text (e.g. a headline band) instead of the bottom-centre caption: text is centred on `(x, y)` (canvas px, ASS `\an5\pos`)
   * and wrapped inside `widthPx` instead of the safe-zone width. Margins are not used.
   */
  placement?: { x: number; y: number; widthPx: number } | undefined;
  /**
   * Caption position: bottom edge (default) or top edge `marginVPercent` of the canvas height away from that side, or (VE2E-93) centred
   * vertically on the canvas (`middle`, margin unused). Ignored with `placement`.
   */
  verticalAnchor?: "bottom" | "top" | "middle";
  marginVPercent?: number;
};

export type CaptionLaidOutCue = {
  startMs: number;
  endMs: number;
  fontSizePx: number;
  lines: string[];
  timing: "alignment" | "estimated";
  /** True when the source cue had to be split into several consecutive cues. */
  split: boolean;
};

export type CaptionAssResult = { ass: string; cues: CaptionLaidOutCue[]; warnings: string[] };

const DEFAULTS: Omit<Required<CaptionStyleOptions>, "placement"> = {
  verticalAnchor: "bottom",
  marginVPercent: CAPTION_SAFE_ZONE.bottom * 100,
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  fontName: "Noto Sans JP",
  fontSizePx: 64,
  minFontSizePx: 44,
  maxLines: 2,
  bold: true,
  textColor: "#FFFFFF",
  highlightColor: "#FFD400",
  outlineColor: "#000000",
  outlinePx: 5,
  highlight: "word",
  locale: "auto",
  widthSafety: 0.94,
};

// ---------------------------------------------------------------------------------------------------------------------
// frame / ASS time helpers

export const snapToFrameMs = (ms: number, fps: number): number => (Math.round((ms * fps) / 1000) * 1000) / fps;

const centiseconds = (ms: number): number => Math.round(ms / 10);

export function formatAssTime(ms: number): string {
  const totalCs = Math.max(0, centiseconds(ms));
  const cs = totalCs % 100;
  const totalSeconds = (totalCs - cs) / 100;
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** `#RRGGBB` -> ASS inline override colour `&HBBGGRR&` (for `{\\1c...}` tags). */
export function assOverrideColor(hex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) throw new Error(`invalid colour ${hex}`);
  const value = match[1]!;
  return `&H${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}&`.toUpperCase();
}

/** `#RRGGBB` -> ASS `&H00BBGGRR`. */
export function assColor(hex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) throw new Error(`invalid colour ${hex}`);
  const value = match[1]!;
  return `&H00${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`.toUpperCase();
}

// ---------------------------------------------------------------------------------------------------------------------
// width estimate + phrase segmentation

/** Estimated advance width of one code point in em. */
export function charWidthEm(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (ch === " " || ch === " ") return 0.3;
  if (cp >= 0xff61 && cp <= 0xff9f) return 0.5; // half-width katakana
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x3000 && cp <= 0x303f);
  if (wide) return 1;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[0-9]/.test(ch)) return 0.6;
  if (/[.,:;!'|il]/.test(ch)) return 0.34;
  return 0.58;
}

export const measureWidthEm = (text: string): number => Array.from(text).reduce((sum, ch) => sum + charWidthEm(ch), 0);

const CJK_RE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
const japaneseParser = loadDefaultJapaneseParser();

/** Splits text into unbreakable phrases (BudouX for Japanese, words + trailing space otherwise). `join("") === text` always. */
export function segmentPhrases(text: string, locale: CaptionLocale = "auto"): string[] {
  if (!text) return [];
  const useJapanese = locale === "ja" || (locale === "auto" && CJK_RE.test(text));
  if (useJapanese) {
    const phrases = japaneseParser.parse(text);
    if (phrases.join("") === text) return phrases;
  }
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

// ---------------------------------------------------------------------------------------------------------------------
// layout

type Glyph = { ch: string; startMs: number; endMs: number; unit: number };
type Range = { s: number; e: number }; // [s, e) indexes into the glyph array

type Prepared = { glyphs: Glyph[]; timing: "alignment" | "estimated"; unitCount: number };

function prepare(cue: CaptionCueInput, locale: CaptionLocale): Prepared | null {
  const original = Array.from(cue.text);
  const aligned = cue.charTimings && cue.charTimings.length === original.length && cue.charTimings.every((t) => Number.isFinite(t.startMs) && Number.isFinite(t.endMs));
  const kept: { ch: string; timing: CaptionCharTiming | null }[] = [];
  original.forEach((raw, index) => {
    const isSpace = /\s/.test(raw);
    const ch = isSpace ? " " : raw === "{" ? "（" : raw === "}" ? "）" : raw === "\\" ? "＼" : raw;
    if (isSpace && (kept.length === 0 || kept[kept.length - 1]!.ch === " ")) return;
    kept.push({ ch, timing: aligned ? cue.charTimings![index]! : null });
  });
  while (kept.length && kept[kept.length - 1]!.ch === " ") kept.pop();
  if (kept.length === 0 || cue.endMs <= cue.startMs) return null;

  const timings: CaptionCharTiming[] = [];
  if (aligned) {
    let cursor = cue.startMs;
    for (const item of kept) {
      const start = Math.min(Math.max(item.timing!.startMs, cursor), cue.endMs);
      const end = Math.min(Math.max(item.timing!.endMs, start), cue.endMs);
      timings.push({ startMs: start, endMs: end });
      cursor = start;
    }
  } else {
    const weights = kept.map((item) => charWidthEm(item.ch));
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (const weight of weights) {
      timings.push({ startMs: cue.startMs + ((cue.endMs - cue.startMs) * acc) / total, endMs: cue.startMs + ((cue.endMs - cue.startMs) * (acc + weight)) / total });
      acc += weight;
    }
  }

  const text = kept.map((item) => item.ch).join("");
  const phrases = segmentPhrases(text, locale);
  const glyphs: Glyph[] = [];
  let index = 0;
  phrases.forEach((phrase, unit) => {
    for (const ch of Array.from(phrase)) {
      glyphs.push({ ch, startMs: timings[index]!.startMs, endMs: timings[index]!.endMs, unit });
      index += 1;
    }
  });
  return { glyphs, timing: aligned ? "alignment" : "estimated", unitCount: phrases.length };
}

const widthOf = (glyphs: Glyph[], range: Range): number => {
  let end = range.e;
  while (end > range.s && glyphs[end - 1]!.ch === " ") end -= 1; // trailing spaces never count towards the fit
  let sum = 0;
  for (let i = range.s; i < end; i += 1) sum += charWidthEm(glyphs[i]!.ch);
  return sum;
};

/** Greedy line fill over [from, to) at phrase boundaries; a phrase wider than one line is broken per character. */
function wrapRange(glyphs: Glyph[], from: number, to: number, maxWidthEm: number): Range[] {
  const lines: Range[] = [];
  let line: Range | null = null;
  let i = from;
  while (i < to) {
    let j = i;
    while (j < to && glyphs[j]!.unit === glyphs[i]!.unit) j += 1;
    const phrase: Range = { s: i, e: j };
    const phraseWidth = widthOf(glyphs, phrase);
    if (line && widthOf(glyphs, { s: line.s, e: j }) <= maxWidthEm) {
      line.e = j;
    } else if (phraseWidth <= maxWidthEm) {
      line = { s: i, e: j };
      lines.push(line);
    } else {
      // oversized phrase: fill the current line, then break per character
      let k = i;
      if (!line) {
        line = { s: i, e: i };
        lines.push(line);
      }
      while (k < j) {
        if (line.e > line.s && widthOf(glyphs, { s: line.s, e: k + 1 }) > maxWidthEm) {
          line = { s: k, e: k };
          lines.push(line);
        }
        k += 1;
        line.e = k;
      }
    }
    i = j;
  }
  return lines;
}

function applyKinsoku(glyphs: Glyph[], lines: Range[], maxWidthEm: number): void {
  for (let guard = 0; guard < 6; guard += 1) {
    let changed = false;
    for (let n = 1; n < lines.length; n += 1) {
      const prev = lines[n - 1]!;
      const next = lines[n]!;
      // 1) a prohibited character at the start of the next line: hang it on the previous line (oikomi) or push a character down (oidashi)
      while (next.e - next.s > 1 && KINSOKU_LINE_START.includes(glyphs[next.s]!.ch)) {
        if (widthOf(glyphs, { s: prev.s, e: prev.e + 1 }) <= maxWidthEm * 1.08) {
          prev.e += 1;
          next.s += 1;
        } else if (prev.e - prev.s > 1) {
          prev.e -= 1;
          next.s -= 1;
        } else break;
        changed = true;
      }
      // 2) an opening bracket at the end of the previous line moves down with the text it opens
      while (prev.e - prev.s > 1 && KINSOKU_LINE_END.includes(glyphs[prev.e - 1]!.ch)) {
        prev.e -= 1;
        next.s -= 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

type FitResult = { fontSizePx: number; lines: Range[] } | null;
type ResolvedOptions = Required<Omit<CaptionStyleOptions, "canvas" | "placement">> & { canvas: { width: number; height: number }; placement: CaptionStyleOptions["placement"] };

function fit(glyphs: Glyph[], from: number, to: number, o: ResolvedOptions, sizes: number[]): FitResult {
  const availablePx = (o.placement?.widthPx ?? o.canvas.width * (1 - 2 * CAPTION_SAFE_ZONE.side)) * o.widthSafety;
  for (const size of sizes) {
    const lines = wrapRange(glyphs, from, to, availablePx / size);
    applyKinsoku(glyphs, lines, availablePx / size);
    if (lines.length <= o.maxLines && lines.every((l) => widthOf(glyphs, l) <= (availablePx / size) * 1.1)) return { fontSizePx: size, lines };
  }
  return null;
}

const sizeLadder = (max: number, min: number): number[] => {
  const sizes: number[] = [];
  for (let size = max; size > min; size -= 4) sizes.push(size);
  sizes.push(min);
  return sizes;
};

/** Splits [0, glyphs.length) into consecutive pages that each fit `maxLines` at `size`, always at phrase boundaries when possible. */
function paginate(glyphs: Glyph[], o: ResolvedOptions, size: number): Range[] {
  const pages: Range[] = [];
  const total = glyphs.length;
  let start = 0;
  while (start < total) {
    let end = start;
    let best = -1;
    // grow by whole phrases while the page still fits
    while (end < total) {
      let next = end;
      while (next < total && glyphs[next]!.unit === glyphs[end]!.unit) next += 1;
      if (fit(glyphs, start, next, o, [size])) {
        best = next;
        end = next;
      } else break;
    }
    if (best === -1) {
      // a single phrase does not fit by itself: grow per character
      let k = start;
      while (k < total && fit(glyphs, start, k + 1, o, [size])) k += 1;
      best = Math.max(k, start + 1);
    }
    pages.push({ s: start, e: best });
    start = best;
  }
  return pages;
}

// ---------------------------------------------------------------------------------------------------------------------
// ASS writer

function eventText(glyphs: Glyph[], lines: Range[], eventStartMs: number, fontSizePx: number, baseFontSizePx: number, highlight: boolean, placement: CaptionStyleOptions["placement"], color?: string): string {
  let out = color && !highlight ? `{\\1c${assOverrideColor(color)}}` : "";
  out += placement ? `{\\an5\\pos(${Math.round(placement.x)},${Math.round(placement.y)})}` : "";
  if (fontSizePx !== baseFontSizePx) out += `{\\fs${fontSizePx}}`;
  let cursorCs = 0;
  let lastUnit = -1;
  lines.forEach((line, lineIndex) => {
    let s = line.s;
    let e = line.e;
    while (s < e && glyphs[s]!.ch === " ") s += 1; // spaces at a break are dropped
    while (e > s && glyphs[e - 1]!.ch === " ") e -= 1;
    if (lineIndex > 0) out += "\\N";
    for (let i = s; i < e; i += 1) {
      const glyph = glyphs[i]!;
      if (glyph.unit !== lastUnit) {
        lastUnit = glyph.unit;
        if (highlight) {
          let unitStart = Infinity;
          let unitEnd = -Infinity;
          for (const g of glyphs) {
            if (g.unit !== glyph.unit || g.ch === " ") continue;
            unitStart = Math.min(unitStart, g.startMs);
            unitEnd = Math.max(unitEnd, g.endMs);
          }
          if (Number.isFinite(unitStart)) {
            const startCs = Math.max(centiseconds(unitStart - eventStartMs), cursorCs);
            const endCs = Math.max(centiseconds(unitEnd - eventStartMs), startCs);
            if (startCs > cursorCs) out += `{\\k${startCs - cursorCs}}`;
            out += `{\\k${endCs - startCs}}`;
            cursorCs = endCs;
          }
        }
      }
      out += glyph.ch;
    }
  });
  return out;
}

const CUE_STYLE_KEYS = ["fontName", "fontSizePx", "minFontSizePx", "maxLines", "bold", "textColor", "highlightColor", "outlineColor", "outlinePx", "highlight", "verticalAnchor", "marginVPercent"] as const;

const styleKey = (o: ResolvedOptions): string => JSON.stringify(CUE_STYLE_KEYS.map((key) => o[key]));

function styleLine(name: string, o: ResolvedOptions): string {
  const marginLR = Math.round(o.canvas.width * CAPTION_SAFE_ZONE.side);
  const marginV = Math.round((o.canvas.height * o.marginVPercent) / 100);
  // ASS numpad alignment: 2 = bottom centre, 8 = top centre, 5 = middle centre (vertical margin unused)
  const alignment = o.verticalAnchor === "top" ? 8 : o.verticalAnchor === "middle" ? 5 : 2;
  const primary = o.highlight === "word" ? o.highlightColor : o.textColor;
  return `Style: ${name},${o.fontName},${o.fontSizePx},${assColor(primary)},${assColor(o.textColor)},${assColor(o.outlineColor)},&H64000000,${o.bold ? -1 : 0},0,0,0,100,100,0,0,1,${o.outlinePx},0,${alignment},${marginLR},${marginLR},${marginV},1`;
}

export function buildCaptionAss(cues: readonly CaptionCueInput[], options: CaptionStyleOptions = {}): CaptionAssResult {
  const base = { ...DEFAULTS, ...options, canvas: options.canvas ?? DEFAULTS.canvas, placement: options.placement } as ResolvedOptions;
  const warnings: string[] = [];
  const frameMs = 1000 / base.fps;
  const laidOut: CaptionLaidOutCue[] = [];
  const bodies: string[] = [];
  const cueStyleNames: string[] = [];

  // VE2E-93: one ASS style per distinct cue style; `Sub` (the document options) always comes first.
  const styles: Array<{ name: string; key: string; o: ResolvedOptions }> = [{ name: "Sub", key: styleKey(base), o: base }];
  const styleFor = (cue: CaptionCueInput) => {
    if (!cue.style) return styles[0]!;
    const defined = Object.fromEntries(Object.entries(cue.style).filter(([, value]) => value !== undefined));
    const o = { ...base, ...defined } as ResolvedOptions;
    const key = styleKey(o);
    let found = styles.find((style) => style.key === key);
    if (!found) {
      found = { name: `Sub${styles.length + 1}`, key, o };
      styles.push(found);
    }
    return found;
  };

  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);

  ordered.forEach((cue) => {
    const prepared = prepare(cue, base.locale);
    if (!prepared) return;
    const { name: styleName, o } = styleFor(cue);
    const highlight = o.highlight === "word";
    const sizes = sizeLadder(o.fontSizePx, Math.min(o.minFontSizePx, o.fontSizePx));
    const minSize = sizes[sizes.length - 1]!;
    const { glyphs } = prepared;
    const whole = fit(glyphs, 0, glyphs.length, o, sizes);
    const pages: Array<{ range: Range; size: number; lines: Range[] }> = [];
    if (whole) {
      pages.push({ range: { s: 0, e: glyphs.length }, size: whole.fontSizePx, lines: whole.lines });
    } else {
      for (const range of paginate(glyphs, o, minSize)) {
        const result = fit(glyphs, range.s, range.e, o, [minSize]);
        // `paginate` only emits pages that fit; the fallback keeps the text rather than dropping it.
        pages.push({ range, size: minSize, lines: result?.lines ?? wrapRange(glyphs, range.s, range.e, 99) });
      }
      warnings.push(`cue "${cue.text.slice(0, 20)}…" tách thành ${pages.length} cue ở cỡ chữ tối thiểu ${minSize}px`);
    }
    pages.forEach((page, index) => {
      const first = glyphs[page.range.s]!;
      const nextFirst = pages[index + 1] ? glyphs[pages[index + 1]!.range.s]! : null;
      let startMs = snapToFrameMs(index === 0 ? cue.startMs : first.startMs, base.fps);
      let endMs = snapToFrameMs(nextFirst ? nextFirst.startMs : cue.endMs, base.fps);
      if (endMs < startMs + frameMs - 0.001) endMs = startMs + frameMs;
      const prev = laidOut[laidOut.length - 1];
      if (prev && prev.endMs > startMs) prev.endMs = Math.max(prev.startMs + frameMs, startMs); // never overlap the previous event
      if (prev && prev.endMs > startMs) startMs = prev.endMs;
      if (endMs < startMs + frameMs - 0.001) endMs = startMs + frameMs;
      const body = eventText(glyphs.slice(page.range.s, page.range.e), page.lines.map((l) => ({ s: l.s - page.range.s, e: l.e - page.range.s })), startMs, page.size, o.fontSizePx, highlight, base.placement, cue.color);
      const lines = page.lines.map((l) => glyphs.slice(l.s, l.e).map((g) => g.ch).join("").trim());
      laidOut.push({ startMs, endMs, fontSizePx: page.size, lines, timing: prepared.timing, split: pages.length > 1 });
      bodies.push(body);
      cueStyleNames.push(styleName);
    });
  });
  // end times are written from the final layout: a later cue may have shortened an earlier one
  const dialogue = laidOut.map((cue, index) => `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},${cueStyleNames[index]!},,0,0,0,,${bodies[index]!}`);

  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${base.canvas.width}`,
    `PlayResY: ${base.canvas.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    // the render is BT.709 limited range: without this libass would map the colours with BT.601
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    ...styles.map((style) => styleLine(style.name, style.o)),
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...dialogue,
    "",
  ].join("\n");
  return { ass, cues: laidOut, warnings };
}

/** Caption cues of a RenderPlan on the absolute video timeline (a scene with only a static text becomes one cue over the whole scene). */
export function captionCuesFromRenderPlan(plan: RenderPlan): CaptionCueInput[] {
  const cues: CaptionCueInput[] = [];
  for (const scene of plan.scenes) {
    if (scene.captionCues.length > 0) {
      for (const cue of scene.captionCues) {
        cues.push({
          text: cue.text,
          startMs: scene.startMs + cue.startMs,
          endMs: scene.startMs + cue.endMs,
          ...(cue.charTimings ? { charTimings: cue.charTimings.map((t) => ({ startMs: scene.startMs + t.startMs, endMs: scene.startMs + t.endMs })) } : {}),
        });
      }
    } else if (scene.text) {
      cues.push({ text: scene.text, startMs: scene.startMs, endMs: scene.startMs + scene.durationMs });
    }
  }
  return cues;
}

export const buildCaptionAssFromRenderPlan = (plan: RenderPlan, options: CaptionStyleOptions = {}): CaptionAssResult =>
  buildCaptionAss(captionCuesFromRenderPlan(plan), { fps: plan.fps, canvas: plan.canvas, ...options });

/**
 * Maps caption segments onto a character-level TTS alignment (ElevenLabs shape, seconds), ignoring whitespace on
 * both sides. Returns per-code-point timings (ms, relative to the audio start) for every segment, or `null` for a
 * segment whose non-space characters do not match the alignment sequentially (the caller then keeps estimated timing).
 *
 * V03-03: a user-edited cue (text no longer equal to what was voiced) is such a `null` segment. When the segment carries its
 * own `endMs`, the alignment characters voiced before that time are skipped, so the cues AFTER an edited one still get their
 * real timing instead of all falling back to the estimate.
 */
export function charTimingsForSegments(
  alignment: { characters: string[]; characterStartTimesSeconds: number[]; characterEndTimesSeconds: number[] },
  segments: readonly { text: string; endMs?: number }[],
): Array<CaptionCharTiming[] | null> {
  const chars = alignment.characters;
  const usable = chars.length === alignment.characterStartTimesSeconds.length && chars.length === alignment.characterEndTimesSeconds.length;
  let cursor = 0;
  const skipPast = (endMs: number | undefined) => {
    if (typeof endMs !== "number") return;
    while (cursor < chars.length && Math.round(alignment.characterStartTimesSeconds[cursor]! * 1000) < endMs) cursor += 1;
  };
  return segments.map((segment) => {
    if (!usable) return null;
    const result: CaptionCharTiming[] = [];
    let at = cursor;
    let lastEnd = 0;
    for (const ch of Array.from(segment.text)) {
      if (/\s/.test(ch)) {
        result.push({ startMs: lastEnd, endMs: lastEnd });
        continue;
      }
      while (at < chars.length && /^\s*$/.test(chars[at]!)) at += 1;
      if (at >= chars.length || chars[at] !== ch) {
        skipPast(segment.endMs);
        return null;
      }
      const startMs = Math.round(alignment.characterStartTimesSeconds[at]! * 1000);
      const endMs = Math.round(alignment.characterEndTimesSeconds[at]! * 1000);
      result.push({ startMs, endMs });
      lastEnd = endMs;
      at += 1;
    }
    cursor = at;
    return result;
  });
}

/** Absolute frame time for a frame index - exported so QC/tests use the same grid as the writer. */
export const frameTimeMs = (frame: number, fps: number): number => framesToMs(frame, fps);
