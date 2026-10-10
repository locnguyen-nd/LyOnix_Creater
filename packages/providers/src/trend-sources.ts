/**
 * VE2E-158 Trend Radar sources. Each source turns its provider's public output into `TrendItemInput`s (`@lyonix/domain/trend-radar`) and
 * reports its own outcome, so one failing source never fails the others. Network calls are injected (tests run on fixtures, nothing paid).
 *
 *  - Yahoo!ニュース: the VE2E-96 RSS adapter + feed fetcher (same verified feed URLs; headline / feed excerpt only, the article page is never
 *    requested). Whether the source may run at all is decided by the caller (rights confirmation), never here.
 *  - TikTok: the pinned `clockworks/tiktok-scraper` Actor in SEARCH-ONLY mode (no video / cover downloads) by Japanese keyword or hashtag.
 *    Metrics are only what the Actor returns (`playCount`, `diggCount`, `commentCount`, `shareCount`; field names from the Actor's published
 *    output schema) - a missing field stays null. Quota / auth errors stop the source with their ProviderError code.
 *  - Manual TikTok URL: TikTok's public oEmbed endpoint (developers.tiktok.com/doc/embed-videos): title, author, thumbnail - no metrics.
 */
import type { NewsCategory, NewsItem, TrendCategory, TrendItemInput, TrendMetrics } from "@lyonix/domain";
import { normalizeHashtag, normalizeTrendUrl, tiktokVideoIdOf } from "@lyonix/domain";
import { APIFY_ACTOR_ALLOWLIST, runApifyActor, type ApifyDeps, type ApifyUsage } from "./apify.js";
import { ProviderError } from "./index.js";
import { NewsFeedError, fetchNewsFeedDocument, type NewsFetch } from "./news-source.js";
import { YAHOO_JAPAN_NEWS_SOURCE } from "./news-yahoo-japan.js";

// ---------------------------------------------------------------------------------------------------------------- shared

export type TrendSourceOutcome = {
  items: TrendItemInput[];
  /** Units the source read (feeds / queries) and how they went. */
  units: Array<{ unit: string; ok: boolean; count: number; error: { code: string; message: string } | null }>;
  /** Set when the whole source stopped (quota, auth): the provider's error code. */
  stopped: { code: string; message: string } | null;
};

const clip = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const count = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const isObj = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------------------------- Yahoo!ニュース

/** LyOnix news category -> Trend Radar category (the "trending" top-picks feed mixes everything: no category). */
const YAHOO_CATEGORY: Record<NewsCategory, TrendCategory | null> = { japan: "society", sports: "sports", entertainment: "entertainment", trending: null };

/** A Yahoo feed item as a Trend Radar item: the headline (+ the feed's excerpt when it has one), never more. */
export function yahooTrendItem(item: NewsItem): TrendItemInput {
  return {
    provider: "yahoo_news",
    sourceId: item.id,
    title: item.title,
    url: item.sourceUrl,
    author: null,
    publisher: item.publisher,
    publishedAt: item.publishedAt,
    excerpt: item.excerpt,
    thumbnailUrl: item.thumbnailUrl,
    hashtags: [],
    keywords: [],
    category: YAHOO_CATEGORY[item.category],
    metrics: null,
    completeness: item.excerpt ? "headline_excerpt" : "headline_only",
  };
}

export const YAHOO_TREND_CATEGORIES: readonly NewsCategory[] = YAHOO_JAPAN_NEWS_SOURCE.feeds.map((feed) => feed.category);

/** Reads the enabled Yahoo feeds (one retry on a timeout / network error per feed); a failing feed is reported, the others still count. */
export async function collectYahooTrends(input: { fetch: NewsFetch; categories: readonly NewsCategory[]; limits?: { timeoutMs: number; maxBytes: number } }): Promise<TrendSourceOutcome> {
  const outcome: TrendSourceOutcome = { items: [], units: [], stopped: null };
  const feeds = YAHOO_JAPAN_NEWS_SOURCE.feeds.filter((feed) => input.categories.includes(feed.category));
  await Promise.all(
    feeds.map(async (feed) => {
      let lastError: NewsFeedError | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const document = await fetchNewsFeedDocument(feed.url, input.fetch, input.limits);
          const items = YAHOO_JAPAN_NEWS_SOURCE.parseFeed(document, feed).map(yahooTrendItem);
          outcome.items.push(...items);
          outcome.units.push({ unit: `yahoo:${feed.category}`, ok: true, count: items.length, error: null });
          return;
        } catch (error) {
          lastError = error instanceof NewsFeedError ? error : new NewsFeedError("network", error instanceof Error ? error.message : String(error));
          if (lastError.reason !== "timeout" && lastError.reason !== "network") break;
        }
      }
      outcome.units.push({ unit: `yahoo:${feed.category}`, ok: false, count: 0, error: { code: `FEED_${lastError!.reason.toUpperCase()}`, message: lastError!.message } });
    }),
  );
  return outcome;
}

