import {
  isAllowedSocialPostUrl,
  SOCIAL_DIRECT_MEDIA_HOST_SUFFIXES,
  type MediaFetchAttempt,
  type MediaFetchAttemptStep,
  type MediaFetchErrorCode,
  type MediaFetchImpersonate,
  type SocialFetchPlatform,
  type SocialFetchTool,
  type SocialMediaInfo,
  type SocialSearchItem,
} from "@lyonix/media-jobs";

/**
 * VE2E-144: pure helpers of the yt-dlp / gallery-dl integration (no I/O): CLI arguments, stderr -> error code, the in-worker
 * recovery decision and the parsing of the CLIs' JSON output. Arguments are always passed as an argv array (never a shell) and the
 * URL / search term always comes after `--`, so nothing coming from a post or a keyword can be read as an option.
 */

export type CliAccess = {
  cookiesPath: string | null;
  proxyUrl: string | null;
  impersonate: boolean;
};

const SOCKET_TIMEOUT_S = "20";

/**
 * Video format preference: H.264 first (clip.prepare can then stream-copy instead of re-encoding), never above 1920 px, video-only is
 * fine (imported social clips are `strip_audio`). Falls back to whatever single file the platform offers.
 */
export const YTDLP_VIDEO_FORMAT = "bv*[vcodec^=avc1][height<=1920]/bv*[height<=1920]/b[height<=1920]/b";

const ytdlpAccessArgs = (access: CliAccess): string[] => [
  ...(access.cookiesPath ? ["--cookies", access.cookiesPath] : []),
  ...(access.proxyUrl ? ["--proxy", access.proxyUrl] : []),
  ...(access.impersonate ? ["--impersonate", "chrome"] : []),
];

const galleryAccessArgs = (access: CliAccess): string[] => [
  ...(access.cookiesPath ? ["--cookies", access.cookiesPath] : []),
  ...(access.proxyUrl ? ["--proxy", access.proxyUrl] : []),
  // gallery-dl has no curl_cffi impersonation; `browser` makes it send a real browser's header set / TLS cipher order.
  ...(access.impersonate ? ["-o", "browser=firefox"] : []),
];

const seconds = (ms: number): string => (Math.round(ms) / 1000).toFixed(3).replace(/\.?0+$/, "");

export const buildYtDlpFetchArgs = (input: {
  url: string;
  outputTemplate: string;
  maxBytes: number;
  ffmpegPath: string;
  access: CliAccess;
  section: { startMs: number; durationMs: number } | null;
}): string[] => [
  "--ignore-config",
  "--no-playlist",
  "--no-progress",
  "--no-mtime",
  "--socket-timeout", SOCKET_TIMEOUT_S,
  "--retries", "1",
  "--fragment-retries", "2",
  "--extractor-retries", "1",
  "--max-filesize", String(input.maxBytes),
  "--ffmpeg-location", input.ffmpegPath,
  "-f", YTDLP_VIDEO_FORMAT,
  // `-j` prints the info JSON on stdout; `--no-simulate` makes it download as well.
  "-j", "--no-simulate",
  "-o", input.outputTemplate,
  ...(input.section ? ["--download-sections", `*${seconds(input.section.startMs)}-${seconds(input.section.startMs + input.section.durationMs)}`] : []),
  ...ytdlpAccessArgs(input.access),
  "--",
  input.url,
];

export const buildGalleryDlFetchArgs = (input: { url: string; directory: string; maxBytes: number; access: CliAccess }): string[] => [
  "--config-ignore",
  "--range", "1",
  "-D", input.directory,
  "-f", "media.{extension}",
  "--write-metadata",
  "--filesize-max", `${Math.max(1, Math.floor(input.maxBytes / 1024))}k`,
  "--http-timeout", SOCKET_TIMEOUT_S,
  "--retries", "1",
  ...galleryAccessArgs(input.access),
  "--",
  input.url,
];

export const buildYtDlpSearchArgs = (input: { query: string; limit: number; access: CliAccess }): string[] => [
  "--ignore-config",
  "--flat-playlist",
  "-J",
  "--socket-timeout", SOCKET_TIMEOUT_S,
  "--extractor-retries", "1",
  ...ytdlpAccessArgs(input.access),
  "--",
  `ytsearch${input.limit}:${input.query}`,
];

