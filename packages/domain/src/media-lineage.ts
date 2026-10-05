/**
 * VE2E-42: derivative lineage for `MediaAssetVersion` (`parentMediaAssetVersionId` + `transform`
 * JSON), CR-JP-ONESHOT-MEDIA-2026-09-29 §8. The derivative itself is produced by media-worker
 * (VE2E-36/37); this module only defines/validates the stored `transform` shape so every writer
 * and reader agrees on it. Structurally identical to `MediaAssetTransform` in `@lyonix/contracts`.
 */

export type MediaTransformRange = { startMs: number; durationMs: number };

/**
 * VE2E-67 (CR-SUBJECT-REFRAME-2026-10-02 §3 step 4): lineage of the crop plan applied to produce this derivative. Only the digest and
 * summary live here (the full plan is kept in `provenance.derivative.cropPlan`), so a derivative is only reused for the SAME plan.
 */
export type MediaTransformCrop = {
  planSha256: string;
  planVersion: string;
  mode: "static" | "keyframes";
  zoomPermille: number;
  overlayUnavoidable: boolean;
  residualOverlayPct: number;
  subjectCoveragePct: number;
  cropProfileVersion: string;
};

export type MediaAssetTransformValue = {
  range: MediaTransformRange | null;
  stripAudio: boolean;
  tool: { name: string; version: string } | null;
  profileVersion: string | null;
  /** VE2E-67: present only on derivatives cut with a crop plan (absent key, not null, otherwise). */
  crop?: MediaTransformCrop;
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const isPct = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

const parseCrop = (value: unknown): MediaTransformCrop | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.planSha256 !== "string" || !SHA256_RE.test(raw.planSha256)) return null;
  if (!shortString(raw.planVersion) || !shortString(raw.cropProfileVersion)) return null;
  if (raw.mode !== "static" && raw.mode !== "keyframes") return null;
  if (!isNonNegativeInt(raw.zoomPermille) || typeof raw.overlayUnavoidable !== "boolean" || !isPct(raw.residualOverlayPct) || !isPct(raw.subjectCoveragePct)) return null;
  return {
    planSha256: raw.planSha256,
    planVersion: raw.planVersion,
    mode: raw.mode,
    zoomPermille: raw.zoomPermille,
    overlayUnavoidable: raw.overlayUnavoidable,
    residualOverlayPct: raw.residualOverlayPct,
    subjectCoveragePct: raw.subjectCoveragePct,
    cropProfileVersion: raw.cropProfileVersion,
  };
};

const MAX_LABEL_LENGTH = 200;

const isNonNegativeInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const shortString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_LABEL_LENGTH;

/**
 * Tolerant reader for a stored `transform` JSON value: returns `null` for anything that is not a
 * well-formed transform (including `null`/`{}` on original, non-derivative assets) instead of
 * throwing, so a malformed legacy row can never break a media listing.
 */
export function parseMediaAssetTransform(value: unknown): MediaAssetTransformValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.stripAudio !== "boolean") return null;
  let range: MediaTransformRange | null = null;
  if (record.range !== undefined && record.range !== null) {
    const raw = record.range as Record<string, unknown>;
    if (typeof raw !== "object" || !isNonNegativeInt(raw.startMs) || !isNonNegativeInt(raw.durationMs) || raw.durationMs === 0) return null;
    range = { startMs: raw.startMs, durationMs: raw.durationMs };
  }
  let tool: MediaAssetTransformValue["tool"] = null;
  if (record.tool !== undefined && record.tool !== null) {
    const raw = record.tool as Record<string, unknown>;
    if (typeof raw !== "object" || !shortString(raw.name) || !shortString(raw.version)) return null;
    tool = { name: raw.name, version: raw.version };
  }
  let profileVersion: string | null = null;
  if (record.profileVersion !== undefined && record.profileVersion !== null) {
    if (!shortString(record.profileVersion)) return null;
    profileVersion = record.profileVersion;
  }
  let crop: MediaTransformCrop | undefined;
  if (record.crop !== undefined && record.crop !== null) {
    const parsed = parseCrop(record.crop);
    if (!parsed) return null;
    crop = parsed;
  }
  return { range, stripAudio: record.stripAudio, tool, profileVersion, ...(crop ? { crop } : {}) };
}

/** Strict check for a writer (e.g. the VE2E-37 derivative registration): the value must round-trip through `parseMediaAssetTransform` unchanged. */
export function isValidMediaAssetTransform(value: unknown): value is MediaAssetTransformValue {
  const parsed = parseMediaAssetTransform(value);
  if (!parsed) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => key === "range" || key === "stripAudio" || key === "tool" || key === "profileVersion" || key === "crop");
}