// ---------------------------------------------------------------------------------------------------------------- TikTok (Apify)

export type TikTokTrendQuery = { kind: "keyword" | "hashtag"; value: string };

/** Search-only input of the pinned TikTok Actor: Japan proxy, no downloads, one query (keyword in `searchQueries`, tag in `hashtags`). */
export function buildTikTokTrendInput(query: TikTokTrendQuery, limit: number): Record<string, unknown> {
  const common = { resultsPerPage: limit, proxyCountryCode: "JP", shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSlideshowImages: false, shouldDownloadSubtitles: false };
  return query.kind === "hashtag" ? { ...common, hashtags: [normalizeHashtag(query.value)] } : { ...common, searchQueries: [query.value.trim()], searchSection: "/video" };
}

const tiktokTime = (item: Record<string, unknown>): string | null => {
  const iso = clip(item.createTimeISO, 40);
  if (iso && !Number.isNaN(Date.parse(iso))) return new Date(iso).toISOString();
  const seconds = count(item.createTime);
  return seconds && seconds > 1_000_000_000 ? new Date(seconds * 1000).toISOString() : null;
};

/** One raw Actor item -> a Trend Radar item with ONLY the metrics the Actor returned; null for unusable items (errors, ads, no id / url). */
export function normalizeTikTokTrendItem(raw: unknown, measuredAt: string): TrendItemInput | null {
  if (!isObj(raw) || raw.error || raw.errorCode || raw.isAd === true) return null;
  const id = clip(raw.id, 32);
  const pageUrl = clip(raw.webVideoUrl ?? raw.postPage, 400);
  const canonical = pageUrl ? normalizeTrendUrl(pageUrl) : null;
  const videoId = (canonical && tiktokVideoIdOf(canonical)) || (/^\d{8,25}$/.test(id) ? id : null);
  if (!videoId || !canonical) return null;
  const text = clip(raw.text ?? raw.title, 500);
  const hashtags = Array.isArray(raw.hashtags)
    ? [...new Set(raw.hashtags.map((tag) => normalizeHashtag(typeof tag === "string" ? tag : isObj(tag) ? clip(tag.name ?? tag.title, 60) : "")).filter(Boolean))].slice(0, 30)
    : [];
  const author = isObj(raw.authorMeta) ? clip(raw.authorMeta.name ?? raw.authorMeta.nickName, 100) : "";
  const metrics: TrendMetrics = { views: count(raw.playCount), likes: count(raw.diggCount), comments: count(raw.commentCount), shares: count(raw.shareCount), measuredAt };
  const hasMetrics = metrics.views !== null || metrics.likes !== null || metrics.comments !== null || metrics.shares !== null;
  const cover = isObj(raw.videoMeta) ? clip(raw.videoMeta.coverUrl ?? raw.videoMeta.originalCoverUrl, 600) : "";
  return {
    provider: "tiktok",
    sourceId: videoId,
    title: text || (hashtags.length ? hashtags.map((tag) => `#${tag}`).join(" ") : `TikTok ${videoId}`),
    url: canonical,
    author: author ? `@${author.replace(/^@/, "")}` : null,
    publisher: null,
    publishedAt: tiktokTime(raw),
    excerpt: null,
    thumbnailUrl: cover.startsWith("https://") ? cover : null,
    hashtags,
    keywords: [],
    category: null,
    metrics: hasMetrics ? metrics : null,
    completeness: hasMetrics ? "with_metrics" : "embed_metadata",
  };
}

export type TikTokTrendRunner = (token: string, input: Record<string, unknown>, limit: number, options: { timeoutSecs: number; usage?: ApifyUsage }) => Promise<{ runId: string; items: unknown[] }>;

/** The real runner: the pinned primary Actor only (no backup: its input / output shape differs). Costs Apify credit - never called in tests. */
export const apifyTikTokTrendRunner = (deps?: ApifyDeps): TikTokTrendRunner => (token, input, limit, options) => runApifyActor(token, APIFY_ACTOR_ALLOWLIST.tiktok.primary, input, limit, options, deps);

/**
 * Runs the configured queries one after another (bounded: `maxQueries`, `limit` results each). A query error is recorded and the next query
 * runs; a quota / auth / configuration error STOPS the source (every further query would fail the same way and cost a call).
 */
