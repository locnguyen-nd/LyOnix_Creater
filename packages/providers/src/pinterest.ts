/**
 * VE2E-15b: real Pinterest API v5 partner-search adapter - discovery + manual-import candidate
 * source, never Auto-eligible (see rights note below). This replaces the earlier documented
 * "blocked" stub: that stub was correct to refuse guessing an unverified endpoint from
 * training-data memory alone (per this task's explicit instruction), and this file is only safe
 * to write now because a live docs re-check happened first, outside this Code session, and an
 * approved Pinterest partner-search app/token has been separately confirmed by the project owner.
 * Facts below are cited from that live re-check, not re-derived from memory - see
 * VE2E-PROVIDER-UX.md §7 for the previously-cited getting-started reference and the
 * pipeline/state.json VE2E-15b handoff note for the exact re-check context.
 *
 * Confirmed endpoint: `GET https://api.pinterest.com/v5/search/partner/pins` - required query
 * params `term` (search phrase) and `country_code` (e.g. "US"); optional `bookmark`
 * (pagination cursor), `locale`, `limit`. Auth is a standard `Authorization: Bearer <token>`
 * header, same shape as every other adapter here. The response is documented as "the top 10
 * pins matching a given search term across Pinterest's partner network" - Pinterest itself may
 * cap real results near 10 regardless of `limit`; that is a real provider-side ceiling, not a
 * bug in this file.
 *
 * Deliberately NOT used: `GET /v5/search/pins` (no `/partner/`) - that endpoint only searches
 * pins already saved to the authenticated account's own boards, which answers a different
 * question (browsing this LyOnix account's saves) than what this adapter needs (finding
 * candidate stock-appropriate media for a scene). If `search/partner/pins` ever returns a
 * permission-denied response for a real account at runtime, this file must surface that error
 * as-is (`PROVIDER_CAPABILITY_UNAVAILABLE`/`PROVIDER_AUTH_INVALID`, see `fail()` below) and must
 * never silently fall back to `search/pins` and treat its results as equivalent - do not "fix"
 * that here without a deliberate, documented product decision, because the two endpoints answer
 * different questions.
 *
 * Pin object fields (`id`, `created_at`, `link`, `title`, `description`, `alt_text`,
 * `dominant_color`, `board_id`, `creative_type`) are confirmed against Pinterest's general Pin
 * resource docs. The nested `media` shape (`media_type`, `images.<bucket>.{url,width,height}`,
 * optional `video_url`) is confirmed only against that general Pin resource doc, NOT
 * independently re-confirmed against a live `search/partner/pins` response body specifically -
 * `toPinterestPinResult` below parses it entirely defensively (optional chaining, tolerant of a
 * missing/different bucket key or missing `video_url`) so a shape mismatch degrades to a
 * candidate with empty preview/import fields instead of a crash or fabricated data. Likewise the
 * list envelope (`items`/`bookmark`) follows Pinterest v5's general list-endpoint convention used
 * across the rest of the v5 API, not a partner-search-specific confirmation. Both are flagged in
 * the VE2E-15b handoff as needing a one-time live spot-check once the owner verifies a real
 * account - this Code session has no token and must not make that call itself.
 *
 * No dedicated "who am I" endpoint (e.g. a `/v5/user_account`-style probe) was part of the
 * confirmed fact set this file is grounded in, so `probePinterestAccount` does not call one -
 * asserting such an endpoint exists from training-data memory alone would repeat exactly the
 * mistake the original stub correctly refused to make. Instead the preflight reuses the one
 * confirmed-real endpoint (`search/partner/pins`) with the smallest possible request
 * (`limit=1`), which additionally proves partner-search *scope* access, not just a valid token -
 * a plain "who am I" call could not tell those apart.
 */
import { type MediaCandidate } from "@lyonix/domain";
import { ProviderError } from "./index.js";

const API_BASE = "https://api.pinterest.com";
const timeoutMs = 30_000;

/** Redacts anything that looks like a Pinterest token/id if it leaks into an error body. */
const redact = (value: string) => value.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 220);

