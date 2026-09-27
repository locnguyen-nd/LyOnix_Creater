/**
 * VE2E-15b: YouTube Data API v3 adapter - discovery + compliant embed only, never a download/
 * import path. Verified against the public, stable YouTube Data API v3 REST surface
 * (`search.list`, `videos.list`) - see VE2E-PROVIDER-UX.md §7 for the cited developer docs this
 * was built against (checked 2026-09-25 by Plan): `videoDuration=short` means under four
 * minutes, not a dedicated Shorts/under-60-second filter, and API access is not permission to
 * extract audiovisual bytes - LyOnix must keep playback in the compliant embed experience.
 *
 * `accessMethod` is always `"api_embed"`/`"discovery_only"` here and `importUrl` is always
 * `null` - this file has no download/binary-fetch path at all (unlike `pexels.ts`), by design:
 * a source that can only discover/embed content must never become an asset importer by
 * implication (VE2E-15b hard rule). Every candidate is also marked
 * `eligibility.autoEligible: false` because the current render pipeline (Creatomate
 * photo/video-file slots) has no embed-source assignment path yet - Studio can still show/browse
 * these candidates for human reference, but Auto can never apply one.
 */
import { validateSourceUrl, type MediaCandidate } from "@lyonix/domain";
import { ProviderError } from "./index.js";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const timeoutMs = 30_000;

const redact = (value: string) => value.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 220);

