import { createHash } from "node:crypto";
import { hasUnsafePathShape, isInt, isRecord, JOB_KEY_RE, MEDIA_JOB_ERROR_CODES, MEDIA_JOB_SCHEMA_VERSION, type MediaJobErrorCode, type Validation } from "./contract.js";

/**
 * VE2E-144 (CR-MEDIA-OSS-FETCH-2026-10-08): the media worker downloads / searches social media with the open-source CLIs yt-dlp
 * (video) and gallery-dl (images). Same RabbitMQ RPC shape as `clip.prepare` (correlationId + replyTo), but on its own queue
 * (`lyonix.media.fetch`): the work is network-bound and must never block FFmpeg cuts.
 *
 * - `media.fetch` downloads ONE known post URL straight into `MEDIA_ROOT/_quarantine/<uuid>` (streamed by the CLI, capped by
 *   `maxBytes`); the API then sniffs the bytes and registers the asset exactly like any other import. The quarantine file is
 *   consumed by the API, so a fetch result is never reused (the jobKey only de-duplicates concurrent deliveries).
 * - `media.search` returns metadata only (no download).
 *
 * Cookies never travel in a message: the API writes a short-lived 0600 file under `_private/cookies/` and passes its relative path.
 * The proxy URL never travels either: the job only says whether the worker's configured proxy (`MEDIA_FETCH_PROXY`) is used.
 */

export const MEDIA_FETCH_JOB_TYPE = "media.fetch" as const;
export const MEDIA_FETCH_RESULT_TYPE = "media.fetch.result" as const;
export const MEDIA_SEARCH_JOB_TYPE = "media.search" as const;
export const MEDIA_SEARCH_RESULT_TYPE = "media.search.result" as const;
/** Bumped whenever the CLI arguments / recovery steps change in a way that changes what is downloaded. */
export const MEDIA_FETCH_PROFILE_VERSION = "media-fetch.v1" as const;
export const DEFAULT_MEDIA_FETCH_QUEUE = "lyonix.media.fetch";

export const socialFetchPlatforms = ["tiktok", "youtube", "pinterest", "x", "instagram"] as const;
export type SocialFetchPlatform = (typeof socialFetchPlatforms)[number];
export const isSocialFetchPlatform = (value: unknown): value is SocialFetchPlatform => typeof value === "string" && (socialFetchPlatforms as readonly string[]).includes(value);

export const socialFetchTools = ["yt-dlp", "gallery-dl"] as const;
export type SocialFetchTool = (typeof socialFetchTools)[number];

/** Platforms each tool may search (yt-dlp has no working TikTok keyword search: `tiktok:tag` is "Currently broken" upstream). */
export const SOCIAL_SEARCH_SUPPORT: Record<SocialFetchTool, readonly SocialFetchPlatform[]> = {
  "yt-dlp": ["youtube"],
  "gallery-dl": ["pinterest", "x"],
};

/** Whole-label host suffixes a post URL may point at, per platform (defence in depth: the worker never fetches an arbitrary host). */
export const SOCIAL_POST_HOST_SUFFIXES: Record<SocialFetchPlatform, readonly string[]> = {
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be"],
  pinterest: ["pinterest.com", "pinterest.jp", "pin.it", "pinimg.com"],
  x: ["x.com", "twitter.com"],
  instagram: ["instagram.com"],
};

/** Cookie files the API hands to the worker live here (relative to MEDIA_ROOT), are 0600 and deleted as soon as the job answers. */
export const MEDIA_FETCH_COOKIES_DIR = "_private/cookies";

export const DEFAULT_FETCH_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_FETCH_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_FETCH_MAX_BYTES = 500 * 1024 * 1024;
export const DEFAULT_MEDIA_FETCH_TIMEOUT_MS = 60_000;
export const MIN_MEDIA_FETCH_TIMEOUT_MS = 5_000;
export const MAX_MEDIA_FETCH_TIMEOUT_MS = 10 * 60_000;
export const MAX_MEDIA_SEARCH_LIMIT = 30;

