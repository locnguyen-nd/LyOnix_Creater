/**
 * VE2E-135 (CR-MEDIA-SLA-2026-10-07 3.1 L0 / 3.5): pure logic of the prepared media library.
 *
 * - `LibraryTags`: the tags written on a clip when it is imported (stored in `MediaAssetVersion.provenance.library`;
 *   no new table). Tags are plain keyword/subject strings - no embeddings (an embedding score can be added later next to
 *   `scoreLibraryMatch` without changing the callers).
 * - `scoreLibraryMatch`: keyword/subject match 0..1 between a segment query and a clip's tags.
 * - `usedInWindow` / `blockedByRepeatWindow`: a clip is not reused within 7 days or the last 20 videos of the same channel.
 *   Identity today = external id + sha256 checksum (+ author as a soft penalty). Perceptual hashing (VE2E-91) plugs in through
 *   `RepeatGuard` (a reposted clip with a different checksum is NOT caught until VE2E-91 registers its guard).
 */
export const LIBRARY_TAGS_VERSION = 1;
export const LIBRARY_REPEAT_DAYS_DEFAULT = 7;
export const LIBRARY_REPEAT_VIDEOS_DEFAULT = 20;
export const LIBRARY_MIN_SCORE_DEFAULT = 0.6;

export type LibraryUsage = { jobKey: string; at: string };

export type LibraryTags = {
  v: number;
  ja: string[];
  en: string[];
  broad: string[];
  subject: string | null;
  aliases: string[];
  caption: string | null;
  hashtags: string[];
  source: string | null;
  author: string | null;
  externalId: string | null;
  addedAt: string;
  /** How the clip entered the library: normal job sourcing, or the background prefetch (counts against the daily caps). */
  via: "plan" | "prefetch";
  /** Apify cost attributed to this clip (prefetch only); the daily cost cap sums it. */
  costUsd: number | null;
  /** Videos (jobs) that used this clip, newest last. Drives the repeat window. */
  usages: LibraryUsage[];
};

export type LibraryQuery = { ja: string[]; en: string[]; broad: string[]; subject: string | null; aliases: string[] };