const fail = (status: number, retryAfter: string | null, body: Record<string, unknown>): never => {
  const error = (body.error ?? {}) as Record<string, unknown>;
  const message = typeof error.message === "string" ? error.message : "";
  const suffix = message ? `: ${redact(message)}` : "";
  const quota = /quota/i.test(message);
  if (status === 401) throw new ProviderError("PROVIDER_AUTH_INVALID", `YouTube authentication failed${suffix}`, false);
  if (status === 403 && quota) throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED", `YouTube API quota exhausted${suffix}`, false);
  if (status === 403) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `YouTube API key does not permit this request${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `YouTube rate limit reached${suffix}`, true, Number(retryAfter ?? 0) * 1000 || undefined);
  if (status === 400) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `YouTube rejected the request${suffix}`, false);
  if (status === 404) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `YouTube resource not found${suffix}`, false);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `YouTube request failed (${status})${suffix}`, status >= 500);
};

const timedFetch = (path: string): Promise<Response> => fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });

async function call(path: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await timedFetch(path);
  } catch {
    throw new ProviderError("PROVIDER_TIMEOUT", "YouTube request timed out or network failed", true);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) fail(response.status, response.headers.get("retry-after"), body);
  return body;
}

// --- account preflight ---

/**
 * Cheapest real call that proves the API key works: `videos.list?chart=mostPopular` costs 1
 * quota unit versus 100 for `search.list` (YouTube Data API quota costs are part of the public
 * docs), same "real-endpoint, minimal cost" principle as `probePexelsAccount`/
 * `probeCreatomateAccount`. YouTube has no dedicated "who am I" endpoint for a plain API key.
 */
export async function probeYouTubeAccount(apiKey: string): Promise<{ verifiedAt: string }> {
  await call(`/videos?part=id&chart=mostPopular&maxResults=1&key=${encodeURIComponent(apiKey)}`);
  return { verifiedAt: new Date().toISOString() };
}

// --- search (discovery only) ---

export type YouTubeVideoResult = {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string;
};

export type YouTubeSearchOptions = {
  maxResults?: number;
  /** YouTube's own `videoDuration` filter - `"short"` means under 4 minutes, NOT a Shorts-only guarantee (spec §7). Passed through verbatim, never presented to a caller as a Shorts filter. */
  videoDuration?: "any" | "short" | "medium" | "long";
  regionCode?: string;
};

const toVideoResult = (row: Record<string, unknown>): YouTubeVideoResult | null => {
  const id = row.id as Record<string, unknown> | undefined;
  const videoId = typeof id?.videoId === "string" ? id.videoId : "";
  if (!videoId) return null;
  const snippet = (row.snippet ?? {}) as Record<string, unknown>;
  const thumbnails = (snippet.thumbnails ?? {}) as Record<string, unknown>;
  const best = (thumbnails.high ?? thumbnails.medium ?? thumbnails.default ?? {}) as Record<string, unknown>;
  return {
    videoId,
    title: typeof snippet.title === "string" ? snippet.title : "",
    description: typeof snippet.description === "string" ? snippet.description : "",
    channelTitle: typeof snippet.channelTitle === "string" ? snippet.channelTitle : "",
    publishedAt: typeof snippet.publishedAt === "string" ? snippet.publishedAt : "",
    thumbnailUrl: typeof best.url === "string" ? best.url : "",
  };
};

/** `search.list` discovery only - never resolves/returns a downloadable media URL (YouTube provides none for third-party use). */
export async function searchYouTubeVideos(apiKey: string, query: string, options: YouTubeSearchOptions = {}): Promise<YouTubeVideoResult[]> {
  const maxResults = Math.min(Math.max(options.maxResults ?? 10, 1), 25);
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    safeSearch: "strict",
    q: query,
    maxResults: String(maxResults),
    key: apiKey,
  });
  if (options.videoDuration && options.videoDuration !== "any") params.set("videoDuration", options.videoDuration);
  if (options.regionCode) params.set("regionCode", options.regionCode);
  const body = await call(`/search?${params.toString()}`);
  const items = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
  return items.map(toVideoResult).filter((v): v is YouTubeVideoResult => v !== null);
}

const YOUTUBE_WATCH_SUFFIXES = [".youtube.com", ".youtube.com.", ".ytimg.com", ".ytimg.com."];

/** Same defense-in-depth allowlist layer as `isPexelsCdnUrl` - only relevant here for thumbnail/embed URLs, since this adapter never downloads a binary. */
export const isYouTubeUrl = (raw: string): boolean => {
  const check = validateSourceUrl(raw);
  if (!check.ok) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return YOUTUBE_WATCH_SUFFIXES.some((suffix) => host.endsWith(suffix)) || host === "youtube.com" || host === "youtu.be";
};

// --- VE2E-15a: normalized MediaCandidate mapping ---

export type YouTubeCandidateContext = { query: string; providerAccountId: string; queriedAt?: string; catalogVersion?: string };

const clipDescription = (title: string, description: string) => `${title} ${description}`.trim().slice(0, 500);

/**
 * `rightsStatus: "unclear"` (not `"cleared"`) - unlike Pexels there is no blanket license here;
 * usability terms are per-video/per-channel. `eligibility.autoEligible` is always `false`: even
 * once rights were confirmed for a specific video, this codebase's render pipeline has no
 * embed-source assignment path today (Creatomate slots expect an owned media file), so Auto can
 * never apply a YouTube candidate regardless of rights - Studio can still list it for a human to
 * evaluate/reference.
 */
export function youtubeVideoToMediaCandidate(video: YouTubeVideoResult, ctx: YouTubeCandidateContext): MediaCandidate {
  return {
    candidateId: `youtube:video:${video.videoId}`,
    source: "youtube",
    externalId: video.videoId,
    mediaType: "video",
    accessMethod: "api_embed",
    previewUrl: video.thumbnailUrl,
    embedUrl: `https://www.youtube.com/embed/${video.videoId}`,
    importUrl: null,
    durationSeconds: null, // search.list does not return duration; a second videos.list(part=contentDetails) call would add quota cost with no import capability gained, so it is intentionally not fetched here.
    widthPx: null,
    heightPx: null,
    attribution: { name: video.channelTitle || "YouTube", sourcePageUrl: `https://www.youtube.com/watch?v=${video.videoId}` },
    provenance: { query: ctx.query, providerAccountId: ctx.providerAccountId, queriedAt: ctx.queriedAt ?? new Date().toISOString(), ...(ctx.catalogVersion ? { catalogVersion: ctx.catalogVersion } : {}) },
    rightsStatus: "unclear",
    capabilityEvidence: null,
    metadataScore: 0,
    descriptorText: clipDescription(video.title, video.description) || null,
    visionFindings: null,
    relevanceScore: 0,
    moderationDecision: null,
    eligibility: { autoEligible: false, reason: "discovery_and_embed_only_no_import_capability" },
  };
}