/** Search page URL that gallery-dl's Pinterest / X search extractors understand. */
export const gallerySearchUrl = (platform: SocialFetchPlatform, query: string): string | null => {
  const q = encodeURIComponent(query);
  if (platform === "pinterest") return `https://www.pinterest.com/search/pins/?q=${q}`;
  if (platform === "x") return `https://x.com/search?q=${q}%20filter%3Amedia&f=media`;
  return null;
};

export const buildGalleryDlSearchArgs = (input: { url: string; limit: number; access: CliAccess }): string[] => [
  "--config-ignore",
  "-j",
  "--range", `1-${input.limit}`,
  "--http-timeout", SOCKET_TIMEOUT_S,
  "--retries", "1",
  ...galleryAccessArgs(input.access),
  "--",
  input.url,
];

// --- error classification -----------------------------------------------------------------------

/** gallery-dl exit status is a bit set (gallery_dl/exception.py): 4 HttpError, 8 NotFound, 16 Authorization/AuthRequired, 64 NoExtractor. */
const GALLERY_EXIT_BITS: Array<[number, MediaFetchErrorCode]> = [
  [16, "FETCH_BOT_CHECK"],
  [8, "FETCH_UNAVAILABLE"],
  [64, "FETCH_EXTRACTOR_BROKEN"],
];

const PATTERNS: Array<[RegExp, MediaFetchErrorCode]> = [
  // Order matters: the most specific first (a cookies message often also contains "login").
  [/cookies? (are|is) no longer valid|cookies? (have|has) expired|invalid cookies|cookie file is invalid|failed to load cookies/i, "FETCH_COOKIES_INVALID"],
  [/file is larger than max-?filesize|larger than the maximum|filesize-max|exceeds? (the )?(maximum )?file ?size/i, "FETCH_TOO_LARGE"],
  [/HTTP Error 429|429 Too Many Requests|too many requests|rate.?limit/i, "FETCH_RATE_LIMITED"],
  [/confirm you.?re not a bot|sign in to confirm|not a robot|captcha|AuthRequired|AuthorizationError|login required|requires? (authentication|login|logging in)|use --cookies|account (is )?required|private account/i, "FETCH_BOT_CHECK"],
  [/HTTP Error 403|403[: ]+Forbidden|'403 Forbidden'|status code 403/i, "FETCH_FORBIDDEN"],
  [/video unavailable|has been removed|no longer available|private video|this video is private|not available in your country|geo.?restrict|this post (is|may be) (unavailable|not)|NotFoundError|HTTP Error 404|404[: ]+Not Found|does not exist|has been deleted/i, "FETCH_UNAVAILABLE"],
  [/unsupported url|no suitable extractor|unable to extract|no video formats found|requested format is not available|unable to download (json|webpage) metadata|extractorerror|KeyError|is not a valid URL/i, "FETCH_EXTRACTOR_BROKEN"],
  [/timed out|read timeout|connection (reset|refused|aborted)|temporary failure in name resolution|getaddrinfo|name or service not known|network is unreachable|ssl(error|:)|certificate verify failed|remote end closed|incomplete read/i, "FETCH_NETWORK"],
];

/** Normalises a failed CLI run (exit code + stderr tail) into one code. `tool` matters only for gallery-dl's exit bits. */
export const classifyFetchFailure = (tool: SocialFetchTool, exitCode: number | null, stderr: string): MediaFetchErrorCode => {
  for (const [pattern, code] of PATTERNS) if (pattern.test(stderr)) return code;
  if (tool === "gallery-dl" && exitCode !== null && exitCode > 0) {
    for (const [bit, code] of GALLERY_EXIT_BITS) if ((exitCode & bit) !== 0) return code;
    if ((exitCode & 4) !== 0) return "FETCH_FORBIDDEN";
  }
  return "FETCH_FAILED";
};

/** "Impersonate target chrome is not available" = curl_cffi missing: the impersonation step can never work on this worker. */
export const impersonationUnavailable = (stderr: string): boolean => /impersonate target .* (is )?not available|impersonation is not (available|supported)|curl.?cffi/i.test(stderr);