/** Normalised failure reasons of a fetch/search (also the `error.code` of a failed result). */
export const MEDIA_FETCH_ERROR_CODES = [
  "FETCH_FORBIDDEN",
  "FETCH_BOT_CHECK",
  "FETCH_COOKIES_INVALID",
  "FETCH_RATE_LIMITED",
  "FETCH_UNAVAILABLE",
  "FETCH_EXTRACTOR_BROKEN",
  "FETCH_TOO_LARGE",
  "FETCH_TIMEOUT",
  "FETCH_NETWORK",
  "FETCH_TOOL_MISSING",
  "FETCH_FAILED",
] as const satisfies readonly MediaJobErrorCode[];
export type MediaFetchErrorCode = (typeof MEDIA_FETCH_ERROR_CODES)[number];

/** Errors where rotating cookies / switching to impersonation / a proxy can help (as opposed to a deleted post or a too-large file). */
export const FETCH_ACCESS_ERRORS: ReadonlySet<string> = new Set<MediaFetchErrorCode>(["FETCH_FORBIDDEN", "FETCH_BOT_CHECK", "FETCH_COOKIES_INVALID", "FETCH_RATE_LIMITED"]);

/** One CLI run inside a job (the worker's own recovery: plain -> fresh re-extraction -> browser impersonation). */
export type MediaFetchAttemptStep = "plain" | "retry" | "impersonate";
export type MediaFetchAttempt = { step: MediaFetchAttemptStep; code: MediaFetchErrorCode | null; elapsedMs: number };

export type MediaFetchImpersonate = "auto" | "always" | "never";

type FetchAccess = {
  /** Relative to MEDIA_ROOT, must sit under `_private/cookies/`; null = no cookies. */
  cookiesRelativePath: string | null;
  /** Use the worker's configured proxy (`MEDIA_FETCH_PROXY`). Ignored when the worker has none. */
  useProxy: boolean;
  /** `auto` = only after a 403 / bot check; `always` = from the first run; `never` = never. */
  impersonate: MediaFetchImpersonate;
  /** Hard budget for the whole job (every recovery step included). */
  timeoutMs: number;
};

export type MediaFetchJob = FetchAccess & {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof MEDIA_FETCH_JOB_TYPE;
  jobKey: string;
  platform: SocialFetchPlatform;
  tool: SocialFetchTool;
  /** Public post URL (https, host in SOCIAL_POST_HOST_SUFFIXES[platform]). */
  url: string;
  mediaType: "video" | "image";
  maxBytes: number;
  /** Optional time window (yt-dlp `--download-sections`); null = the whole post. */
  sectionStartMs: number | null;
  sectionDurationMs: number | null;
};

/** Metadata read from the CLI's JSON output (any field may be missing on a platform). */
export type SocialMediaInfo = {
  externalId: string | null;
  title: string | null;
  description: string | null;
  uploader: string | null;
  channel: string | null;
  webpageUrl: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  viewCount: number | null;
  likeCount: number | null;
  uploadDate: string | null;
  tags: string[];
  language: string | null;
};

export type MediaFetchSuccess = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof MEDIA_FETCH_RESULT_TYPE;
  ok: true;
  jobKey: string;
  /** The API registers the asset from `_quarantine/<quarantineToken>`. */
  quarantineToken: string;
  bytes: number;
  sha256: string;
  /** ffprobe of a video (null for images or when the probe failed: the API then falls back to the CLI metadata). */
  probe: { durationMs: number; width: number; height: number; videoCodec: string } | null;
  info: SocialMediaInfo;
  attempts: MediaFetchAttempt[];
  tool: { name: SocialFetchTool; version: string; profileVersion: typeof MEDIA_FETCH_PROFILE_VERSION };
  elapsedMs: number;
  completedAt: string;
};

export type MediaFetchFailure = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof MEDIA_FETCH_RESULT_TYPE;
  ok: false;
  jobKey: string;
  error: { code: MediaJobErrorCode; message: string; retryable: boolean; attempts: number };
  attempts?: MediaFetchAttempt[];
  completedAt: string;
};

export type MediaFetchResult = MediaFetchSuccess | MediaFetchFailure;

