/**
 * VE2E-96 (URL intake): turning a video's subtitles / speech-to-text output or an article into clean source text, and the checks the
 * rewrite step needs (language, length, how close a rewrite stays to its source). Pure, browser-safe (subpath `@lyonix/domain/transcript`).
 */

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decodeEntities = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
    if (NAMED_ENTITIES[ref.toLowerCase()]) return NAMED_ENTITIES[ref.toLowerCase()]!;
    if (ref[0] !== "#") return match;
    const code = ref[1]?.toLowerCase() === "x" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });

const TIMING = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?/;

/**
 * The text of each cue of a WebVTT / SRT document, in order (header, NOTE / STYLE / REGION blocks, cue ids, timings, markup dropped).
 * A document that is plain text gives its non-empty lines.
 */
export function parseSubtitleDocument(document: string): string[] {
  const lines = document.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: string[] = [];
  let current: string[] = [];
  let skippingBlock = false;
  const flush = () => {
    if (current.length) cues.push(current.join(" "));
    current = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) {
      flush();
      skippingBlock = false;
      continue;
    }
    if (skippingBlock) continue;
    if (index === 0 && /^WEBVTT\b/.test(line)) { skippingBlock = true; continue; }
    if (/^(NOTE|STYLE|REGION)\b/.test(line)) { flush(); skippingBlock = true; continue; }
    if (TIMING.test(line)) { flush(); continue; }
    // a cue id: the line right before a timing line (numbers in SRT, any id in WebVTT)
    if (index + 1 < lines.length && TIMING.test(lines[index + 1]!)) continue;
    const text = decodeEntities(line.replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "")).trim();
    if (text) current.push(text);
  }
  flush();
  return cues;
}

const CJK = /[぀-ヿ㐀-鿿가-힯ｦ-ﾟ]/;
const isCjkHeavy = (text: string) => {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  return letters.length > 0 && letters.filter((char) => CJK.test(char)).length / letters.length > 0.3;
};

// eslint-disable-next-line no-control-regex
const JUNK = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\uFFFD]/g;
const SOUND_TAG = /[[(（【［]\s*(music|applause|laughter|laughs|cheering|silence|inaudible|音楽|拍手|笑い|笑|BGM|効果音|음악|박수|웃음|nhạc|vỗ tay|cười|__)\s*[\])）】］]/gi;
const INLINE_TIME = /[[(（]?\b\d{1,2}:\d{2}(:\d{2})?([.,]\d{1,3})?\b[\])）]?/g;