/** Codes a fresh re-extraction (new signed CDN links, new tokens) may fix. */
const RETRY_CODES: ReadonlySet<MediaFetchErrorCode> = new Set(["FETCH_FORBIDDEN", "FETCH_NETWORK", "FETCH_TIMEOUT"]);
/** Codes a browser-like client (TLS fingerprint + headers) may fix. */
const IMPERSONATE_CODES: ReadonlySet<MediaFetchErrorCode> = new Set(["FETCH_FORBIDDEN", "FETCH_BOT_CHECK"]);
/** Never retried inside the worker: the API acts on them (rotate cookies, cool down, next candidate) or nothing can help. */
export const MAX_FETCH_RUNS = 3;

/**
 * In-worker recovery (CR-MEDIA-OSS-FETCH §3.2 steps 1-2), given the runs so far: one fresh re-extraction after a 403 / network
 * error / timeout, then one run with browser impersonation after a 403 / bot check. Cookies, proxy and Apify are the API's steps.
 */
export const nextFetchStep = (attempts: readonly MediaFetchAttempt[], policy: MediaFetchImpersonate, impersonationWorks: boolean): MediaFetchAttemptStep | null => {
  const last = attempts.at(-1);
  if (!last || last.code === null || attempts.length >= MAX_FETCH_RUNS) return null;
  const did = (step: MediaFetchAttemptStep) => attempts.some((a) => a.step === step);
  if (RETRY_CODES.has(last.code) && !did("retry") && last.step === "plain") return "retry";
  if (IMPERSONATE_CODES.has(last.code) && policy === "auto" && impersonationWorks && !did("impersonate")) return "impersonate";
  return null;
};

export const firstFetchStep = (policy: MediaFetchImpersonate): MediaFetchAttemptStep => (policy === "always" ? "impersonate" : "plain");

/** Strips anything that looks like a token / cookie value / proxy credential before an error message leaves the worker. */
export const redactCliText = (text: string): string =>
  text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|sig|signature|x-expires|expire|policy|key|access_token|tt_chain_token|msToken)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .slice(-600);

// --- output parsing -----------------------------------------------------------------------------

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
const tagList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, 30) : []);
const rec = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** yt-dlp info dict (`-j`/`-J`) -> source-neutral metadata. */
export const ytdlpInfo = (raw: Record<string, unknown>): SocialMediaInfo => ({
  externalId: str(raw.id),
  title: str(raw.title) ?? str(raw.fulltitle),
  description: str(raw.description),
  uploader: str(raw.uploader) ?? str(raw.uploader_id),
  channel: str(raw.channel) ?? str(raw.creator),
  webpageUrl: str(raw.webpage_url) ?? str(raw.original_url),
  durationSeconds: num(raw.duration),
  width: num(raw.width),
  height: num(raw.height),
  thumbnailUrl: str(raw.thumbnail),
  viewCount: num(raw.view_count),
  likeCount: num(raw.like_count),
  uploadDate: str(raw.upload_date) ?? (num(raw.timestamp) !== null ? new Date(num(raw.timestamp)! * 1000).toISOString() : null),
  tags: tagList(raw.tags),
  language: str(raw.language),
});

/** The last JSON object line of yt-dlp `-j --no-simulate` stdout (other lines are progress / messages). */
export const lastJsonLine = (stdout: string): Record<string, unknown> | null => {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // keep looking
    }
  }
  return null;
};

/**
 * Pinterest pin ids / X tweet ids are 17-19 digit integers in gallery-dl's JSON: above Number.MAX_SAFE_INTEGER, so a plain JSON.parse
 * rounds them and the rebuilt post URL points at another (or no) pin (probe 08/10: 8/8 FETCH_UNAVAILABLE). Id-like keys with 16+ digit
 * integer values are turned into strings before parsing.
 */
export const parseJsonKeepingBigIds = (text: string): unknown =>
  JSON.parse(text.replace(/("(?:id|tweet_id|pin_id|conversation_id|retweet_id|quote_id|reply_id|user_id)"\s*:\s*)(-?\d{16,})/g, '$1"$2"'));