export type MediaSearchJob = FetchAccess & {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof MEDIA_SEARCH_JOB_TYPE;
  jobKey: string;
  platform: SocialFetchPlatform;
  tool: SocialFetchTool;
  query: string;
  limit: number;
  mediaType: "video" | "image";
};

export type SocialSearchItem = SocialMediaInfo & {
  /** Post URL to pass to `media.fetch` later. */
  url: string;
  mediaType: "video" | "image";
};

export type MediaSearchSuccess = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof MEDIA_SEARCH_RESULT_TYPE;
  ok: true;
  jobKey: string;
  items: SocialSearchItem[];
  attempts: MediaFetchAttempt[];
  tool: { name: SocialFetchTool; version: string; profileVersion: typeof MEDIA_FETCH_PROFILE_VERSION };
  elapsedMs: number;
  completedAt: string;
};

export type MediaSearchFailure = Omit<MediaFetchFailure, "type"> & { type: typeof MEDIA_SEARCH_RESULT_TYPE };
export type MediaSearchResult = MediaSearchSuccess | MediaSearchFailure;

// --- helpers ------------------------------------------------------------------------------------

const hostMatches = (host: string, suffixes: readonly string[]): boolean => {
  const h = host.toLowerCase().replace(/\.$/, "");
  return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
};

/** True when `url` is an https URL on one of the platform's hosts, without credentials or an explicit port. */
export const isAllowedSocialPostUrl = (platform: SocialFetchPlatform, url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
  return hostMatches(parsed.hostname, SOCIAL_POST_HOST_SUFFIXES[platform]);
};

const validateAccess = (input: Record<string, unknown>, errors: string[]): void => {
  const cookies = input.cookiesRelativePath ?? null;
  if (cookies !== null) {
    if (typeof cookies !== "string" || hasUnsafePathShape(cookies) || !cookies.replaceAll("\\", "/").startsWith(`${MEDIA_FETCH_COOKIES_DIR}/`)) {
      errors.push(`cookiesRelativePath must be null or a safe path under ${MEDIA_FETCH_COOKIES_DIR}/`);
    }
  }
  if (typeof input.useProxy !== "boolean") errors.push("useProxy must be a boolean");
  if (input.impersonate !== "auto" && input.impersonate !== "always" && input.impersonate !== "never") errors.push("impersonate must be auto|always|never");
  if (!isInt(input.timeoutMs) || input.timeoutMs < MIN_MEDIA_FETCH_TIMEOUT_MS || input.timeoutMs > MAX_MEDIA_FETCH_TIMEOUT_MS) {
    errors.push(`timeoutMs must be an integer in [${MIN_MEDIA_FETCH_TIMEOUT_MS}, ${MAX_MEDIA_FETCH_TIMEOUT_MS}]`);
  }
};