/** One cue / line of text without timestamps, sound tags, music notes, emoji, invisible characters or extra spaces. */
export const cleanTranscriptLine = (line: string): string =>
  line
    .replace(JUNK, " ")
    .replace(INLINE_TIME, " ")
    .replace(SOUND_TAG, " ")
    .replace(/[♪♫♬♩]+/g, " ")
    .replace(/\p{Extended_Pictographic}️?/gu, " ")
    .replace(/(^|\s)>>\s*/g, "$1")
    .replace(/([!?！？。、,.])\1{2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const comparable = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

/**
 * Clean transcript text from cues: rolling / repeated captions merged (a cue that repeats or extends the previous one), sentences said
 * twice in a row dropped, long sentences repeated later dropped. Names, numbers and wording are kept as spoken.
 */
export function cleanTranscript(cues: readonly string[] | string): string {
  const input = typeof cues === "string" ? cues.split(/\n+/) : [...cues];
  const kept: string[] = [];
  for (const raw of input) {
    const cue = cleanTranscriptLine(raw);
    if (!cue) continue;
    const previous = kept.at(-1);
    if (previous !== undefined) {
      const a = comparable(previous);
      const b = comparable(cue);
      if (!b || a === b || a.endsWith(b)) continue; // same caption again
      if (b.startsWith(a)) { kept[kept.length - 1] = cue; continue; } // a rolling caption that grew
    }
    kept.push(cue);
  }
  const joiner = isCjkHeavy(kept.join("")) ? "" : " ";
  const text = kept.join(joiner);
  // sentence pass: drop a sentence equal to the one before it, and a long sentence (>= 12 chars) said again later
  const sentences = text.match(/[^。！？!?.]+[。！？!?.]*/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sentence of sentences) {
    const key = comparable(sentence);
    if (!key) continue;
    if (out.length && comparable(out.at(-1)!) === key) continue;
    if (key.length >= 12 && seen.has(key)) continue;
    seen.add(key);
    out.push(sentence.trim());
  }
  return out.join(joiner).replace(/\s+/g, " ").trim();
}

/** A language guess from the script of the text: kana -> ja, hangul -> ko, CJK without kana -> zh, Vietnamese letters -> vi, Latin -> en. */
export function detectTextLanguage(text: string): "ja" | "ko" | "zh" | "vi" | "en" | null {
  const sample = text.slice(0, 4000);
  const count = (pattern: RegExp) => sample.match(pattern)?.length ?? 0;
  const kana = count(/[぀-ヿ]/g);
  const hangul = count(/[가-힯]/g);
  const han = count(/[㐀-鿿]/g);
  const latin = count(/[a-zA-ZÀ-ɏḀ-ỿ]/g);
  const vietnamese = count(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi);
  if (kana > 0 && kana + han >= latin * 0.5) return "ja";
  if (hangul > 0 && hangul >= latin * 0.5) return "ko";
  if (han > 0 && han >= latin * 0.5) return "zh";
  if (vietnamese >= 3) return "vi";
  if (latin > 0) return "en";
  return null;
}

/** Words (CJK counted by the word segmenter, so Japanese is not one "word"). */
export function countWords(text: string): number {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: "word" }) => { segment(input: string): Iterable<{ isWordLike?: boolean }> } }).Segmenter;
  if (Segmenter) {
    let words = 0;
    for (const part of new Segmenter(undefined, { granularity: "word" }).segment(text)) if (part.isWordLike) words += 1;
    return words;
  }
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * How much of `candidate` is copied from `source`: the share of the candidate's 12-character (CJK) or 6-word (other scripts) runs that
 * also appear in the source. 0 = nothing copied, 1 = all of it.
 */
export function textOverlapRatio(source: string, candidate: string): number {
  const cjk = isCjkHeavy(candidate);
  const units = (text: string) => (cjk ? [...comparable(text)] : text.normalize("NFKC").toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean));
  const size = cjk ? 12 : 6;
  const shingles = (list: string[]) => {
    const out = new Set<string>();
    for (let index = 0; index + size <= list.length; index += 1) out.add(list.slice(index, index + size).join(cjk ? "" : " "));
    return out;
  };
  const target = shingles(units(candidate));
  if (target.size === 0) return 0;
  const from = shingles(units(source));
  let shared = 0;
  for (const shingle of target) if (from.has(shingle)) shared += 1;
  return shared / target.size;
}

/**
 * At most `max` characters, cut at the last sentence end, else clause mark, else space in the second half - never inside a word - with
 * "…" when something was cut. CJK text (no spaces) falls back to a character cut.
 */
export function truncateAtBoundary(text: string, max: number): string {
  const chars = [...text.trim()];
  if (chars.length <= max) return chars.join("");
  const head = chars.slice(0, Math.max(1, max - 1)).join("");
  const half = Math.floor(head.length / 2);
  for (const pattern of [/[。！？!?.](?=[^。！？!?.]*$)/, /[、，,;；:：](?=[^、，,;；:：]*$)/, /\s(?=\S*$)/]) {
    const match = pattern.exec(head);
    if (match && match.index >= half) return `${head.slice(0, match.index + (match[0].trim() ? 1 : 0)).trimEnd()}…`;
  }
  return `${head.trimEnd()}…`;
}

/**
 * The form's topic from analysed source text: the text cut at a boundary so that it and the source line fit in `max` (a `topic` source
 * is at most 400 characters). The source is always named; its link is kept when it fits.
 */
export function composeSourceTopic(input: { text: string; sourceName: string | null; sourceUrl: string }, max = 400): string {
  const named = `Source: ${input.sourceName?.trim() || new URL(input.sourceUrl).hostname}`;
  const sourceLine = [...`${named} - ${input.sourceUrl}`].length <= Math.floor(max / 3) ? `${named} - ${input.sourceUrl}` : named;
  const room = max - [...sourceLine].length - 2;
  const body = truncateAtBoundary(input.text.replace(/\s+/g, " "), Math.max(20, room));
  return `${body}\n\n${sourceLine}`;
}
