/**
 * VE2E-67 (CR-SUBJECT-REFRAME-2026-10-02 §3 step 3, §6 Q5): when the render/sourcing path asks the media worker for a crop plan
 * (`reframe.analyze`) and what happens when that is not possible. Pure env parsing, no I/O.
 *
 * - `REFRAME_ENABLED` (default on): `0|false|off|no` switches the whole feature off (legacy centre crop everywhere).
 * - `REFRAME_ENABLED_ORIGINS` (default `apify`): comma list of `MediaAssetVersion.origin` values (`apify,pexels,upload,import_url,generated`),
 *   `all`/`*` for every origin, `none` for none. Default is ON for the social (TikTok-watermark) origin only.
 * - `REFRAME_LEGACY_FALLBACK` (default on): analysis failed (model missing, worker down, timeout) -> keep the OLD blind centre crop, loudly
 *   (log warning + `fallback` flag in the result). Off -> the failure is returned to the caller (render fails with a clear code).
 * - `REFRAME_AUTO_SWAP_ON_OVERLAY` (default on): Auto treats an `overlay_unavoidable` plan as a failed candidate (source swap); off -> flag only.
 * - `REFRAME_ANALYZE_TIMEOUT_MS` (default 180000): wait per analysis.
 */
export type ReframePolicy = {
  enabled: boolean;
  /** Lower-case origins; `"*"` = every origin. */
  enabledOrigins: ReadonlySet<string>;
  legacyFallback: boolean;
  autoSwapOnOverlay: boolean;
  analyzeTimeoutMs: number;
};

/** Social footage (Apify-imported and VE2E-147/148 yt-dlp / gallery-dl) carries watermarks / burned-in text: reframe it by default. */
export const DEFAULT_REFRAME_ENABLED_ORIGINS = "apify,social";
const ORIGIN_RE = /^[a-z0-9_-]{1,32}$/;

const flag = (raw: string | undefined, fallback: boolean): boolean => {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return fallback;
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return fallback;
};

export const reframePolicyFromEnv = (env: NodeJS.ProcessEnv = process.env): ReframePolicy => {
  const rawOrigins = (env.REFRAME_ENABLED_ORIGINS ?? "").trim().toLowerCase();
  const list = rawOrigins === "" ? DEFAULT_REFRAME_ENABLED_ORIGINS : rawOrigins;
  const enabledOrigins = new Set<string>();
  if (list === "all" || list === "*") enabledOrigins.add("*");
  else if (list !== "none") for (const part of list.split(",").map((item) => item.trim())) if (ORIGIN_RE.test(part)) enabledOrigins.add(part);
  const timeout = Number(env.REFRAME_ANALYZE_TIMEOUT_MS);
  return {
    enabled: flag(env.REFRAME_ENABLED, true),
    enabledOrigins,
    legacyFallback: flag(env.REFRAME_LEGACY_FALLBACK, true),
    autoSwapOnOverlay: flag(env.REFRAME_AUTO_SWAP_ON_OVERLAY, true),
    analyzeTimeoutMs: Number.isInteger(timeout) && timeout >= 1_000 && timeout <= 30 * 60_000 ? timeout : 180_000,
  };
};

export const reframeEnabledForOrigin = (policy: ReframePolicy, origin: string): boolean =>
  policy.enabled && (policy.enabledOrigins.has("*") || policy.enabledOrigins.has(origin.trim().toLowerCase()));