const validateHeader = (input: Record<string, unknown>, type: string, errors: string[]): void => {
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MEDIA_JOB_SCHEMA_VERSION}`);
  if (input.type !== type) errors.push(`type must be ${type}`);
  if (typeof input.jobKey !== "string" || !JOB_KEY_RE.test(input.jobKey)) errors.push("jobKey must match [A-Za-z0-9._:-]{1,160}");
  if (!isSocialFetchPlatform(input.platform)) errors.push(`platform must be one of ${socialFetchPlatforms.join("|")}`);
  if (input.tool !== "yt-dlp" && input.tool !== "gallery-dl") errors.push("tool must be yt-dlp|gallery-dl");
  if (input.mediaType !== "video" && input.mediaType !== "image") errors.push("mediaType must be video|image");
};

const accessOf = (input: Record<string, unknown>): FetchAccess => ({
  cookiesRelativePath: typeof input.cookiesRelativePath === "string" ? input.cookiesRelativePath.replaceAll("\\", "/") : null,
  useProxy: input.useProxy as boolean,
  impersonate: input.impersonate as MediaFetchImpersonate,
  timeoutMs: input.timeoutMs as number,
});

// --- media.fetch --------------------------------------------------------------------------------

export type MediaFetchJobInput = {
  jobKey: string;
  platform: SocialFetchPlatform;
  tool: SocialFetchTool;
  url: string;
  mediaType: "video" | "image";
  maxBytes?: number;
  sectionStartMs?: number | null;
  sectionDurationMs?: number | null;
  cookiesRelativePath?: string | null;
  useProxy?: boolean;
  impersonate?: MediaFetchImpersonate;
  timeoutMs?: number;
};

export const buildMediaFetchJob = (input: MediaFetchJobInput): MediaFetchJob => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: MEDIA_FETCH_JOB_TYPE,
  jobKey: input.jobKey,
  platform: input.platform,
  tool: input.tool,
  url: input.url,
  mediaType: input.mediaType,
  maxBytes: input.maxBytes ?? (input.mediaType === "image" ? DEFAULT_FETCH_IMAGE_MAX_BYTES : DEFAULT_FETCH_VIDEO_MAX_BYTES),
  sectionStartMs: input.sectionStartMs ?? null,
  sectionDurationMs: input.sectionDurationMs ?? null,
  cookiesRelativePath: input.cookiesRelativePath ?? null,
  useProxy: input.useProxy ?? false,
  impersonate: input.impersonate ?? "auto",
  timeoutMs: input.timeoutMs ?? DEFAULT_MEDIA_FETCH_TIMEOUT_MS,
});

export const validateMediaFetchJob = (input: unknown): Validation<MediaFetchJob> => {
  if (!isRecord(input)) return { ok: false, errors: ["job must be an object"] };
  const errors: string[] = [];
  validateHeader(input, MEDIA_FETCH_JOB_TYPE, errors);
  if (typeof input.url !== "string" || input.url.length > 2048 || (isSocialFetchPlatform(input.platform) && !isAllowedSocialPostUrl(input.platform, input.url))) {
    errors.push("url must be an https post URL on the platform's hosts");
  }
  if (!isInt(input.maxBytes) || input.maxBytes < 1024 || input.maxBytes > MAX_FETCH_MAX_BYTES) errors.push(`maxBytes must be an integer in [1024, ${MAX_FETCH_MAX_BYTES}]`);
  const start = input.sectionStartMs ?? null;
  const duration = input.sectionDurationMs ?? null;
  if ((start === null) !== (duration === null)) errors.push("sectionStartMs and sectionDurationMs must both be set or both null");
  if (start !== null && (!isInt(start) || start < 0)) errors.push("sectionStartMs must be an integer >= 0");
  if (duration !== null && (!isInt(duration) || duration < 500)) errors.push("sectionDurationMs must be an integer >= 500");
  if (start !== null && input.tool !== "yt-dlp") errors.push("a section is only supported by yt-dlp");
  validateAccess(input, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: MEDIA_FETCH_JOB_TYPE,
      jobKey: input.jobKey as string,
      platform: input.platform as SocialFetchPlatform,
      tool: input.tool as SocialFetchTool,
      url: input.url as string,
      mediaType: input.mediaType as "video" | "image",
      maxBytes: input.maxBytes as number,
      sectionStartMs: start as number | null,
      sectionDurationMs: duration as number | null,
      ...accessOf(input),
    },
  };
};

/** One key per (platform, post, window, profile). Concurrent deliveries of the same key are de-duplicated by the worker. */
export const buildMediaFetchJobKey = (input: { platform: SocialFetchPlatform; url: string; sectionStartMs?: number | null; sectionDurationMs?: number | null; attempt?: string }): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.platform, input.url, input.sectionStartMs ?? null, input.sectionDurationMs ?? null, input.attempt ?? "", MEDIA_FETCH_PROFILE_VERSION]))
    .digest("hex");
  return `fetch:${digest.slice(0, 40)}`;
};

const isAttemptList = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.every((a) => isRecord(a) && typeof a.step === "string"));

const parseFailure = (input: Record<string, unknown>): boolean => {
  const error = input.error;
  return isRecord(error) && typeof error.code === "string" && (MEDIA_JOB_ERROR_CODES as readonly string[]).includes(error.code) && isAttemptList(input.attempts);
};

export const parseMediaFetchResult = (input: unknown): MediaFetchResult | null => {
  if (!isRecord(input)) return null;
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION || input.type !== MEDIA_FETCH_RESULT_TYPE) return null;
  if (typeof input.jobKey !== "string" || typeof input.ok !== "boolean") return null;
  if (input.ok) {
    if (typeof input.quarantineToken !== "string" || !/^[0-9a-f-]{36}$/i.test(input.quarantineToken)) return null;
    if (!isInt(input.bytes) || typeof input.sha256 !== "string" || !isRecord(input.info) || !isAttemptList(input.attempts)) return null;
    return input as unknown as MediaFetchSuccess;
  }
  return parseFailure(input) ? (input as unknown as MediaFetchFailure) : null;
};

// --- media.search -------------------------------------------------------------------------------

export type MediaSearchJobInput = {
  jobKey: string;
  platform: SocialFetchPlatform;
  tool: SocialFetchTool;
  query: string;
  limit?: number;
  mediaType: "video" | "image";
  cookiesRelativePath?: string | null;
  useProxy?: boolean;
  impersonate?: MediaFetchImpersonate;
  timeoutMs?: number;
};

export const buildMediaSearchJob = (input: MediaSearchJobInput): MediaSearchJob => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: MEDIA_SEARCH_JOB_TYPE,
  jobKey: input.jobKey,
  platform: input.platform,
  tool: input.tool,
  query: input.query,
  limit: input.limit ?? 15,
  mediaType: input.mediaType,
  cookiesRelativePath: input.cookiesRelativePath ?? null,
  useProxy: input.useProxy ?? false,
  impersonate: input.impersonate ?? "auto",
  timeoutMs: input.timeoutMs ?? DEFAULT_MEDIA_FETCH_TIMEOUT_MS,
});

export const validateMediaSearchJob = (input: unknown): Validation<MediaSearchJob> => {
  if (!isRecord(input)) return { ok: false, errors: ["job must be an object"] };
  const errors: string[] = [];
  validateHeader(input, MEDIA_SEARCH_JOB_TYPE, errors);
  if (typeof input.query !== "string" || input.query.trim() === "" || input.query.length > 200 || /[\r\n\0]/.test(input.query)) errors.push("query must be a non-empty single-line string (<= 200 chars)");
  if (!isInt(input.limit) || input.limit < 1 || input.limit > MAX_MEDIA_SEARCH_LIMIT) errors.push(`limit must be an integer in [1, ${MAX_MEDIA_SEARCH_LIMIT}]`);
  if ((input.tool === "yt-dlp" || input.tool === "gallery-dl") && isSocialFetchPlatform(input.platform) && !SOCIAL_SEARCH_SUPPORT[input.tool].includes(input.platform)) {
    errors.push(`${input.tool} cannot search ${input.platform}`);
  }
  validateAccess(input, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: MEDIA_SEARCH_JOB_TYPE,
      jobKey: input.jobKey as string,
      platform: input.platform as SocialFetchPlatform,
      tool: input.tool as SocialFetchTool,
      query: (input.query as string).trim(),
      limit: input.limit as number,
      mediaType: input.mediaType as "video" | "image",
      ...accessOf(input),
    },
  };
};

export const buildMediaSearchJobKey = (input: { platform: SocialFetchPlatform; tool: SocialFetchTool; query: string; limit: number; nonce?: string }): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.platform, input.tool, input.query.normalize("NFKC").toLowerCase(), input.limit, input.nonce ?? "", MEDIA_FETCH_PROFILE_VERSION]))
    .digest("hex");
  return `search:${digest.slice(0, 40)}`;
};

export const parseMediaSearchResult = (input: unknown): MediaSearchResult | null => {
  if (!isRecord(input)) return null;
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION || input.type !== MEDIA_SEARCH_RESULT_TYPE) return null;
  if (typeof input.jobKey !== "string" || typeof input.ok !== "boolean") return null;
  if (input.ok) {
    if (!Array.isArray(input.items) || input.items.some((i) => !isRecord(i) || typeof i.url !== "string") || !isAttemptList(input.attempts)) return null;
    return input as unknown as MediaSearchSuccess;
  }
  return parseFailure(input) ? (input as unknown as MediaSearchFailure) : null;
};