/** gallery-dl kwdict (metadata file or `-j` entry) -> source-neutral metadata. Field names differ per extractor (Pinterest vs X). */
export const galleryInfo = (platform: SocialFetchPlatform, kw: Record<string, unknown>): SocialMediaInfo => {
  const author = rec(kw.author);
  const pinner = rec(kw.pinner);
  const id = str(kw.tweet_id) ?? str(kw.id) ?? (num(kw.tweet_id) ?? num(kw.id))?.toString() ?? null;
  const authorName = str(author.name) ?? str(pinner.username) ?? str(kw.username);
  const webpageUrl =
    platform === "x" && id && authorName ? `https://x.com/${authorName}/status/${id}` : platform === "pinterest" && id ? `https://www.pinterest.com/pin/${id}/` : str(kw.url);
  return {
    externalId: id,
    title: str(kw.grid_title) ?? str(kw.title),
    description: str(kw.content) ?? str(kw.description) ?? str(kw.auto_alt_text),
    uploader: authorName,
    channel: str(author.nick) ?? str(pinner.full_name),
    webpageUrl,
    durationSeconds: num(kw.duration),
    width: num(kw.width),
    height: num(kw.height),
    thumbnailUrl: null,
    viewCount: num(kw.view_count),
    likeCount: num(kw.favorite_count) ?? num(kw.reaction_counts),
    uploadDate: str(kw.date) ?? str(kw.created_at),
    tags: tagList(kw.hashtags),
    language: str(kw.lang),
  };
};

/** https URL on a Pinterest / X image CDN (no credentials, no port). */
const isDirectMediaUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password && !u.port && SOCIAL_DIRECT_MEDIA_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
};

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "m3u8"]);

/**
 * `gallery-dl -j` prints a JSON array of messages; Url messages are `[3, url, kwdict]` (gallery_dl/message.py). One item per post
 * (the first file of a multi-image post wins), only posts whose page URL is on the platform's hosts, never more than `limit`.
 */
export const parseGallerySearch = (platform: SocialFetchPlatform, stdout: string, mediaType: "video" | "image", limit: number): SocialSearchItem[] => {
  let messages: unknown;
  try {
    messages = parseJsonKeepingBigIds(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(messages)) return [];
  const items: SocialSearchItem[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 3 || typeof message[1] !== "string") continue;
    const kw = rec(message[2]);
    const info = galleryInfo(platform, kw);
    const extension = (str(kw.extension) ?? "").toLowerCase();
    const kind: "video" | "image" = VIDEO_EXTENSIONS.has(extension) ? "video" : "image";
    if (kind !== mediaType || !info.webpageUrl || !isAllowedSocialPostUrl(platform, info.webpageUrl)) continue;
    const key = info.externalId ?? info.webpageUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ ...info, url: info.webpageUrl, mediaType: kind, mediaUrl: kind === "image" && isDirectMediaUrl(message[1]) ? message[1] : null });
    if (items.length >= limit) break;
  }
  return items;
};

/** `yt-dlp --flat-playlist -J ytsearchN:...` -> items with a canonical watch/shorts URL. */
export const parseYtDlpSearch = (stdout: string, limit: number): SocialSearchItem[] => {
  let data: Record<string, unknown>;
  try {
    data = rec(JSON.parse(stdout));
  } catch {
    return [];
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const items: SocialSearchItem[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const raw = rec(entry);
    const id = str(raw.id);
    if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const given = str(raw.url);
    const url = given && isAllowedSocialPostUrl("youtube", given) ? given : `https://www.youtube.com/watch?v=${id}`;
    const thumbnails = Array.isArray(raw.thumbnails) ? raw.thumbnails.map(rec) : [];
    items.push({ ...ytdlpInfo(raw), externalId: id, webpageUrl: url, thumbnailUrl: str(raw.thumbnail) ?? str(thumbnails.at(-1)?.url), url, mediaType: "video" });
    if (items.length >= limit) break;
  }
  return items;
};

/** First line of `yt-dlp --version` / `gallery-dl --version`. */
export const parseToolVersion = (stdout: string): string => stdout.split(/\r?\n/)[0]?.trim() || "unknown";
