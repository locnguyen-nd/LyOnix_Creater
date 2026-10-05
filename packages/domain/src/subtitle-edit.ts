/**
 * V03-03: pure editing rules for one voice's timed captions (`SubtitleVersion.segments`). Shared by the API (the authoritative
 * check of a saved edit) and the Studio subtitle editor (same rules client-side, plus the split / merge / nudge operations).
 * No I/O, browser-safe (subpath `@lyonix/domain/subtitle-edit`).
 *
 * Timing is never invented: an edit keeps each cue's own start/end (the voice's real timing from the TTS alignment), a nudge only
 * moves an edge within its neighbours, and a split divides ONE cue's span in proportion to its characters - an estimate, as is the
 * per-character timing of any cue whose text no longer matches what was voiced (owner decision, see `charTimingsForSegments`).
 * Numbers marked PLACEHOLDER are untuned.
 */

export type SubtitleCue = { text: string; startMs: number; endMs: number };

export const SUBTITLE_EDIT_LIMITS = {
  /** PLACEHOLDER: shortest cue. Low on purpose so untouched automatic cues (one short word) always stay valid. */
  minCueMs: 100,
  maxCueTextLength: 200,
  maxCues: 200,
  /** Automatic cues may end a few ms past the measured audio length (alignment vs file duration); accepted up to this. */
  durationToleranceMs: 100,
  /** PLACEHOLDER: one click of the editor's nudge buttons. */
  nudgeStepMs: 100,
} as const;

export type SubtitleCueErrorCode = "NO_CUES" | "TOO_MANY_CUES" | "NOT_INTEGER" | "TEXT_EMPTY" | "TEXT_TOO_LONG" | "OUT_OF_RANGE" | "TOO_SHORT" | "OVERLAP";
/** `index` is the 0-based cue, or -1 for the list as a whole. */
export type SubtitleCueError = { index: number; code: SubtitleCueErrorCode };

export type SubtitleCueValidation = { ok: true; cues: SubtitleCue[] } | { ok: false; errors: SubtitleCueError[] };

/** Caption text is one run of words: line breaks are the renderer's job (BudouX/kinsoku), so whitespace runs collapse to one space. */
export const normalizeCueText = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Same words, whitespace ignored. Used to tell Auto's "caption = narration" override (keeps the voice-timed captions) from a
 * human-typed one (replaces them with one static block) - the API render paths and the Studio warning share this one rule.
 */
export const sameCaptionText = (a: string, b: string): boolean => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Validates and normalizes an edited cue list against the voice's duration. Returns every problem, not only the first. */
export function validateSubtitleCues(input: unknown, audioDurationMs: number): SubtitleCueValidation {
  const limits = SUBTITLE_EDIT_LIMITS;
  if (!Array.isArray(input) || input.length === 0) return { ok: false, errors: [{ index: -1, code: "NO_CUES" }] };
  if (input.length > limits.maxCues) return { ok: false, errors: [{ index: -1, code: "TOO_MANY_CUES" }] };
  const errors: SubtitleCueError[] = [];
  const cues: SubtitleCue[] = [];
  let previousEnd = 0;
  input.forEach((raw, index) => {
    const startMs = isRecord(raw) ? raw.startMs : undefined;
    const endMs = isRecord(raw) ? raw.endMs : undefined;
    const text = isRecord(raw) && typeof raw.text === "string" ? normalizeCueText(raw.text) : "";
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) {
      errors.push({ index, code: "NOT_INTEGER" });
      return;
    }
    const start = startMs as number;
    const end = endMs as number;
    if (!text) errors.push({ index, code: "TEXT_EMPTY" });
    else if (Array.from(text).length > limits.maxCueTextLength) errors.push({ index, code: "TEXT_TOO_LONG" });
    if (start < 0 || end <= start || end > audioDurationMs + limits.durationToleranceMs) errors.push({ index, code: "OUT_OF_RANGE" });
    else if (end - start < limits.minCueMs) errors.push({ index, code: "TOO_SHORT" });
    if (index > 0 && start < previousEnd) errors.push({ index, code: "OVERLAP" });
    previousEnd = Math.max(previousEnd, end);
    cues.push({ text, startMs: start, endMs: end });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, cues };
}

