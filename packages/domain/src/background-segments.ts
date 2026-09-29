/**
 * VE2E-40 (DEC-2026-09-29-JP-ONESHOT-MEDIA #2): how many background ("one-shot") segments a
 * video is split into, chosen at intake and persisted per run so a retry/resume reuses it.
 *
 * - `{ mode: "auto" }` (default): by length - video <= 30s -> 2..3 segments, > 30s -> 3..5.
 *   The length is the intake target duration when the caller has one, otherwise the total real
 *   voice duration once it is known (media step, VE2E-31) - the caller picks which and passes it.
 * - `{ mode: "fixed", count }`: exactly `count`, validated against configurable bounds
 *   (placeholder 1..6, owner/Test tune it; see `BACKGROUND_SEGMENT_COUNT_DEFAULT_BOUNDS`).
 *
 * Pure, no I/O, browser-safe (subpath `@lyonix/domain/background-segments`).
 */

export type BackgroundSegmentsSettingValue = { mode: "auto" } | { mode: "fixed"; count: number };

export type BackgroundSegmentCountBounds = { min: number; max: number };

export type BackgroundSegmentRange = { min: number; max: number };

/** Placeholder bounds for a user-fixed count (DEC #2 lets the user override; limits are not tuned yet). */
export const BACKGROUND_SEGMENT_COUNT_DEFAULT_BOUNDS: BackgroundSegmentCountBounds = { min: 1, max: 6 };
/** A video at or under this length counts as "short" for the auto rule. */
export const BACKGROUND_SEGMENT_SHORT_VIDEO_MAX_SEC = 30;
export const BACKGROUND_SEGMENT_AUTO_SHORT: BackgroundSegmentRange = { min: 2, max: 3 };
export const BACKGROUND_SEGMENT_AUTO_LONG: BackgroundSegmentRange = { min: 3, max: 5 };

export const DEFAULT_BACKGROUND_SEGMENTS_SETTING: BackgroundSegmentsSettingValue = { mode: "auto" };

export type BackgroundSegmentsParseResult = { ok: true; value: BackgroundSegmentsSettingValue } | { ok: false; message: string };

/** Sanity-check configured bounds; falls back to the placeholder when misconfigured instead of accepting nonsense. */
export function normalizeBackgroundSegmentBounds(bounds: Partial<BackgroundSegmentCountBounds> | null | undefined): BackgroundSegmentCountBounds {
  const min = bounds?.min;
  const max = bounds?.max;
  if (typeof min !== "number" || typeof max !== "number" || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 60) {
    return { ...BACKGROUND_SEGMENT_COUNT_DEFAULT_BOUNDS };
  }
  return { min, max };
}

/**
 * Strict validation of a client-supplied setting (server-side, at intake). `undefined`/`null`
 * means "not provided" and yields the default `{ mode: "auto" }`.
 */
export function parseBackgroundSegmentsSetting(value: unknown, bounds: BackgroundSegmentCountBounds = BACKGROUND_SEGMENT_COUNT_DEFAULT_BOUNDS): BackgroundSegmentsParseResult {
  if (value === undefined || value === null) return { ok: true, value: { ...DEFAULT_BACKGROUND_SEGMENTS_SETTING } };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "backgroundSegments phải là object {mode}" };
  const record = value as Record<string, unknown>;
  if (record.mode === "auto") {
    if (Object.keys(record).some((key) => key !== "mode")) return { ok: false, message: "backgroundSegments mode=auto không nhận thêm trường" };
    return { ok: true, value: { mode: "auto" } };
  }
  if (record.mode === "fixed") {
    if (Object.keys(record).some((key) => key !== "mode" && key !== "count")) return { ok: false, message: "backgroundSegments mode=fixed chỉ nhận count" };
    const count = record.count;
    if (typeof count !== "number" || !Number.isInteger(count) || count < bounds.min || count > bounds.max) {
      return { ok: false, message: `Số đoạn nền phải là số nguyên từ ${bounds.min} đến ${bounds.max}` };
    }
    return { ok: true, value: { mode: "fixed", count } };
  }
  return { ok: false, message: "backgroundSegments.mode phải là auto hoặc fixed" };
}

/** Tolerant reader for a persisted value (e.g. `WorkflowRun.backgroundSegments`); anything unreadable, including legacy `null`, is the default auto setting. */
export function readBackgroundSegmentsSetting(value: unknown): BackgroundSegmentsSettingValue {
  const parsed = parseBackgroundSegmentsSetting(value, { min: 1, max: 60 });
  return parsed.ok ? parsed.value : { ...DEFAULT_BACKGROUND_SEGMENTS_SETTING };
}

/**
 * The segment-count range a planner/prompt should target. `durationSec` is the intake target
 * duration or the real total voice duration (caller decides); `null` = not known yet, in which
 * case an auto setting cannot be resolved and `null` is returned (a fixed count always resolves).
 */
export function resolveBackgroundSegmentRange(setting: BackgroundSegmentsSettingValue, durationSec: number | null | undefined): BackgroundSegmentRange | null {
  if (setting.mode === "fixed") return { min: setting.count, max: setting.count };
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  return durationSec <= BACKGROUND_SEGMENT_SHORT_VIDEO_MAX_SEC ? { ...BACKGROUND_SEGMENT_AUTO_SHORT } : { ...BACKGROUND_SEGMENT_AUTO_LONG };
}