export async function collectTikTokTrends(input: { token: string; queries: readonly TikTokTrendQuery[]; limit: number; maxQueries: number; timeoutSecs: number; run: TikTokTrendRunner; now: () => Date; usage?: ApifyUsage }): Promise<TrendSourceOutcome> {
  const outcome: TrendSourceOutcome = { items: [], units: [], stopped: null };
  for (const query of input.queries.slice(0, input.maxQueries)) {
    const unit = `tiktok:${query.kind}:${query.value}`;
    try {
      const run = await input.run(input.token, buildTikTokTrendInput(query, input.limit), input.limit, { timeoutSecs: input.timeoutSecs, ...(input.usage ? { usage: input.usage } : {}) });
      const measuredAt = input.now().toISOString();
      const items = run.items.map((item) => normalizeTikTokTrendItem(item, measuredAt)).filter((item): item is TrendItemInput => item !== null);
      for (const item of items) item.keywords = query.kind === "keyword" ? [query.value] : [];
      outcome.items.push(...items);
      outcome.units.push({ unit, ok: true, count: items.length, error: null });
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE";
      const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      outcome.units.push({ unit, ok: false, count: 0, error: { code, message } });
      if (code === "PROVIDER_QUOTA_EXHAUSTED" || code === "PROVIDER_AUTH_INVALID" || code === "PROVIDER_NOT_CONFIGURED" || code === "PROVIDER_CAPABILITY_UNAVAILABLE") {
        outcome.stopped = { code, message };
        break;
      }
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------------------------- manual TikTok URL (oEmbed)

export const TIKTOK_OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";

export type TikTokOembed = { title: string | null; authorName: string | null; authorUrl: string | null; thumbnailUrl: string | null };

export class TrendImportError extends Error {
  constructor(readonly code: "INVALID_URL" | "UNSUPPORTED_URL" | "OEMBED_NOT_FOUND" | "OEMBED_UNAVAILABLE" | "OEMBED_TIMEOUT", message: string) {
    super(message);
  }
}

/** Reads TikTok's public oEmbed record of a video URL (title / author / thumbnail only). Throws TrendImportError; never invents a field. */
export async function fetchTikTokOembed(url: string, fetchImpl: NewsFetch, timeoutMs = 8_000): Promise<TikTokOembed> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${TIKTOK_OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}`, { signal: controller.signal, redirect: "follow", headers: { accept: "application/json", "user-agent": "LyOnix-TrendRadar/1.0" } });
    if (response.status === 400 || response.status === 404) throw new TrendImportError("OEMBED_NOT_FOUND", "TikTok không trả thông tin cho URL này (video riêng tư, đã xoá hoặc URL không hỗ trợ).");
    if (!response.ok) throw new TrendImportError("OEMBED_UNAVAILABLE", `TikTok oEmbed lỗi HTTP ${response.status}`);
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      throw new TrendImportError("OEMBED_UNAVAILABLE", "TikTok oEmbed trả dữ liệu không đọc được");
    }
    if (!isObj(body)) throw new TrendImportError("OEMBED_UNAVAILABLE", "TikTok oEmbed trả dữ liệu không đọc được");
    const https = (value: unknown) => {
      const text = clip(value, 600);
      return text.startsWith("https://") ? text : null;
    };
    return { title: clip(body.title, 500) || null, authorName: clip(body.author_name, 100) || null, authorUrl: https(body.author_url), thumbnailUrl: https(body.thumbnail_url) };
  } catch (error) {
    if (error instanceof TrendImportError) throw error;
    if (controller.signal.aborted) throw new TrendImportError("OEMBED_TIMEOUT", `TikTok oEmbed không trả lời trong ${timeoutMs} ms`);
    throw new TrendImportError("OEMBED_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** A manually imported TikTok video: the oEmbed fields when there are any, the user's URL always; never metrics. */
export function manualTikTokItem(canonicalUrl: string, oembed: TikTokOembed | null): TrendItemInput {
  const videoId = tiktokVideoIdOf(canonicalUrl)!;
  const hashtags = [...new Set((oembed?.title?.match(/#[^\s#]+/g) ?? []).map(normalizeHashtag).filter(Boolean))].slice(0, 30);
  return {
    provider: "manual",
    sourceId: `tiktok:${videoId}`,
    title: oembed?.title || `TikTok ${videoId}`,
    url: canonicalUrl,
    author: oembed?.authorName ? `@${oembed.authorName.replace(/^@/, "")}` : null,
    publisher: null,
    publishedAt: null,
    excerpt: null,
    thumbnailUrl: oembed?.thumbnailUrl ?? null,
    hashtags,
    keywords: [],
    category: null,
    metrics: null,
    completeness: oembed ? "embed_metadata" : "user_supplied",
  };
}