const fail = (status: number, retryAfter: string | null, body: Record<string, unknown>): never => {
  const message = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "";
  const suffix = message ? `: ${redact(message)}` : "";
  if (status === 401) throw new ProviderError("PROVIDER_AUTH_INVALID", `Pinterest authentication failed${suffix}`, false);
  // Partner-search access is a separate approval track from general app approval (spec §7) - a
  // 403 here means the token is valid but lacks that scope, never treated as "no results".
  if (status === 403) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Pinterest account/token does not have partner search access${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `Pinterest rate limit reached${suffix}`, true, Number(retryAfter ?? 0) * 1000 || undefined);
  if (status === 400 || status === 422) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `Pinterest rejected the request${suffix}`, false);
  if (status === 404) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Pinterest resource not found${suffix}`, false);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `Pinterest request failed (${status})${suffix}`, status >= 500);
};

const timedFetch = (path: string, accessToken: string): Promise<Response> =>
  fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs) });

async function call(path: string, accessToken: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await timedFetch(path, accessToken);
  } catch {
    throw new ProviderError("PROVIDER_TIMEOUT", "Pinterest request timed out or network failed", true);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) fail(response.status, response.headers.get("retry-after"), body);
  return body;
}

// --- account preflight ---

/**
 * Cheapest CONFIRMED-real call available (see module doc for why this does not call an assumed
 * "who am I" endpoint): a minimal `search/partner/pins` request (`limit=1`, a fixed low-signal
 * term) that proves both a valid token AND partner-search scope access in one call.
 */
export async function probePinterestAccount(accessToken: string): Promise<{ verifiedAt: string }> {
  const params = new URLSearchParams({ term: "lyonix-probe", country_code: "US", limit: "1" });
  await call(`/v5/search/partner/pins?${params.toString()}`, accessToken);
  return { verifiedAt: new Date().toISOString() };
}

// --- search (discovery + manual-import candidate) ---

export type PinterestMediaType = "image" | "video" | "multiple_images" | "unknown";

export type PinterestPinResult = {
  externalId: string;
  createdAt: string;
  link: string;
  title: string;
  description: string;
  altText: string;
  dominantColor: string;
  boardId: string;
  creativeType: string;
  mediaType: PinterestMediaType;
  previewUrl: string;
  widthPx: number | null;
  heightPx: number | null;
  /** Best-effort direct asset URL (`media.video_url` for video pins, largest `media.images` bucket otherwise) - `null` when the (defensively-parsed) response has neither. */
  downloadUrl: string | null;
};

export type PinterestSearchOptions = {
  bookmark?: string;
  locale?: string;
  /** Pinterest documents `search/partner/pins` as returning "the top 10 pins" regardless of this value - treated as a real provider-side ceiling, not enforced client-side beyond the 1..25 clamp already used by every other adapter's `perPage`/`maxResults`. */
  limit?: number;
};

type RawImageBucket = { url: string; width: number; height: number };

const pickBestImage = (images: unknown): RawImageBucket | null => {
  if (!images || typeof images !== "object") return null;
  const buckets = Object.values(images as Record<string, unknown>).filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object");
  const parsed = buckets
    .map((b): RawImageBucket => ({ url: typeof b.url === "string" ? b.url : "", width: Number(b.width ?? 0), height: Number(b.height ?? 0) }))
    .filter((b) => b.url);
  if (parsed.length === 0) return null;
  return [...parsed].sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
};

const toPinterestMediaType = (raw: unknown): PinterestMediaType =>
  raw === "image" || raw === "video" || raw === "multiple_images" ? raw : "unknown";

const toPinterestPinResult = (row: Record<string, unknown>): PinterestPinResult => {
  // `media` shape is parsed defensively throughout (see module doc): a missing/differently-keyed
  // field degrades to empty preview/import data on this one candidate, never a thrown error.
  const media = (row.media ?? {}) as Record<string, unknown>;
  const mediaType = toPinterestMediaType(media.media_type);
  const bestImage = pickBestImage(media.images);
  const videoUrl = typeof media.video_url === "string" ? media.video_url : null;
  return {
    externalId: String(row.id ?? ""),
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    link: typeof row.link === "string" ? row.link : "",
    title: typeof row.title === "string" ? row.title : "",
    description: typeof row.description === "string" ? row.description : "",
    altText: typeof row.alt_text === "string" ? row.alt_text : "",
    dominantColor: typeof row.dominant_color === "string" ? row.dominant_color : "",
    boardId: typeof row.board_id === "string" ? row.board_id : "",
    creativeType: typeof row.creative_type === "string" ? row.creative_type : "",
    mediaType,
    previewUrl: bestImage?.url ?? "",
    widthPx: bestImage?.width ?? null,
    heightPx: bestImage?.height ?? null,
    downloadUrl: mediaType === "video" ? videoUrl : (bestImage?.url ?? null),
  };
};

/**
 * `GET /v5/search/partner/pins` - see module doc for why this is the only search path used here
 * (never `/v5/search/pins`). Results with no pin id are dropped (same defensive contract as
 * `searchYouTubeVideos` dropping items with no `videoId`).
 */
export async function searchPinterestPins(accessToken: string, term: string, countryCode: string, options: PinterestSearchOptions = {}): Promise<PinterestPinResult[]> {
  const params = new URLSearchParams({ term, country_code: countryCode });
  if (options.bookmark) params.set("bookmark", options.bookmark);
  if (options.locale) params.set("locale", options.locale);
  if (options.limit) params.set("limit", String(Math.min(Math.max(options.limit, 1), 25)));
  const body = await call(`/v5/search/partner/pins?${params.toString()}`, accessToken);
  const items = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
  return items.map(toPinterestPinResult).filter((p) => p.externalId);
}

// --- VE2E-15a: normalized MediaCandidate mapping ---

export type PinterestCandidateContext = { query: string; providerAccountId: string; queriedAt?: string; catalogVersion?: string };

const clipDescription = (title: string, description: string, altText: string) =>
  [title, description, altText].filter((part) => part.trim()).join(" ").trim().slice(0, 500);

/**
 * Unlike `pexelsPhotoToMediaCandidate` (blanket Pexels License) or even
 * `youtubeVideoToMediaCandidate` (per-video terms, but at least a known uploader/channel),
 * Pinterest pins carry NO reliable licensing signal in the API response at all - a pin is
 * typically content a Pinterest user saved/reposted from an arbitrary external site, and
 * nothing in this response proves who actually holds rights to it. Per
 * VE2E-PROVIDER-UX.md §5/§6 (B12): `rightsStatus` is always `"unclear"` and
 * `eligibility.autoEligible` is always `false` with reason `"rights_unresolved"` - the same
 * machine-readable reason `apps/api/src/pexels.service.ts#abstentionOutcome` already handles for
 * VE2E-15a's `needs_input` routing, reused here rather than inventing a second path. Candidates
 * are still returned (not filtered out) so a human curator can review/manually import one in
 * Studio and accept the rights ambiguity themselves - that manual Studio action is a documented
 * follow-up (see VE2E-15b handoff notes), not built in this pass. `accessMethod` reflects
 * technical capability only (whether a direct asset URL was actually parsed out of this
 * response), independent of the separate rights gate above.
 */
