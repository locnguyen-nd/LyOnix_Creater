/**
 * Apify adapter (VE2E-45 account probe + VE2E-34 allowlisted Actor search).
 *
 * Source of truth for Actor choice: `.docs/specs/VE2E-APIFY-ACTORS.md` and
 * DEC-2026-09-29-JP-ONESHOT-MEDIA.md #1/#5/#10-#16. Rules enforced here:
 *  - Actor ids + versions are PINNED in `APIFY_ACTOR_ALLOWLIST`; nothing from a client selects an Actor.
 *    A backup Actor is only tried after the primary failed (not on an auth error - same token).
 *  - Per call: at most `APIFY_MAX_RESULTS` (20) items, 120 s run timeout, 1 retry.
 *  - Every dataset item is UNTRUSTED (fields may be missing/renamed - the spec marks several
 *    UNVERIFIED): parsing is defensive, URLs must be https + on the platform host allowlist, strings are
 *    clipped, and nothing is invented. An item without a usable id is dropped.
 *  - Candidates are `owner_accepted_risk` (never `cleared`) with full provenance. Google video and
 *    Pinterest HLS-only are discovery/preview-only (`accessMethod: "discovery_only"`, not auto-eligible).
 *  - The API token is only ever sent as a Bearer header to `api.apify.com`; it is redacted from
 *    every error message. Signed CDN links are never used as an import source.
 */
import type { MediaCandidate, SocialCandidateSignals } from "@lyonix/domain";
import { ProviderError } from "./index.js";

const API_BASE = "https://api.apify.com";
const timeoutMs = 30_000;

export const APIFY_MAX_RESULTS = 20;
export const APIFY_RUN_TIMEOUT_SECS = 120;
/** VE2E-51: run timeout for the phase that DOWNLOADS video (spec VE2E-APIFY-ACTORS section 5: 240 s for clockworks); search-only runs keep 120 s. */
export const APIFY_DOWNLOAD_RUN_TIMEOUT_SECS = 240;
/**
 * VE2E-51: input field of `clockworks/tiktok-scraper` that takes direct post URLs. The name is from the Actor's public
 * input schema and is UNVERIFIED in this repo (see the VE2E-51 handoff for the read-only probe); callers may override it.
 */
export const APIFY_TIKTOK_POST_URL_FIELD = "postURLs";
export const APIFY_MAX_RETRIES = 1;
export const APIFY_ADAPTER_VERSION = "apify-adapter.v1";

// --- errors / redaction -------------------------------------------------------------------

/** Redacts the exact token and anything token-like if it leaks into an error body. */
const redact = (value: string, token: string) => {
  const stripped = token ? value.split(token).join("[redacted]") : value;
  return stripped.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 220);
};

const messageOf = (body: Record<string, unknown>): string => {
  const error = body.error;
  if (error && typeof error === "object") { const nested = (error as Record<string, unknown>).message; if (typeof nested === "string") return nested; }
  if (typeof body.message === "string") return body.message;
  return typeof error === "string" ? error : "";
};

async function failFromResponse(response: Response, token: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const message = messageOf(body);
  const suffix = message ? `: ${redact(message, token)}` : "";
  const status = response.status;
  if (status === 401) throw new ProviderError("PROVIDER_AUTH_INVALID", `Apify authentication failed${suffix}`, false);
  if (status === 403) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Apify token lacks permission${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `Apify rate limit reached${suffix}`, true, Number(response.headers.get("retry-after") ?? 0) * 1000 || undefined);
  if (status === 400 || status === 404 || status === 422) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `Apify rejected the request (${status})${suffix}`, false);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `Apify request failed (${status})${suffix}`, status >= 500);
}

// --- fetch deps (injectable for tests) ------------------------------------------------------

