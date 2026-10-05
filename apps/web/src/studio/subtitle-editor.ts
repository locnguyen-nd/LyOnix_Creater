/** V03-03: pure helpers of the Studio subtitle editor (formatting + error keys). The editing rules themselves live in `@lyonix/domain/subtitle-edit`. */
import type { SubtitleCue, SubtitleCueError } from "@lyonix/domain/subtitle-edit";

/** `1234` -> `"1.23"` (seconds, two decimals) - enough for a 100 ms nudge step. */
export const formatCueTime = (ms: number): string => (Math.max(0, ms) / 1000).toFixed(2);

const ERROR_KEYS: Record<SubtitleCueError["code"], string> = {
  NO_CUES: "studioPro.subtitleErrNoCues",
  TOO_MANY_CUES: "studioPro.subtitleErrTooMany",
  NOT_INTEGER: "studioPro.subtitleErrNotInteger",
  TEXT_EMPTY: "studioPro.subtitleErrTextEmpty",
  TEXT_TOO_LONG: "studioPro.subtitleErrTextTooLong",
  OUT_OF_RANGE: "studioPro.subtitleErrOutOfRange",
  TOO_SHORT: "studioPro.subtitleErrTooShort",
  OVERLAP: "studioPro.subtitleErrOverlap",
};

/** i18n key of a validation error code. */
export const cueErrorKey = (code: SubtitleCueError["code"]): string => ERROR_KEYS[code];

/** First error per cue index (what the row shows); index -1 is the list as a whole. */
export function errorsByCue(errors: readonly SubtitleCueError[]): Map<number, SubtitleCueError["code"]> {
  const map = new Map<number, SubtitleCueError["code"]>();
  for (const error of errors) if (!map.has(error.index)) map.set(error.index, error.code);
  return map;
}

/** Did the draft change anything (text, timing, number of lines) versus the saved version? Whitespace-only text edits count as no change. */
export function cuesChanged(draft: readonly SubtitleCue[], saved: readonly SubtitleCue[]): boolean {
  if (draft.length !== saved.length) return true;
  return draft.some((cue, index) => {
    const base = saved[index]!;
    return cue.startMs !== base.startMs || cue.endMs !== base.endMs || cue.text.replace(/\s+/g, " ").trim() !== base.text.replace(/\s+/g, " ").trim();
  });
}