export function pinterestPinToMediaCandidate(pin: PinterestPinResult, ctx: PinterestCandidateContext): MediaCandidate {
  const mediaType = pin.mediaType === "video" ? "video" as const : "photo" as const;
  return {
    candidateId: `pinterest:${mediaType}:${pin.externalId}`,
    source: "pinterest",
    externalId: pin.externalId,
    mediaType,
    accessMethod: pin.downloadUrl ? "api_download" : "discovery_only",
    previewUrl: pin.previewUrl,
    importUrl: pin.downloadUrl,
    durationSeconds: null, // not present on the confirmed Pin resource fields this adapter parses
    widthPx: pin.widthPx,
    heightPx: pin.heightPx,
    attribution: { name: "Pinterest", profileUrl: null, sourcePageUrl: pin.link || null },
    provenance: { query: ctx.query, providerAccountId: ctx.providerAccountId, queriedAt: ctx.queriedAt ?? new Date().toISOString(), ...(ctx.catalogVersion ? { catalogVersion: ctx.catalogVersion } : {}) },
    rightsStatus: "unclear",
    capabilityEvidence: null,
    metadataScore: 0,
    descriptorText: clipDescription(pin.title, pin.description, pin.altText) || null,
    visionFindings: null,
    relevanceScore: 0,
    moderationDecision: null,
    eligibility: { autoEligible: false, reason: "rights_unresolved" },
  };
}
