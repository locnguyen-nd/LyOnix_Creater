/**
 * VE2E-54: narration duration budget. Pure functions - no DB/provider access.
 * Total of all scene voice durations must land within the intake target +- tolerance
 * (default 10 s); scene count is free (the template scales).
 */

export const DEFAULT_DURATION_TOLERANCE_SEC = 10;

/** Conservative fallback speaking rates (characters per second, incl. punctuation) when no history exists. */
export const DEFAULT_CHARS_PER_SECOND: Readonly<Record<string, number>> = {
  ja: 7,
  vi: 14,
  en: 15,
  ko: 8,
};
const FALLBACK_CPS = 12;
const MIN_HISTORY_SAMPLES = 3;
const MIN_SAMPLE_MS = 500;

export type DurationSample = { chars: number; durationMs: number };

export const defaultCharsPerSecond = (language: string): number => DEFAULT_CHARS_PER_SECOND[language] ?? FALLBACK_CPS;

/**
 * Chars/sec from historical scene audio: total chars / total seconds (duration-weighted, so long scenes
 * dominate short noisy ones). Falls back to the language default with fewer than 3 usable samples.
 */
export function calibrateCharsPerSecond(samples: readonly DurationSample[], language: string): { charsPerSecond: number; sampleCount: number; source: "history" | "default" } {
  const usable = samples.filter((s) => Number.isFinite(s.chars) && Number.isFinite(s.durationMs) && s.chars > 0 && s.durationMs >= MIN_SAMPLE_MS);
  if (usable.length < MIN_HISTORY_SAMPLES) return { charsPerSecond: defaultCharsPerSecond(language), sampleCount: usable.length, source: "default" };
  const chars = usable.reduce((sum, s) => sum + s.chars, 0);
  const seconds = usable.reduce((sum, s) => sum + s.durationMs, 0) / 1000;
  const cps = chars / seconds;
  // Guard against garbage history (e.g. silent/failed audio).
  if (!Number.isFinite(cps) || cps < 2 || cps > 40) return { charsPerSecond: defaultCharsPerSecond(language), sampleCount: usable.length, source: "default" };
  return { charsPerSecond: Math.round(cps * 100) / 100, sampleCount: usable.length, source: "history" };
}

export type NarrationBudget = {
  targetSec: number;
  charsPerSecond: number;
  targetChars: number;
  minChars: number;
  maxChars: number;
  sceneCount: { min: number; max: number };
};

const MIN_SCENE_SEC = 2;
const MAX_SCENE_SEC = 8;

export function buildNarrationBudget(input: { targetSec: number; charsPerSecond: number; toleranceSec?: number }): NarrationBudget {
  const tolerance = input.toleranceSec ?? DEFAULT_DURATION_TOLERANCE_SEC;
  const targetSec = Math.max(1, input.targetSec);
  const cps = input.charsPerSecond > 0 ? input.charsPerSecond : FALLBACK_CPS;
  return {
    targetSec,
    charsPerSecond: cps,
    targetChars: Math.round(targetSec * cps),
    minChars: Math.round(Math.max(0, targetSec - tolerance) * cps),
    maxChars: Math.round((targetSec + tolerance) * cps),
    sceneCount: { min: Math.max(1, Math.floor(targetSec / MAX_SCENE_SEC)), max: Math.max(1, Math.ceil(targetSec / MIN_SCENE_SEC)) },
  };
}

export type DurationBandCheck = {
  targetSec: number;
  totalSec: number;
  toleranceSec: number;
  minSec: number;
  maxSec: number;
  inBand: boolean;
  /** Signed seconds outside the band (0 when inside). */
  deviationSec: number;
};

export function checkDurationBand(input: { targetSec: number; totalMs: number; toleranceSec?: number }): DurationBandCheck {
  const toleranceSec = input.toleranceSec ?? DEFAULT_DURATION_TOLERANCE_SEC;
  const totalSec = input.totalMs / 1000;
  const minSec = input.targetSec - toleranceSec;
  const maxSec = input.targetSec + toleranceSec;
  const inBand = totalSec >= minSec && totalSec <= maxSec;
  const deviationSec = inBand ? 0 : totalSec < minSec ? totalSec - minSec : totalSec - maxSec;
  return { targetSec: input.targetSec, totalSec: Math.round(totalSec * 100) / 100, toleranceSec, minSec, maxSec, inBand, deviationSec: Math.round(deviationSec * 100) / 100 };
}

/** Prompt lines for the script builder; kept separate so the prompt builder only splices one string. */
export function buildDurationBudgetPromptLines(budget: NarrationBudget): string {
  return `Duration budget (strict): total spoken narration must last ${budget.targetSec - 10}-${budget.targetSec + 10} seconds. At about ${budget.charsPerSecond} characters/second for this language, write about ${budget.targetChars} characters of narration in total (between ${budget.minChars} and ${budget.maxChars}). Use ${budget.sceneCount.min}-${budget.sceneCount.max} scenes; scene count is flexible, total length is not.`;
}

/**
 * One-shot length correction (VE2E-54): total narration characters of a draft against the budget. Returns `null` when the draft is
 * close enough (within 15% outside the band), else the direction text to append for ONE regeneration. Pure.
 */
export function narrationLengthCorrection(budget: NarrationBudget, narrations: readonly string[]): { totalChars: number; direction: string } | null {
  const totalChars = narrations.reduce((total, text) => total + text.trim().length, 0);
  const tooShort = totalChars < budget.minChars * 0.85;
  const tooLong = totalChars > budget.maxChars * 1.15;
  if (!tooShort && !tooLong) return null;
  const perScene = Math.round(budget.targetChars / Math.max(1, narrations.length));
  return {
    totalChars,
    direction: `LENGTH CORRECTION: the previous draft had only ${totalChars} characters of narration (about ${Math.round(totalChars / budget.charsPerSecond)} seconds); it must be ${tooShort ? "longer" : "shorter"}: between ${budget.minChars} and ${budget.maxChars} characters in total (target ${budget.targetChars}). Keep ${narrations.length} scenes and write about ${perScene} characters of narration per scene, with concrete detail from the source, no filler.`,
  };
}
