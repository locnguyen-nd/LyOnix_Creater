/**
 * VE2E-04: real Pexels adapter — portrait photo/video search, attribution-carrying
 * results (Pexels license requires crediting the photographer and linking back to
 * Pexels), and a domain-locked safe binary download used only after the caller
 * chose one specific search result to import. No fake/local fallback: every
 * function here makes a real HTTP call and normalizes failures to `ProviderError`.
 * Tests inject `fetch` via `vi.stubGlobal` (same pattern as `elevenlabs.ts`).
 */
import { validateSourceUrl, type MediaCandidate } from "@lyonix/domain";
import { ProviderError } from "./index.js";

const API_BASE = "https://api.pexels.com";
const timeoutMs = 30_000;

/** Redacts anything that looks like a Pexels API key if it leaks into an error body. */
const redact = (value: string) => value.replace(/[A-Za-z0-9]{20,}/g, "[redacted]").slice(0, 220);

const fail = (status: number, retryAfter: string | null, body: Record<string, unknown>): never => {
  const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "";
  const suffix = message ? `: ${redact(message)}` : "";
  if (status === 401) throw new ProviderError("PROVIDER_AUTH_INVALID", `Pexels authentication failed${suffix}`, false);
  if (status === 403) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Pexels account/key does not permit this request${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `Pexels rate limit reached${suffix}`, true, Number(retryAfter ?? 0) * 1000 || undefined);
  if (status === 404) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Pexels photo/video not found${suffix}`, false);
  if (status === 400 || status === 422) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `Pexels rejected the request${suffix}`, false);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `Pexels request failed (${status})${suffix}`, status >= 500);
};

const timedFetch = (path: string, apiKey: string, base = API_BASE): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { Authorization: apiKey }, signal: AbortSignal.timeout(timeoutMs) });

async function call(path: string, apiKey: string, base = API_BASE): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await timedFetch(path, apiKey, base);
  } catch {
    throw new ProviderError("PROVIDER_TIMEOUT", "Pexels request timed out or network failed", true);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) fail(response.status, response.headers.get("retry-after"), body);
  return body;
}

// --- account preflight ---

/**
 * Lightweight, cheap preflight (`GET /v1/curated?per_page=1`) — Pexels has no
 * dedicated "who am I" endpoint, so a minimal curated-list call is the cheapest
 * real call that proves the key works, same "operation-specific, real endpoint"
 * principle as `probeElevenLabsAccount`/`probeContentModel`.
 */
export async function probePexelsAccount(apiKey: string): Promise<{ verifiedAt: string }> {
  await call("/v1/curated?per_page=1", apiKey);
  return { verifiedAt: new Date().toISOString() };
}

// --- search ---

export type PexelsAttribution = { photographerName: string; photographerUrl: string; pexelsPageUrl: string };
export type PexelsPhotoResult = {
  externalId: string;
  width: number;
  height: number;
  attribution: PexelsAttribution;
  thumbnailUrl: string;
  previewUrl: string;
  downloadUrl: string;
  /** Pexels' own photographer-authored alt text, when present - the only descriptive text signal this provider exposes (its video search endpoint has none). Used for VE2E-15a metadata-only semantic ranking. */
  altText: string;
};
export type PexelsVideoFileOption = { quality: string; width: number; height: number; fileType: string; link: string };
export type PexelsVideoResult = {
  externalId: string;
  width: number;
  height: number;
  durationSeconds: number;
  attribution: PexelsAttribution;
  thumbnailUrl: string;
  fileOptions: PexelsVideoFileOption[];
};

const toAttribution = (name: unknown, url: unknown, pageUrl: unknown): PexelsAttribution => ({
  photographerName: typeof name === "string" ? name : "",
  photographerUrl: typeof url === "string" ? url : "",
  pexelsPageUrl: typeof pageUrl === "string" ? pageUrl : "",
});

const toPhotoResult = (row: Record<string, unknown>): PexelsPhotoResult => {
  const src = (row.src ?? {}) as Record<string, unknown>;
  return {
    externalId: String(row.id ?? ""),
    width: Number(row.width ?? 0),
    height: Number(row.height ?? 0),
    attribution: toAttribution(row.photographer, row.photographer_url, row.url),
    thumbnailUrl: typeof src.small === "string" ? src.small : "",
    previewUrl: typeof src.large === "string" ? src.large : typeof src.medium === "string" ? src.medium : "",
    downloadUrl: typeof src.original === "string" ? src.original : "",
    altText: typeof row.alt === "string" ? row.alt : "",
  };
};

const toVideoFileOption = (row: Record<string, unknown>): PexelsVideoFileOption => ({
  quality: typeof row.quality === "string" ? row.quality : "",
  width: Number(row.width ?? 0),
  height: Number(row.height ?? 0),
  fileType: typeof row.file_type === "string" ? row.file_type : "",
  link: typeof row.link === "string" ? row.link : "",
});

const toVideoResult = (row: Record<string, unknown>): PexelsVideoResult => {
  const user = (row.user ?? {}) as Record<string, unknown>;
  const files = Array.isArray(row.video_files) ? (row.video_files as Array<Record<string, unknown>>).map(toVideoFileOption) : [];
  const pictures = Array.isArray(row.video_pictures) ? (row.video_pictures as Array<Record<string, unknown>>) : [];
  return {
    externalId: String(row.id ?? ""),
    width: Number(row.width ?? 0),
    height: Number(row.height ?? 0),
    durationSeconds: Number(row.duration ?? 0),
    attribution: toAttribution(user.name, user.url, row.url),
    thumbnailUrl: typeof pictures[0]?.picture === "string" ? (pictures[0]!.picture as string) : "",
    fileOptions: files.filter((f) => f.link),
  };
};

export type PexelsSearchOptions = { page?: number; perPage?: number };

/** Portrait photo search (`GET /v1/search`) — orientation is fixed to portrait, matching 9:16 short video. */
export async function searchPexelsPhotos(apiKey: string, query: string, options: PexelsSearchOptions = {}): Promise<PexelsPhotoResult[]> {
  const page = options.page ?? 1;
  const perPage = Math.min(Math.max(options.perPage ?? 15, 1), 80);
  const body = await call(`/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&page=${page}&per_page=${perPage}`, apiKey);
  const photos = Array.isArray(body.photos) ? (body.photos as Array<Record<string, unknown>>) : [];
  return photos.map(toPhotoResult);
}

/** Portrait video search (`GET /videos/search`) — same orientation constraint. */
export async function searchPexelsVideos(apiKey: string, query: string, options: PexelsSearchOptions = {}): Promise<PexelsVideoResult[]> {
  const page = options.page ?? 1;
  const perPage = Math.min(Math.max(options.perPage ?? 15, 1), 80);
  const body = await call(`/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&page=${page}&per_page=${perPage}`, apiKey, "https://api.pexels.com");
  const videos = Array.isArray(body.videos) ? (body.videos as Array<Record<string, unknown>>) : [];
  return videos.map(toVideoResult);
}

/** Re-fetch a single photo by id — used before import so the download URL/attribution always comes from Pexels, never a client-supplied value. */
export async function getPexelsPhoto(apiKey: string, id: string): Promise<PexelsPhotoResult> {
  const body = await call(`/v1/photos/${encodeURIComponent(id)}`, apiKey);
  return toPhotoResult(body);
}

/** Re-fetch a single video by id — same "never trust a client URL" reasoning as `getPexelsPhoto`. */
export async function getPexelsVideo(apiKey: string, id: string): Promise<PexelsVideoResult> {
  const body = await call(`/videos/videos/${encodeURIComponent(id)}`, apiKey);
  return toVideoResult(body);
}

/**
 * Pick a video file variant sized for a 1080x1920 short video (VE2E-37, CR-JP-ONESHOT-MEDIA §3):
 * prefers `video/mp4`, the smallest option whose SHORT side (min of width/height, so portrait and
 * landscape are treated alike) is at least 1080px, falling back to the largest available so a
 * too-small source is never silently rejected. Never grabs a 1440p/4K file when a 1080p variant
 * exists: media-worker then cuts it (usually by stream copy) instead of shipping a heavy download.
 */
export const PEXELS_MIN_SHORT_SIDE_PX = 1080;

export const pickPexelsVideoFile = (files: readonly PexelsVideoFileOption[]): PexelsVideoFileOption | null => {
  const mp4 = files.filter((f) => f.fileType === "video/mp4" && f.link && f.width > 0 && f.height > 0);
  if (mp4.length === 0) return null;
  const sorted = [...mp4].sort((a, b) => a.width * a.height - b.width * b.height);
  return sorted.find((f) => Math.min(f.width, f.height) >= PEXELS_MIN_SHORT_SIDE_PX) ?? sorted[sorted.length - 1]!;
};

// --- VE2E-15a: normalized MediaCandidate mapping ---

export type PexelsCandidateContext = { query: string; providerAccountId: string; queriedAt?: string; catalogVersion?: string };

const pexelsAttributionToMedia = (a: PexelsAttribution) => ({
  name: a.photographerName || "Pexels",
  profileUrl: a.photographerUrl || null,
  sourcePageUrl: a.pexelsPageUrl || null,
});

/**
 * Pexels License (https://www.pexels.com/license/) grants free use with attribution for every
 * returned photo/video - `rightsStatus: "cleared"` reflects existing product behavior already
 * relied on by `PexelsService.import`, not a new claim made here.
 */
export function pexelsPhotoToMediaCandidate(photo: PexelsPhotoResult, ctx: PexelsCandidateContext): MediaCandidate {
  return {
    candidateId: `pexels:photo:${photo.externalId}`,
    source: "pexels",
    externalId: photo.externalId,
    mediaType: "photo",
    accessMethod: "api_download",
    previewUrl: photo.previewUrl || photo.thumbnailUrl,
    importUrl: photo.downloadUrl || null,
    durationSeconds: null,
    widthPx: photo.width || null,
    heightPx: photo.height || null,
    attribution: pexelsAttributionToMedia(photo.attribution),
    provenance: { query: ctx.query, providerAccountId: ctx.providerAccountId, queriedAt: ctx.queriedAt ?? new Date().toISOString(), ...(ctx.catalogVersion ? { catalogVersion: ctx.catalogVersion } : {}) },
    rightsStatus: "cleared",
    capabilityEvidence: null,
    metadataScore: 0,
    descriptorText: photo.altText || null,
    visionFindings: null,
    relevanceScore: 0,
    moderationDecision: null,
    eligibility: photo.downloadUrl ? { autoEligible: true } : { autoEligible: false, reason: "missing_download_url" },
  };
}

/** Same rights reasoning as `pexelsPhotoToMediaCandidate`. Pexels' video search endpoint returns no alt/description/tags field, so `descriptorText` stays `null` (no fabricated signal). */
export function pexelsVideoToMediaCandidate(video: PexelsVideoResult, ctx: PexelsCandidateContext): MediaCandidate {
  const file = pickPexelsVideoFile(video.fileOptions);
  return {
    candidateId: `pexels:video:${video.externalId}`,
    source: "pexels",
    externalId: video.externalId,
    mediaType: "video",
    accessMethod: "api_download",
    previewUrl: video.thumbnailUrl,
    importUrl: file?.link ?? null,
    durationSeconds: video.durationSeconds || null,
    widthPx: file?.width || video.width || null,
    heightPx: file?.height || video.height || null,
    attribution: pexelsAttributionToMedia(video.attribution),
    provenance: { query: ctx.query, providerAccountId: ctx.providerAccountId, queriedAt: ctx.queriedAt ?? new Date().toISOString(), ...(ctx.catalogVersion ? { catalogVersion: ctx.catalogVersion } : {}) },
    rightsStatus: "cleared",
    capabilityEvidence: null,
    metadataScore: 0,
    descriptorText: null,
    visionFindings: null,
    relevanceScore: 0,
    moderationDecision: null,
    eligibility: file ? { autoEligible: true } : { autoEligible: false, reason: "no_compatible_video_file" },
  };
}

// --- safe download ---

const PEXELS_CDN_SUFFIXES = [".pexels.com", ".pexels.com."];

/** Extra, provider-specific domain allowlist layer on top of the generic `validateSourceUrl` SSRF guard — Pexels CDN links are expected to always resolve under `*.pexels.com`. */
export const isPexelsCdnUrl = (raw: string): boolean => {
  const check = validateSourceUrl(raw);
  if (!check.ok) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return PEXELS_CDN_SUFFIXES.some((suffix) => host.endsWith(suffix));
};