const norm = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/[\s#_\-.,・、。]+/g, "");
const clean = (list: readonly (string | null | undefined)[], max: number): string[] => {
  const out: string[] = [];
  for (const item of list) {
    const text = typeof item === "string" ? item.normalize("NFKC").trim() : "";
    if (text && !out.some((existing) => norm(existing) === norm(text))) out.push(text.slice(0, 80));
    if (out.length >= max) break;
  }
  return out;
};

export const shortenCaption = (caption: string | null | undefined, max = 140): string | null => {
  const text = (caption ?? "").replace(/#[^\s#]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
};
export const extractHashtags = (caption: string | null | undefined, max = 8): string[] => clean([...(caption ?? "").matchAll(/#([^\s#]+)/g)].map((m) => m[1]), max);

export function buildLibraryTags(input: {
  ja?: readonly string[];
  en?: readonly string[];
  broad?: readonly string[];
  subject?: string | null;
  aliases?: readonly string[];
  caption?: string | null;
  hashtags?: readonly string[];
  source?: string | null;
  author?: string | null;
  externalId?: string | null;
  via?: "plan" | "prefetch";
  costUsd?: number | null;
  now?: Date;
}): LibraryTags {
  return {
    v: LIBRARY_TAGS_VERSION,
    ja: clean(input.ja ?? [], 4),
    en: clean(input.en ?? [], 4),
    broad: clean(input.broad ?? [], 3),
    subject: input.subject?.trim() || null,
    aliases: clean(input.aliases ?? [], 8),
    caption: shortenCaption(input.caption),
    hashtags: clean([...(input.hashtags ?? []), ...extractHashtags(input.caption)], 8),
    source: input.source ?? null,
    author: input.author?.trim() || null,
    externalId: input.externalId ?? null,
    addedAt: (input.now ?? new Date()).toISOString(),
    via: input.via ?? "plan",
    costUsd: typeof input.costUsd === "number" && Number.isFinite(input.costUsd) ? input.costUsd : null,
    usages: [],
  };
}

/** Defensive read of `provenance.library`; anything malformed -> null (the clip is simply not in the library). */
export function readLibraryTags(provenance: unknown): LibraryTags | null {
  const raw = provenance && typeof provenance === "object" ? (provenance as Record<string, unknown>).library : null;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const usages: LibraryUsage[] = [];
  if (Array.isArray(r.usages)) {
    for (const u of r.usages) {
      const item = u as Partial<LibraryUsage> | null;
      if (item && typeof item.jobKey === "string" && typeof item.at === "string") usages.push({ jobKey: item.jobKey, at: item.at });
    }
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    v: typeof r.v === "number" ? r.v : LIBRARY_TAGS_VERSION,
    ja: list(r.ja),
    en: list(r.en),
    broad: list(r.broad),
    subject: str(r.subject),
    aliases: list(r.aliases),
    caption: str(r.caption),
    hashtags: list(r.hashtags),
    source: str(r.source),
    author: str(r.author),
    externalId: str(r.externalId),
    addedAt: str(r.addedAt) ?? new Date(0).toISOString(),
    via: r.via === "prefetch" ? "prefetch" : "plan",
    costUsd: typeof r.costUsd === "number" && Number.isFinite(r.costUsd) ? r.costUsd : null,
    usages,
  };
}

const hit = (needle: string, haystack: readonly string[]): boolean => {
  const n = norm(needle);
  if (n.length < 2) return false;
  return haystack.some((h) => {
    const t = norm(h);
    return t.length >= 2 && (t === n || t.includes(n) || n.includes(t));
  });
};

/**
 * 0..1. With a subject: 0.5 when a subject/alias hit is in the clip's subject/aliases/caption/hashtags (half credit when only in
 * keyword tags), plus 0.5 x share of the query keywords found in the clip's keyword/caption/hashtag tags. Without a subject the
 * keywords carry the whole score. A subject that does not match at all can never reach the default threshold on keywords alone.
 */
export function scoreLibraryMatch(query: LibraryQuery, tags: LibraryTags): number {
  const keywordPool = [...tags.ja, ...tags.en, ...tags.broad, ...tags.hashtags, ...(tags.caption ? [tags.caption] : [])];
  const queryWords = clean([...query.ja, ...query.en, ...query.broad], 9);
  const keywordShare = queryWords.length === 0 ? 0 : queryWords.filter((word) => hit(word, keywordPool)).length / queryWords.length;
  const names = clean([query.subject, ...query.aliases], 8);
  if (names.length === 0) return Math.round(keywordShare * 1000) / 1000;
  const subjectPool = [...(tags.subject ? [tags.subject] : []), ...tags.aliases, ...tags.hashtags, ...(tags.caption ? [tags.caption] : [])];
  const subjectScore = names.some((name) => hit(name, subjectPool)) ? 1 : names.some((name) => hit(name, keywordPool)) ? 0.5 : 0;
  return Math.round((0.5 * subjectScore + 0.5 * keywordShare) * 1000) / 1000;
}

export const libraryMinScoreFromEnv = (env: Record<string, string | undefined> = process.env): number => {
  const parsed = Number(env.MEDIA_LIBRARY_MIN_SCORE);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : LIBRARY_MIN_SCORE_DEFAULT;
};

export type RepeatWindow = { days: number; videos: number };
export const repeatWindowFromEnv = (env: Record<string, string | undefined> = process.env): RepeatWindow => {
  const days = Number(env.MEDIA_LIBRARY_REPEAT_DAYS);
  const videos = Number(env.MEDIA_LIBRARY_REPEAT_VIDEOS);
  return {
    days: env.MEDIA_LIBRARY_REPEAT_DAYS !== undefined && Number.isFinite(days) && days >= 0 ? days : LIBRARY_REPEAT_DAYS_DEFAULT,
    videos: env.MEDIA_LIBRARY_REPEAT_VIDEOS !== undefined && Number.isFinite(videos) && videos >= 0 ? Math.floor(videos) : LIBRARY_REPEAT_VIDEOS_DEFAULT,
  };
};

export type RepeatCandidate = { assetId: string; checksumSha256: string; externalId: string | null; author: string | null; usages: readonly LibraryUsage[] };

/**
 * VE2E-91 extension point: an extra identity check (e.g. perceptual hash) consulted after the built-in external id / checksum
 * rules. Return true to treat `candidate` as a repeat of a clip used inside the window.
 */
export type RepeatGuard = (candidate: RepeatCandidate, usedInWindow: readonly RepeatCandidate[]) => boolean | Promise<boolean>;

/** Distinct video (job) keys inside the window: used within `days`, or among the `videos` most recent. */
export function recentJobKeys(all: readonly RepeatCandidate[], window: RepeatWindow, now: Date = new Date()): Set<string> {
  const latest = new Map<string, number>();
  for (const candidate of all) {
    for (const usage of candidate.usages) {
      const at = Date.parse(usage.at);
      if (!Number.isFinite(at)) continue;
      latest.set(usage.jobKey, Math.max(latest.get(usage.jobKey) ?? 0, at));
    }
  }
  const cutoff = now.getTime() - window.days * 86_400_000;
  const ordered = [...latest].sort((a, b) => b[1] - a[1]);
  const keys = new Set<string>();
  ordered.forEach(([key, at], index) => {
    if (at >= cutoff || index < window.videos) keys.add(key);
  });
  return keys;
}

/** Clips used inside the window, plus the external ids / checksums / authors they carry (identity-based, no pHash). */
export function usedInWindow(all: readonly RepeatCandidate[], window: RepeatWindow, now: Date = new Date()) {
  const keys = recentJobKeys(all, window, now);
  const used = all.filter((candidate) => candidate.usages.some((usage) => keys.has(usage.jobKey)));
  return {
    used,
    assetIds: new Set(used.map((c) => c.assetId)),
    checksums: new Set(used.map((c) => c.checksumSha256).filter(Boolean)),
    externalIds: new Set(used.map((c) => c.externalId).filter((v): v is string => Boolean(v))),
    authors: new Set(used.map((c) => c.author).filter((v): v is string => Boolean(v))),
  };
}

export function blockedByRepeatWindow(candidate: RepeatCandidate, window: ReturnType<typeof usedInWindow>): boolean {
  return window.assetIds.has(candidate.assetId) || (Boolean(candidate.checksumSha256) && window.checksums.has(candidate.checksumSha256)) || (Boolean(candidate.externalId) && window.externalIds.has(candidate.externalId!));
}

/** Author already used in the window: a soft penalty only (never blocks). */
export const AUTHOR_REPEAT_PENALTY = 0.1;