export type ApifyDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** VE2E-51: cost/time accounting of Actor runs (all attempts of a call, incl. failed/retried ones). `usd` is null when Apify reported no `usageTotalUsd`. */
export type ApifyUsage = { runs: number; seconds: number; usd: number | null };
export const emptyApifyUsage = (): ApifyUsage => ({ runs: 0, seconds: 0, usd: null });
export const addApifyUsage = (into: ApifyUsage, add: ApifyUsage): ApifyUsage => {
  into.runs += add.runs;
  into.seconds = Math.round((into.seconds + add.seconds) * 100) / 100;
  if (add.usd !== null) into.usd = Math.round(((into.usd ?? 0) + add.usd) * 1e6) / 1e6;
  return into;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function apifyFetch(deps: ApifyDeps | undefined, path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const doFetch = deps?.fetch ?? fetch;
  try {
    return await doFetch(`${API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProviderError("PROVIDER_TIMEOUT", "Apify request timed out or network failed", true);
  }
}

// --- account preflight (VE2E-45) --------------------------------------------------------------

/** Read-only `GET /v2/users/me`; never starts an Actor run (no cost). */
export async function probeApifyAccount(accessToken: string, deps?: ApifyDeps): Promise<{ verifiedAt: string }> {
  const response = await apifyFetch(deps, "/v2/users/me", accessToken);
  if (response.ok) return { verifiedAt: new Date().toISOString() };
  return failFromResponse(response, accessToken);
}

/**
 * VE2E-131: the plan's real concurrent Actor-run cap, read-only `GET /v2/users/me/limits` (`data.limits.maxConcurrentActorJobs`,
 * Apify docs: Starter 32). Best-effort: any failure/unexpected shape returns `null` (callers then keep the env value). Never starts a run.
 * NOT yet verified against a live account in this repo (no probe was run); the shape is read defensively.
 */
export async function fetchApifyConcurrencyLimit(accessToken: string, deps?: ApifyDeps): Promise<number | null> {
  try {
    const response = await apifyFetch(deps, "/v2/users/me/limits", accessToken);
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { data?: { limits?: { maxConcurrentActorJobs?: unknown } } } | null;
    const value = body?.data?.limits?.maxConcurrentActorJobs;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
  } catch {
    return null;
  }
}

// --- pinned Actor allowlist -------------------------------------------------------------------

export const apifyPlatforms = ["tiktok", "pinterest", "x", "google_image", "google_video"] as const;
export type ApifyPlatform = (typeof apifyPlatforms)[number];
export const isApifyPlatform = (value: unknown): value is ApifyPlatform => typeof value === "string" && (apifyPlatforms as readonly string[]).includes(value);

export type ApifyActorPin = { actorId: string; version: string };

/**
 * Pinned, owner-approved Actors (DEC #10). `version` is the Actor build passed as the `build` run
 * parameter (spec table, 2026-09-30). Backups are only used after the primary failed.
 * Google video is discovery/preview only (DEC #11).
 */
export const APIFY_ACTOR_ALLOWLIST: Record<ApifyPlatform, { primary: ApifyActorPin; backup: ApifyActorPin | null }> = {
  tiktok: { primary: { actorId: "clockworks/tiktok-scraper", version: "0.0.611" }, backup: { actorId: "apidojo/tiktok-scraper", version: "0.0.1111" } },
  pinterest: { primary: { actorId: "fatihtahta/pinterest-scraper-search", version: "1.1.8" }, backup: { actorId: "silentflow/pinterest-scraper-ppr", version: "1.0.27" } },
  // Owner 2026-10-07: Tweet Scraper V2 (apidojo) first - the kaito Actor returned 0 items for Japanese queries; kaito stays as the backup.
  x: { primary: { actorId: "apidojo/tweet-scraper", version: "latest" }, backup: { actorId: "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest", version: "0.0.68" } },
  google_image: { primary: { actorId: "damilo/google-images-scraper", version: "0.0.4" }, backup: { actorId: "hooli/google-images-scraper", version: "0.0.46" } },
  google_video: { primary: { actorId: "johnvc/google-short-videos-api", version: "0.0.107" }, backup: { actorId: "searchapi/google-videos-scraper", version: "3.0.5" } },
};

/** Per-platform download policy applied by the API import path (safe-fetch). Suffixes match whole DNS labels. */
export const APIFY_HOST_ALLOWLIST = {
  tiktok: ["tiktokcdn.com", "tiktokcdn-eu.com"],
  pinterest: ["pinimg.com"],
  x: ["twimg.com"],
  apifyApi: ["api.apify.com"],
  /** Preview-only hosts (never a download source). */
  googlePreview: ["gstatic.com"],
} as const;

export const APIFY_MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const APIFY_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** True when `host` equals a suffix or is a subdomain of it (label boundary; `evilpinimg.com` does not match `pinimg.com`). IP literals never match. */
export const hostMatchesSuffix = (host: string, suffixes: readonly string[]): boolean => {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(h) || h.includes(":")) return false;
  return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
};

// --- actor input builders (only the fields the spec names; everything else default) ---------------

export type ApifyLang = "ja" | "en";
export type ApifySearchInput = { platform: ApifyPlatform; keyword: string; lang: ApifyLang; limit?: number };

const countryOf = (lang: ApifyLang) => (lang === "ja" ? "JP" : "US");

export type ActorInputOptions = {
  /** TikTok (clockworks) only: `false` = search-only phase (no video/cover download, pay per result only). Default `true` (unchanged single-phase). */
  download?: boolean;
};

export function buildActorInput(actorId: string, keyword: string, lang: ApifyLang, limit: number, options: ActorInputOptions = {}): Record<string, unknown> {
  switch (actorId) {
    case "clockworks/tiktok-scraper": {
      const download = options.download !== false;
      return { searchQueries: [keyword], searchSection: "/video", resultsPerPage: limit, proxyCountryCode: countryOf(lang), shouldDownloadVideos: download, shouldDownloadCovers: download, shouldDownloadSlideshowImages: false };
    }
    case "apidojo/tiktok-scraper":
      return { keywords: [keyword], maxItems: Math.max(limit, 10), location: countryOf(lang), sortType: "RELEVANCE" };
    case "fatihtahta/pinterest-scraper-search":
      return { queries: [keyword], type: "all-pins", limit };
    case "silentflow/pinterest-scraper-ppr":
      return { search: keyword, maxItems: limit };
    case "apidojo/tweet-scraper":
      // V2 bills at least 50 tweets per query, so ask for 50 (the dataset read is still bounded by `limit`).
      return { searchTerms: [keyword], sort: "Top", onlyVideo: true, tweetLanguage: lang, maxItems: Math.max(limit, 50) };
    case "kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest":
      return { searchTerms: [keyword], queryType: "Videos", lang, maxItems: limit };
    case "apidojo/twitter-scraper-lite":
      return { searchTerms: [`${keyword} lang:${lang} filter:native_video`], sort: "Top", maxItems: limit };
    case "damilo/google-images-scraper":
      return { query: keyword, country: lang === "ja" ? "jp" : "us", language: lang, num: "10", max_pages: 1, date_range: "anytime" };
    case "hooli/google-images-scraper":
      return { queries: [keyword], maxResultsPerQuery: limit };
    case "johnvc/google-short-videos-api":
      return { q: keyword, gl: lang === "ja" ? "jp" : "us", hl: lang, max_pages: 1 };
    case "searchapi/google-videos-scraper":
      return { mode: "single", query: keyword, platform: "all", maxItems: limit, maxPages: 1, gl: lang === "ja" ? "jp" : "us", hl: lang };
    default:
      throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Apify Actor is not on the approved allowlist", false);
  }
}

// --- run an Actor ------------------------------------------------------------------------------------

const actorPath = (actorId: string) => actorId.replace("/", "~");
const TERMINAL_FAILURES = new Set(["FAILED", "ABORTED", "ABORTING", "TIMED-OUT"]);

/**
 * Actors for which the `maxItems` run query param (Apify max-charge cap) is verified to work (live probe 2026-09-30).
 * Pay-per-event Actors reject it (fatihtahta: HTTP 400 "Maximum cost per run ... minimum of $1.00"), so for every
 * other Actor the result count is bounded only through the Actor INPUT (see buildActorInput) plus `limit` on the dataset read.
 */
export const APIFY_MAX_ITEMS_QUERY_ACTORS: ReadonlySet<string> = new Set(["clockworks/tiktok-scraper"]);

type RunResult = { runId: string; items: unknown[]; timedOutWithItems: boolean };
type RunOptions = { timeoutSecs: number; usage: ApifyUsage };

const runSeconds = (run: Record<string, unknown>, fallback: number): number => {
  const stats = run.stats;
  const fromStats = stats && typeof stats === "object" ? (stats as Record<string, unknown>).runTimeSecs : undefined;
  if (typeof fromStats === "number" && Number.isFinite(fromStats) && fromStats >= 0) return fromStats;
  const started = typeof run.startedAt === "string" ? Date.parse(run.startedAt) : NaN;
  const finished = typeof run.finishedAt === "string" ? Date.parse(run.finishedAt) : NaN;
  if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) return (finished - started) / 1000;
  return fallback;
};

async function readDataset(token: string, run: Record<string, unknown>, limit: number, deps?: ApifyDeps): Promise<unknown[]> {
  const datasetId = typeof run.defaultDatasetId === "string" ? run.defaultDatasetId : "";
  if (!datasetId || !/^[A-Za-z0-9]+$/.test(datasetId)) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Apify run has no dataset", false);
  const dataset = await apifyFetch(deps, `/v2/datasets/${datasetId}/items?clean=true&format=json&limit=${limit}`, token);
  if (!dataset.ok) return failFromResponse(dataset, token);
  const items = await dataset.json().catch(() => null);
  if (!Array.isArray(items)) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Apify dataset was not a list", false);
  return items.slice(0, limit);
}

/**
 * Runs one pinned Actor asynchronously (start -> poll <= `timeoutSecs` -> read dataset). Aborts the run if it overruns.
 * VE2E-51: a run that ended TIMED-OUT (or that we aborted at our own deadline) but already produced dataset items is a
 * SUCCESS with those items (owner job bb9b2449 re-ran a TIMED-OUT run that already held 10 items). Usage of every run is
 * accumulated into `options.usage` even when the run fails.
 */
async function runActorOnce(token: string, pin: ApifyActorPin, input: Record<string, unknown>, limit: number, deps: ApifyDeps | undefined, options: RunOptions): Promise<RunResult> {
  const now = deps?.now ?? Date.now;
  const sleep = deps?.sleep ?? defaultSleep;
  const t0 = now();
  let run: Record<string, unknown> = {};
  let started = false;
  try {
    const start = await apifyFetch(deps, `/v2/acts/${actorPath(pin.actorId)}/runs?build=${encodeURIComponent(pin.version)}&timeout=${options.timeoutSecs}${APIFY_MAX_ITEMS_QUERY_ACTORS.has(pin.actorId) ? `&maxItems=${limit}` : ""}`, token, { method: "POST", body: input });
    if (!start.ok) return await failFromResponse(start, token);
    const began = ((await start.json().catch(() => ({}))) as { data?: Record<string, unknown> }).data ?? {};
    const runId = typeof began.id === "string" ? began.id : "";
    if (!runId || !/^[A-Za-z0-9]+$/.test(runId)) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Apify did not return a run id", false);
    started = true;
    run = began;

    const deadline = t0 + options.timeoutSecs * 1000;
    for (;;) {
      const status = typeof run.status === "string" ? run.status : "";
      if (status === "SUCCEEDED") break;
      if (status === "TIMED-OUT") {
        const items = await readDataset(token, run, limit, deps).catch(() => [] as unknown[]);
        if (items.length > 0) return { runId, items, timedOutWithItems: true };
        throw new ProviderError("PROVIDER_UNAVAILABLE", `Apify run ended with status ${status}`, true);
      }
      if (TERMINAL_FAILURES.has(status)) throw new ProviderError("PROVIDER_UNAVAILABLE", `Apify run ended with status ${status}`, true);
      if (now() >= deadline) {
        await apifyFetch(deps, `/v2/actor-runs/${runId}/abort`, token, { method: "POST" }).catch(() => undefined);
        const items = await readDataset(token, run, limit, deps).catch(() => [] as unknown[]);
        if (items.length > 0) return { runId, items, timedOutWithItems: true };
        throw new ProviderError("PROVIDER_TIMEOUT", "Apify run exceeded the time limit", true);
      }
      await sleep(1000);
      const poll = await apifyFetch(deps, `/v2/actor-runs/${runId}?waitForFinish=20`, token);
      if (!poll.ok) return await failFromResponse(poll, token);
      run = ((await poll.json().catch(() => ({}))) as { data?: Record<string, unknown> }).data ?? {};
    }
    return { runId, items: await readDataset(token, run, limit, deps), timedOutWithItems: false };
  } finally {
    if (started) {
      const usd = typeof run.usageTotalUsd === "number" && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0 ? run.usageTotalUsd : null;
      addApifyUsage(options.usage, { runs: 1, seconds: runSeconds(run, (now() - t0) / 1000), usd });
    }
  }
}

/** One retry (network/5xx/FAILED/timeout) with a short backoff; auth/permission/schema errors never retry. */
async function runActorWithRetry(token: string, pin: ApifyActorPin, input: Record<string, unknown>, limit: number, deps: ApifyDeps | undefined, options: RunOptions): Promise<RunResult> {
  const sleep = deps?.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runActorOnce(token, pin, input, limit, deps, options);
    } catch (error) {
      const retryable = error instanceof ProviderError && error.retryable && error.code !== "PROVIDER_RATE_LIMITED";
      if (!retryable || attempt >= APIFY_MAX_RETRIES) throw error;
      await sleep(2000);
    }
  }
}

// --- untrusted-output parsing helpers ----------------------------------------------------------------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const num = (v: unknown): number | null => { const n = typeof v === "string" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null; };
const at = (obj: unknown, ...path: string[]): unknown => path.reduce<unknown>((cur, key) => (isObj(cur) ? cur[key] : undefined), obj);
const firstStr = (...values: unknown[]): string => { for (const v of values) { const s = clip(v, 2048); if (s) return s; } return ""; };

/** https URL (no credentials) whose host matches `suffixes`; anything else -> "". */
const safeUrl = (raw: unknown, suffixes: readonly string[]): string => {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > 2048) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return hostMatchesSuffix(url.hostname, suffixes) ? url.toString() : "";
  } catch { return ""; }
};
/** https URL on ANY public host (page links / Google image sources); the safe-fetch layer re-validates before any download. */
const anyHttpsUrl = (raw: unknown): string => {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > 2048) return "";
  try { const url = new URL(text); return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".") ? url.toString() : ""; } catch { return ""; }
};

const fnv = (text: string) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };

/** How the API import path may download a candidate. `null` = preview/discovery only. */
export type ApifyDownloadPlan = {
  url: string;
  kind: "video" | "image";
  /** `apify_api` = api.apify.com with the server-side token; `suffix` = platform CDN allowlist; `public_web` = any public host (Google image). */
  policy: "apify_api" | "suffix" | "public_web";
  hostSuffixes: string[];
  maxBytes: number;
};

type Normalized = {
  externalId: string;
  mediaType: "video" | "photo";
  previewUrl: string;
  download: ApifyDownloadPlan | null;
  /** Machine-readable why not downloadable (only when `download` is null). */
  previewOnlyReason?: string;
  durationSeconds: number | null;
  widthPx: number | null;
  heightPx: number | null;
  author: string | null;
  authorUrl: string | null;
  sourceUrl: string | null;
  text: string;
  /** VE2E-51: dataset quality signals (TikTok) used by the pre-download filter. */
  social?: SocialCandidateSignals;
  /** VE2E-51: search-only phase - the video page URL to fetch in phase 2 (no file is stored yet). */
  deferredPostUrl?: string;
};

type NormalizeOptions = { deferDownload?: boolean };

const parseDuration = (v: unknown): number | null => {
  const n = num(v);
  if (n !== null) return n;
  if (typeof v === "string" && /^\d{1,2}(:\d{2}){1,2}$/.test(v.trim())) return v.trim().split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  return null;
};

const PREVIEW_HOSTS = { tiktok: [...APIFY_HOST_ALLOWLIST.tiktok, "tiktokv.com"], pinterest: APIFY_HOST_ALLOWLIST.pinterest, x: APIFY_HOST_ALLOWLIST.x, google: APIFY_HOST_ALLOWLIST.googlePreview } as const;

/**
 * With shouldDownloadCovers the Actor rewrites `videoMeta.coverUrl` to a token-protected api.apify.com KV URL that a browser
 * cannot load. Prefer `originalCoverUrl` (signed public CDN); `coverUrl` counts only if its host is a preview CDN.
 */
const tiktokPreview = (item: Json): string => {
  for (const raw of [at(item, "videoMeta", "originalCoverUrl"), at(item, "videoMeta", "coverUrl"), at(item, "video", "cover"), at(item, "video", "thumbnail")]) {
    const url = safeUrl(raw, PREVIEW_HOSTS.tiktok);
    if (url) return url;
  }
  return "";
};

/** Hashtags arrive as strings or `{ name }` objects depending on the Actor build; both are accepted (clipped, max 30). */
const tiktokHashtags = (item: Json): string[] => {
  if (!Array.isArray(item.hashtags)) return [];
  const out: string[] = [];
  for (const tag of item.hashtags) {
    const name = typeof tag === "string" ? clip(tag, 60) : isObj(tag) ? clip(tag.name ?? tag.title, 60) : "";
    if (name) out.push(name);
    if (out.length >= 30) break;
  }
  return out;
};

const TIKTOK_PAGE_HOSTS = ["tiktok.com"] as const;

function normalizeTikTok(item: Json, options: NormalizeOptions = {}): Normalized | null {
  if (item.error || item.errorCode) return null;
  const externalId = clip(item.id, 64) || clip(at(item, "video", "id"), 64) || clip(item.postPage, 200);
  if (!externalId || item.isSlideshow === true) return null;
  // DEC #13: only a Key-Value Store file served by api.apify.com (server-side token) is an import source; signed CDN links are not.
  const kv = safeUrl(Array.isArray(item.mediaUrls) ? item.mediaUrls[0] : undefined, APIFY_HOST_ALLOWLIST.apifyApi);
  const kvOk = kv && new URL(kv).pathname.startsWith("/v2/key-value-stores/") ? kv : "";
  const author = clip(at(item, "authorMeta", "name"), 100) || clip(at(item, "channel", "username"), 100) || clip(at(item, "channel", "name"), 100) || null;
  const pageUrl = anyHttpsUrl(item.webVideoUrl ?? item.postPage);
  // Search-only phase: no stored file yet; the page URL (tiktok.com only) is what phase 2 downloads.
  const deferred = !kvOk && options.deferDownload && pageUrl && safeUrl(pageUrl, TIKTOK_PAGE_HOSTS) ? pageUrl : "";
  const durationSeconds = num(at(item, "videoMeta", "duration") ?? at(item, "video", "duration"));
  const widthPx = num(at(item, "videoMeta", "width") ?? at(item, "video", "width"));
  const heightPx = num(at(item, "videoMeta", "height") ?? at(item, "video", "height"));
  const text = clip(item.text ?? item.title, 500);
  const language = clip(item.textLanguage, 12);
  const country = clip(at(item, "locationMeta", "countryCode"), 12);
  return {
    externalId,
    mediaType: "video",
    previewUrl: tiktokPreview(item),
    download: kvOk ? { url: kvOk, kind: "video", policy: "apify_api", hostSuffixes: [...APIFY_HOST_ALLOWLIST.apifyApi], maxBytes: APIFY_MAX_VIDEO_BYTES } : null,
    ...(kvOk || deferred ? {} : { previewOnlyReason: "no_apify_stored_file" }),
    ...(deferred ? { deferredPostUrl: deferred } : {}),
    durationSeconds,
    widthPx,
    heightPx,
    author,
    authorUrl: anyHttpsUrl(at(item, "authorMeta", "profileUrl") ?? at(item, "channel", "url")) || null,
    sourceUrl: pageUrl || null,
    text,
    social: {
      videoId: externalId,
      text,
      hashtags: tiktokHashtags(item),
      textLanguage: language || null,
      countryCode: country || null,
      isAd: item.isAd === true,
      isSponsored: item.isSponsored === true,
      widthPx,
      heightPx,
      durationSeconds,
    },
  };
}

function normalizePinterest(item: Json): Normalized | null {
  const externalId = clip(item.id, 64) || clip(item.url ?? item.pinUrl, 200);
  if (!externalId) return null;
  const images = at(item, "media", "images");
  const bestImage = safeUrl(at(images, "original", "url") ?? at(images, "large", "url") ?? at(images, "medium", "url") ?? item.imageUrl ?? at(item, "imageUrls", "original"), PREVIEW_HOSTS.pinterest);
  const mediumImage = safeUrl(at(images, "medium", "url") ?? at(images, "small", "url") ?? at(item, "media", "video", "thumbnail") ?? at(item, "media", "cover") ?? item.imageUrl, PREVIEW_HOSTS.pinterest) || bestImage;
  const video = at(item, "media", "video");
  // A direct mp4 on pinimg.com is importable; an HLS (m3u8)-only video is preview-only (DEC #12 - FFmpeg never reads remote URLs).
  const mp4 = safeUrl(at(video, "mp4_url") ?? at(video, "url") ?? at(video, "video_url") ?? item.videoUrl, PREVIEW_HOSTS.pinterest);
  const directMp4 = mp4 && /\.mp4$/i.test(new URL(mp4).pathname) ? mp4 : "";
  const hasVideo = item.isVideo === true || at(item, "pin", "is_video") === true || Boolean(video) || Boolean(item.videoUrl);
  const author = clip(at(item, "creator", "username") ?? at(item, "pinner", "username"), 100) || null;
  const common = {
    externalId,
    author,
    authorUrl: anyHttpsUrl(at(item, "creator", "url") ?? at(item, "pinner", "profileUrl")) || null,
    sourceUrl: anyHttpsUrl(item.url ?? item.pinUrl) || null,
    text: [clip(at(item, "pin", "title") ?? item.title, 200), clip(at(item, "pin", "description") ?? item.description, 300)].filter(Boolean).join(" ").slice(0, 500),
  };
  if (hasVideo) {
    return {
      ...common,
      mediaType: "video",
      previewUrl: mediumImage,
      download: directMp4 ? { url: directMp4, kind: "video", policy: "suffix", hostSuffixes: [...APIFY_HOST_ALLOWLIST.pinterest], maxBytes: APIFY_MAX_VIDEO_BYTES } : null,
      ...(directMp4 ? {} : { previewOnlyReason: "hls_only_preview" }),
      durationSeconds: num(at(video, "duration") ?? item.videoDuration),
      widthPx: num(at(video, "width") ?? item.width),
      heightPx: num(at(video, "height") ?? item.height),
    };
  }
  if (!bestImage) return null;
  return {
    ...common,
    mediaType: "photo",
    previewUrl: mediumImage,
    download: { url: bestImage, kind: "image", policy: "suffix", hostSuffixes: [...APIFY_HOST_ALLOWLIST.pinterest], maxBytes: APIFY_MAX_IMAGE_BYTES },
    durationSeconds: null,
    widthPx: num(at(images, "original", "width") ?? item.width),
    heightPx: num(at(images, "original", "height") ?? item.height),
  };
}

/** X media field names are UNVERIFIED in the spec: probe several plausible shapes, invent nothing. */
function normalizeX(item: Json): Normalized | null {
  const externalId = clip(item.id ?? item.id_str, 64);
  if (!externalId) return null;
  const buckets: unknown[] = [];
  for (const source of [item.media, at(item, "extendedEntities", "media"), at(item, "extended_entities", "media"), at(item, "entities", "media")]) {
    if (Array.isArray(source)) buckets.push(...source);
    else if (isObj(source)) buckets.push(source);
  }
  let video = "";
  let image = "";
  let preview = "";
  let duration: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  for (const entry of buckets) {
    if (typeof entry === "string") {
      const url = safeUrl(entry, PREVIEW_HOSTS.x);
      if (url && /\.mp4$/i.test(new URL(url).pathname) && !video) video = url;
      else if (url && !image) image = url;
      continue;
    }
    if (!isObj(entry)) continue;
    const variants = at(entry, "video_info", "variants") ?? entry.variants;
    if (Array.isArray(variants) && !video) {
      const mp4s = variants.filter(isObj).map((v) => ({ url: safeUrl(v.url, PREVIEW_HOSTS.x), bitrate: num(v.bitrate) ?? 0, type: clip(v.content_type ?? v.contentType, 40) })).filter((v) => v.url && (v.type === "video/mp4" || /\.mp4$/i.test(new URL(v.url).pathname)));
      const best = mp4s.sort((a, b) => b.bitrate - a.bitrate)[0];
      if (best) { video = best.url; duration = num(at(entry, "video_info", "duration_millis")) !== null ? num(at(entry, "video_info", "duration_millis"))! / 1000 : null; width = num(at(entry, "original_info", "width")); height = num(at(entry, "original_info", "height")); }
    }
    const direct = safeUrl(entry.video_url ?? entry.videoUrl, PREVIEW_HOSTS.x);
    if (direct && !video) video = direct;
    const thumb = safeUrl(entry.media_url_https ?? entry.mediaUrl ?? entry.previewImageUrl ?? entry.thumbnail ?? entry.url, PREVIEW_HOSTS.x);
    if (thumb && !preview) preview = thumb;
    if (!image && thumb && !/\.mp4$/i.test(new URL(thumb).pathname) && clip(entry.type, 20) === "photo") image = thumb;
  }
  const author = clip(at(item, "author", "userName") ?? at(item, "user", "screen_name"), 100) || null;
  const common = {
    externalId,
    author,
    authorUrl: anyHttpsUrl(at(item, "author", "url")) || null,
    sourceUrl: anyHttpsUrl(item.url ?? item.twitterUrl) || null,
    text: clip(item.text ?? item.fullText, 500),
  };
  if (video) {
    return { ...common, mediaType: "video", previewUrl: preview, download: { url: video, kind: "video", policy: "suffix", hostSuffixes: [...APIFY_HOST_ALLOWLIST.x], maxBytes: APIFY_MAX_VIDEO_BYTES }, durationSeconds: duration, widthPx: width, heightPx: height };
  }
  if (image) {
    return { ...common, mediaType: "photo", previewUrl: preview || image, download: { url: image, kind: "image", policy: "suffix", hostSuffixes: [...APIFY_HOST_ALLOWLIST.x], maxBytes: APIFY_MAX_IMAGE_BYTES }, durationSeconds: null, widthPx: null, heightPx: null };
  }
  return null; // no verifiable media field: nothing to offer (never guess)
}

function normalizeGoogleImage(item: Json): Normalized | null {
  const imageUrl = anyHttpsUrl(item.imageUrl);
  if (!imageUrl) return null;
  return {
    externalId: fnv(imageUrl),
    mediaType: "photo",
    previewUrl: safeUrl(item.thumbnailUrl, PREVIEW_HOSTS.google),
    // DEC #14: arbitrary host -> public-web safe-fetch (private IP/redirect/rebinding/size/MIME limits), never a suffix allowlist.
    download: { url: imageUrl, kind: "image", policy: "public_web", hostSuffixes: [], maxBytes: APIFY_MAX_IMAGE_BYTES },
    durationSeconds: null,
    widthPx: num(item.imageWidth),
    heightPx: num(item.imageHeight),
    author: clip(item.origin, 100) || null,
    authorUrl: null,
    sourceUrl: anyHttpsUrl(item.link ?? item.contentUrl) || null,
    text: clip(item.title, 500),
  };
}

function normalizeGoogleVideo(item: Json): Normalized | null {
  if (typeof item.result_type === "string" && item.result_type !== "short_video") return null;
  const page = anyHttpsUrl(item.link ?? item.url ?? item.canonicalUrl);
  const clipUrl = safeUrl(item.clip, PREVIEW_HOSTS.google);
  const thumb = safeUrl(item.thumbnailUrl ?? item.thumbnail, PREVIEW_HOSTS.google);
  if (!page) return null;
  return {
    externalId: clip(item.videoId, 64) || fnv(page),
    mediaType: "video",
    previewUrl: clipUrl || thumb,
    download: null, // DEC #11: Google video is discovery/preview only - never imported or rendered.
    previewOnlyReason: "google_video_discovery_only",
    durationSeconds: parseDuration(item.durationSeconds ?? item.duration),
    widthPx: null,
    heightPx: null,
    author: clip(item.channel ?? item.channelName ?? item.source, 100) || null,
    authorUrl: null,
    sourceUrl: page,
    text: clip(item.title, 500),
  };
}

const NORMALIZERS: Record<ApifyPlatform, (item: Json, options: NormalizeOptions) => Normalized | null> = {
  tiktok: normalizeTikTok,
  pinterest: normalizePinterest,
  x: normalizeX,
  google_image: normalizeGoogleImage,
  google_video: normalizeGoogleVideo,
};

// --- search ----------------------------------------------------------------------------------------------

export type ApifyCandidateResult = {
  candidate: MediaCandidate;
  download: ApifyDownloadPlan | null;
  /** VE2E-51: dataset quality signals (TikTok). */
  social?: SocialCandidateSignals;
  /** VE2E-51: search-only phase - page URL to download in phase 2 (`download` is null until then). */
  deferredPostUrl?: string;
};
export type ApifySearchOutcome = {
  results: ApifyCandidateResult[];
  actor: { actorId: string; version: string; role: "primary" | "backup" };
  runId: string;
  /** Set when the primary failed and the backup produced this result. */
  primaryError: { code: string; message: string } | null;
  /** VE2E-51: runs/seconds/USD of every attempt this call made (primary retries + backup). */
  usage: ApifyUsage;
  /** VE2E-51: the run hit TIMED-OUT but already had items, which were used. */
  timedOutWithItems?: boolean;
};

export type ApifyCandidateContext = { query: string; providerAccountId: string; fetchedAt?: string; deferDownload?: boolean };

/** Turns raw (untrusted) dataset items into MediaCandidates; unusable items are dropped, never patched up. */
export function normalizeApifyItems(
  platform: ApifyPlatform, items: unknown[], actor: { actorId: string; version: string; role: "primary" | "backup"; runId: string | null }, ctx: ApifyCandidateContext,
): ApifyCandidateResult[] {
  const fetchedAt = ctx.fetchedAt ?? new Date().toISOString();
  const seen = new Set<string>();
  const out: ApifyCandidateResult[] = [];
  items.slice(0, APIFY_MAX_RESULTS).forEach((raw, index) => {
    if (!isObj(raw)) return;
    let n: Normalized | null = null;
    try { n = NORMALIZERS[platform](raw, { deferDownload: ctx.deferDownload === true }); } catch { n = null; }
    if (!n) return;
    const candidateId = `apify:${platform}:${n.mediaType}:${n.externalId}`;
    if (seen.has(candidateId)) return;
    seen.add(candidateId);
    const importable = n.download !== null || Boolean(n.deferredPostUrl);
    const candidate: MediaCandidate = {
      candidateId,
      source: `apify:${platform}`,
      externalId: n.externalId,
      mediaType: n.mediaType,
      accessMethod: importable ? "api_download" : "discovery_only",
      previewUrl: n.previewUrl,
      embedUrl: null,
      importUrl: n.download?.url ?? null,
      durationSeconds: n.durationSeconds,
      widthPx: n.widthPx,
      heightPx: n.heightPx,
      attribution: { name: n.author ?? platform, profileUrl: n.authorUrl, sourcePageUrl: n.sourceUrl },
      provenance: {
        query: ctx.query,
        providerAccountId: ctx.providerAccountId,
        queriedAt: fetchedAt,
        catalogVersion: APIFY_ADAPTER_VERSION,
        apify: { platform, actorId: actor.actorId, actorVersion: actor.version, actorRole: actor.role, runId: actor.runId, datasetItemIndex: index, sourceUrl: n.sourceUrl, author: n.author, fetchedAt },
      },
      // DEC #1: owner accepted the social-media rights risk; explicitly NOT `cleared`.
      rightsStatus: "owner_accepted_risk",
      capabilityEvidence: null,
      metadataScore: 0,
      descriptorText: n.text || null,
      visionFindings: null,
      relevanceScore: 0,
      moderationDecision: null,
      eligibility: importable ? { autoEligible: true } : { autoEligible: false, reason: n.previewOnlyReason ?? "discovery_only_no_import_capability" },
    };
    out.push({ candidate, download: n.download, ...(n.social ? { social: n.social } : {}), ...(n.deferredPostUrl ? { deferredPostUrl: n.deferredPostUrl } : {}) });
  });
  return out;
}

const usable = (results: ApifyCandidateResult[]) => results.some((r) => r.download !== null || r.deferredPostUrl || r.candidate.previewUrl);

export type ApifySearchRunOptions = {
  /** TikTok primary only: `false` = search-only phase (no file downloads; candidates carry `deferredPostUrl`). Default `true`. */
  download?: boolean;
  /** Run timeout override (seconds). Default {@link APIFY_RUN_TIMEOUT_SECS}. */
  runTimeoutSecs?: number;
  /** Receives usage of EVERY run this call started, also when the call throws (VE2E-51 cost accounting). */
  usageSink?: ApifyUsage;
};

/**
 * Searches one platform through its pinned Actor. Primary first (with 1 retry); the pinned backup runs
 * only if the primary failed (not on auth/permission errors) or yielded nothing usable.
 */
export async function searchApify(token: string, input: ApifySearchInput & ApifySearchRunOptions & { providerAccountId: string }, deps?: ApifyDeps): Promise<ApifySearchOutcome> {
  if (!isApifyPlatform(input.platform)) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Unsupported Apify platform", false);
  const keyword = input.keyword.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!keyword) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Apify search needs a keyword", false);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 10), 1), APIFY_MAX_RESULTS);
  const pins = APIFY_ACTOR_ALLOWLIST[input.platform];
  const download = input.download !== false;
  const usage = input.usageSink ?? emptyApifyUsage();
  const ctx: ApifyCandidateContext = { query: keyword, providerAccountId: input.providerAccountId, deferDownload: !download };
  const runOptions: RunOptions = { timeoutSecs: input.runTimeoutSecs ?? APIFY_RUN_TIMEOUT_SECS, usage };

  const attempt = async (pin: ApifyActorPin, role: "primary" | "backup"): Promise<ApifySearchOutcome> => {
    const run = await runActorWithRetry(token, pin, buildActorInput(pin.actorId, keyword, input.lang, limit, { download }), limit, deps, runOptions);
    const results = normalizeApifyItems(input.platform, run.items, { ...pin, role, runId: run.runId }, ctx);
    return { results, actor: { ...pin, role }, runId: run.runId, primaryError: null, usage, ...(run.timedOutWithItems ? { timedOutWithItems: true } : {}) };
  };

  let primaryFailure: ProviderError | null = null;
  let primaryOutcome: ApifySearchOutcome | null = null;
  try {
    primaryOutcome = await attempt(pins.primary, "primary");
    if (usable(primaryOutcome.results) || !pins.backup) return primaryOutcome;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    // Same token: a bad/forbidden key would fail the backup identically.
    if (error.code === "PROVIDER_AUTH_INVALID" || error.code === "PROVIDER_CAPABILITY_UNAVAILABLE" || !pins.backup) throw error;
    primaryFailure = error;
  }
  const backup = await attempt(pins.backup!, "backup").catch((error) => { if (primaryFailure && !primaryOutcome) throw primaryFailure; throw error; });
  return { ...backup, primaryError: primaryFailure ? { code: primaryFailure.code, message: primaryFailure.message } : null };
}

// --- VE2E-51 phase 2: download ONE chosen TikTok post ---------------------------------------------------------

export type ApifyPostFetchInput = {
  /** Page URL of the chosen video (must be https on tiktok.com). */
  postUrl: string;
  /** Platform video id the result MUST contain (guards against an Actor that ignores the post-URL input). */
  expectedVideoId: string;
  lang: ApifyLang;
  providerAccountId: string;
  /** Input field carrying the URL list; default {@link APIFY_TIKTOK_POST_URL_FIELD}. */
  postUrlField?: string;
  runTimeoutSecs?: number;
  usageSink?: ApifyUsage;
};

/** Actor input for downloading exactly one post: the URL list, one result, download on. Exported for the handoff probe/tests. */
export function buildTikTokPostInput(postUrl: string | readonly string[], lang: ApifyLang, postUrlField: string = APIFY_TIKTOK_POST_URL_FIELD): Record<string, unknown> {
  return { [postUrlField]: typeof postUrl === "string" ? [postUrl] : [...postUrl], resultsPerPage: 1, proxyCountryCode: countryOf(lang), shouldDownloadVideos: true, shouldDownloadCovers: true, shouldDownloadSlideshowImages: false };
}

/**
 * Runs the pinned PRIMARY TikTok Actor for ONE post URL with download enabled and returns the importable candidate.
 * The `postURLs` input field of `clockworks/tiktok-scraper` is UNVERIFIED here, so the result is only accepted when it
 * holds an item with the expected video id AND a stored Key-Value-Store file; anything else throws
 * PROVIDER_SCHEMA_INVALID so the caller can fall back to the single-phase flow. No backup Actor (different input shape).
 */
export async function fetchApifyTikTokPost(token: string, input: ApifyPostFetchInput, deps?: ApifyDeps): Promise<ApifySearchOutcome> {
  const url = safeUrl(input.postUrl, ["tiktok.com"]);
  const expected = input.expectedVideoId.trim();
  if (!url || !expected) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Apify post fetch needs a tiktok.com URL and a video id", false);
  const pin = APIFY_ACTOR_ALLOWLIST.tiktok.primary;
  const usage = input.usageSink ?? emptyApifyUsage();
  const field = /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(input.postUrlField ?? "") ? input.postUrlField! : APIFY_TIKTOK_POST_URL_FIELD;
  const run = await runActorWithRetry(token, pin, buildTikTokPostInput(url, input.lang, field), 1, deps, { timeoutSecs: input.runTimeoutSecs ?? APIFY_DOWNLOAD_RUN_TIMEOUT_SECS, usage });
  const results = normalizeApifyItems("tiktok", run.items, { ...pin, role: "primary", runId: run.runId }, { query: url, providerAccountId: input.providerAccountId });
  const match = results.find((r) => r.candidate.externalId === expected && r.download !== null);
  if (!match) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Apify post fetch returned no stored file for the requested video", false);
  return { results: [match], actor: { ...pin, role: "primary" }, runId: run.runId, primaryError: null, usage, ...(run.timedOutWithItems ? { timedOutWithItems: true } : {}) };
}

// --- VE2E-132: ONE Actor run downloading N chosen posts -------------------------------------------------------

/** Max post URLs in one batch run (adapter ceiling; the service batches below this). */
export const APIFY_MAX_BATCH_POSTS = 20;

export type ApifyPostsFetchInput = {
  posts: ReadonlyArray<{ postUrl: string; expectedVideoId: string }>;
  lang: ApifyLang;
  providerAccountId: string;
  postUrlField?: string;
  runTimeoutSecs?: number;
  usageSink?: ApifyUsage;
};
export type ApifyPostFetchEntry = { ok: true; result: ApifyCandidateResult } | { ok: false; code: string; message: string };
export type ApifyPostsFetchOutcome = {
  /** One entry per requested video id: a missing/unstored id is an error of THAT id only. */
  byVideoId: Map<string, ApifyPostFetchEntry>;
  actor: { actorId: string; version: string; role: "primary" };
  runId: string;
  usage: ApifyUsage;
  timedOutWithItems?: boolean;
};

/**
 * VE2E-132: one pinned-Actor run with N `postURLs` (instead of N runs, saving N-1 Actor start-ups). Results are matched back by VIDEO ID
 * (the dataset order/size is not trusted). A requested id without a stored file gets an error entry; the other ids still succeed. Whole-run
 * failures (auth, run failed/timeout without items) throw like {@link fetchApifyTikTokPost}. Not probed against the real Actor yet: whether
 * `clockworks/tiktok-scraper` takes several postURLs and the field name (`APIFY_TIKTOK_POST_URL_FIELD`) need the owner-approved probe.
 */
export async function fetchApifyTikTokPosts(token: string, input: ApifyPostsFetchInput, deps?: ApifyDeps): Promise<ApifyPostsFetchOutcome> {
  const wanted = new Map<string, string>();
  const byVideoId = new Map<string, ApifyPostFetchEntry>();
  for (const post of input.posts) {
    const id = post.expectedVideoId.trim();
    const url = safeUrl(post.postUrl, ["tiktok.com"]);
    if (!id) continue;
    if (!url) { byVideoId.set(id, { ok: false, code: "PROVIDER_SCHEMA_INVALID", message: "not a tiktok.com URL" }); continue; }
    if (!wanted.has(id)) wanted.set(id, url);
  }
  if (wanted.size > APIFY_MAX_BATCH_POSTS) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `Apify batch holds at most ${APIFY_MAX_BATCH_POSTS} posts`, false);
  const pin = APIFY_ACTOR_ALLOWLIST.tiktok.primary;
  const usage = input.usageSink ?? emptyApifyUsage();
  if (wanted.size === 0) {
    if (input.posts.length === 0 || byVideoId.size === 0) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Apify batch fetch needs tiktok.com URLs and video ids", false);
    return { byVideoId, actor: { ...pin, role: "primary" }, runId: "", usage };
  }
  const field = /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(input.postUrlField ?? "") ? input.postUrlField! : APIFY_TIKTOK_POST_URL_FIELD;
  const run = await runActorWithRetry(token, pin, buildTikTokPostInput([...wanted.values()], input.lang, field), wanted.size, deps, { timeoutSecs: input.runTimeoutSecs ?? APIFY_DOWNLOAD_RUN_TIMEOUT_SECS, usage });
  const results = normalizeApifyItems("tiktok", run.items, { ...pin, role: "primary", runId: run.runId }, { query: [...wanted.values()][0]!, providerAccountId: input.providerAccountId });
  for (const id of wanted.keys()) {
    const match = results.find((r) => r.candidate.externalId === id && r.download !== null);
    byVideoId.set(id, match ? { ok: true, result: match } : { ok: false, code: "PROVIDER_SCHEMA_INVALID", message: "Apify batch returned no stored file for this video" });
  }
  return { byVideoId, actor: { ...pin, role: "primary" }, runId: run.runId, usage, ...(run.timedOutWithItems ? { timedOutWithItems: true } : {}) };
}