const replaceAt = (cues: readonly SubtitleCue[], index: number, replacement: SubtitleCue[]): SubtitleCue[] => [...cues.slice(0, index), ...replacement, ...cues.slice(index + 1)];

/**
 * Splits cue `index` before the code point `at` of its text. The time span is divided in proportion to the non-space characters on
 * each side (an estimate). `null` when the split point leaves an empty side or a half shorter than `minCueMs`.
 */
export function splitCue(cues: readonly SubtitleCue[], index: number, at: number): SubtitleCue[] | null {
  const cue = cues[index];
  if (!cue) return null;
  const chars = Array.from(cue.text);
  const left = normalizeCueText(chars.slice(0, at).join(""));
  const right = normalizeCueText(chars.slice(at).join(""));
  if (!left || !right) return null;
  const weight = (text: string) => Array.from(text.replace(/\s/g, "")).length;
  const splitMs = cue.startMs + Math.round(((cue.endMs - cue.startMs) * weight(left)) / (weight(left) + weight(right)));
  if (splitMs - cue.startMs < SUBTITLE_EDIT_LIMITS.minCueMs || cue.endMs - splitMs < SUBTITLE_EDIT_LIMITS.minCueMs) return null;
  return replaceAt(cues, index, [{ text: left, startMs: cue.startMs, endMs: splitMs }, { text: right, startMs: splitMs, endMs: cue.endMs }]);
}

/** Word scripts need a space when two cues are joined; Japanese/Chinese/Korean-style text and punctuation boundaries do not. */
const needsSpace = (left: string, right: string) => /[\p{L}\p{N}]$/u.test(left) && /^[\p{L}\p{N}]/u.test(right) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left);

/** Merges cue `index` with the next one (text joined, span from the first start to the second end). `null` at the last cue or when too long. */
export function mergeWithNext(cues: readonly SubtitleCue[], index: number): SubtitleCue[] | null {
  const cue = cues[index];
  const next = cues[index + 1];
  if (!cue || !next) return null;
  const text = normalizeCueText(`${cue.text}${needsSpace(cue.text, next.text) ? " " : ""}${next.text}`);
  if (Array.from(text).length > SUBTITLE_EDIT_LIMITS.maxCueTextLength) return null;
  return [...cues.slice(0, index), { text, startMs: cue.startMs, endMs: next.endMs }, ...cues.slice(index + 2)];
}

/**
 * Moves one edge of cue `index` by `deltaMs`, clamped so the cue keeps `minCueMs`, never overlaps its neighbours and stays inside
 * `[0, audioDurationMs]`. Returns the same array when nothing can move.
 */
export function nudgeCue(cues: readonly SubtitleCue[], index: number, edge: "start" | "end", deltaMs: number, audioDurationMs: number): SubtitleCue[] {
  const cue = cues[index];
  if (!cue) return [...cues];
  const min = SUBTITLE_EDIT_LIMITS.minCueMs;
  if (edge === "start") {
    const lower = index > 0 ? cues[index - 1]!.endMs : 0;
    const startMs = Math.min(Math.max(cue.startMs + deltaMs, lower), cue.endMs - min);
    return startMs === cue.startMs || startMs < lower ? [...cues] : replaceAt(cues, index, [{ ...cue, startMs }]);
  }
  const upper = index < cues.length - 1 ? cues[index + 1]!.startMs : Math.max(audioDurationMs, cue.endMs);
  const endMs = Math.max(Math.min(cue.endMs + deltaMs, upper), cue.startMs + min);
  return endMs === cue.endMs || endMs > upper ? [...cues] : replaceAt(cues, index, [{ ...cue, endMs }]);
}
