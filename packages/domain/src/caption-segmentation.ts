/**
 * VE2E-03: derive timed caption/subtitle segments strictly from a real provider
 * character-level alignment (e.g. ElevenLabs TTS-with-timestamps). This module never
 * invents or guesses timing — every segment start/end is the actual start/end time of
 * a real character in the alignment. It only decides how to *group* characters into
 * words and words into caption-sized chunks (a packing/chunking policy), which is
 * display formatting, not timing fabrication.
 */

export type CharacterAlignment = {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
};

export type CaptionSegment = { text: string; startMs: number; endMs: number };

export type CaptionSegmentationOptions = {
  /** Soft cap on characters per caption line (common subtitle-guideline default). */
  maxCharsPerSegment?: number;
  /** Soft cap on segment duration in ms before forcing a break. */
  maxDurationMs?: number;
};

const DEFAULT_MAX_CHARS = 42;
const DEFAULT_MAX_DURATION_MS = 4200;

const isAlignmentUsable = (alignment: CharacterAlignment): boolean =>
  alignment.characters.length > 0 &&
  alignment.characters.length === alignment.characterStartTimesSeconds.length &&
  alignment.characters.length === alignment.characterEndTimesSeconds.length;

type WordSpan = { text: string; startSec: number; endSec: number };

/** Groups consecutive non-whitespace characters into words, each word's start/end pinned to its first/last character's real timestamp. */
const buildWordSpans = (alignment: CharacterAlignment): WordSpan[] => {
  const spans: WordSpan[] = [];
  let currentChars: string[] = [];
  let currentStart: number | null = null;
  let currentEnd = 0;
  const flush = () => {
    if (currentChars.length === 0 || currentStart === null) return;
    spans.push({ text: currentChars.join(""), startSec: currentStart, endSec: currentEnd });
    currentChars = [];
    currentStart = null;
  };
  for (let i = 0; i < alignment.characters.length; i += 1) {
    const char = alignment.characters[i]!;
    if (/^\s$/.test(char)) {
      flush();
      continue;
    }
    if (currentStart === null) currentStart = alignment.characterStartTimesSeconds[i]!;
    currentEnd = alignment.characterEndTimesSeconds[i]!;
    currentChars.push(char);
  }
  flush();
  return spans;
};

/**
 * Packs word spans into caption segments bounded by `maxCharsPerSegment`/`maxDurationMs`.
 * A segment's start/end is always the first/last word's real alignment timestamp inside
 * it — never interpolated or invented. A single word that alone exceeds the caps still
 * becomes its own segment (words are never split mid-character).
 */
export function buildCaptionSegmentsFromAlignment(
  alignment: CharacterAlignment,
  options: CaptionSegmentationOptions = {},
): CaptionSegment[] {
  if (!isAlignmentUsable(alignment)) return [];
  const maxChars = options.maxCharsPerSegment ?? DEFAULT_MAX_CHARS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const words = buildWordSpans(alignment);
  if (words.length === 0) return [];

  const segments: CaptionSegment[] = [];
  let bucket: WordSpan[] = [];

  const flushBucket = () => {
    if (bucket.length === 0) return;
    const text = bucket.map((w) => w.text).join(" ");
    const startMs = Math.round(bucket[0]!.startSec * 1000);
    const endMs = Math.round(bucket[bucket.length - 1]!.endSec * 1000);
    segments.push({ text, startMs, endMs: Math.max(endMs, startMs) });
    bucket = [];
  };

  for (const word of words) {
    if (bucket.length === 0) {
      bucket.push(word);
      continue;
    }
    const candidateText = `${bucket.map((w) => w.text).join(" ")} ${word.text}`;
    const candidateDurationMs = Math.round((word.endSec - bucket[0]!.startSec) * 1000);
    if (candidateText.length > maxChars || candidateDurationMs > maxDurationMs) {
      flushBucket();
      bucket.push(word);
    } else {
      bucket.push(word);
    }
  }
  flushBucket();
  return segments;
}
