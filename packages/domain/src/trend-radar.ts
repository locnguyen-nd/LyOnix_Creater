/**
 * VE2E-158 Trend Radar - the pure core shared by the API (collect / cluster / score / notify) and the web (labels, filters, explanations).
 * No I/O, browser-safe (subpath `@lyonix/domain/trend-radar`).
 *
 * Honesty rules encoded here (spec VE2E-158 §6):
 *  - "growth" is only claimed from TWO OR MORE observations over time (appearance counts per run, or the same video measured twice); one
 *    snapshot - however big its view count - never scores momentum and says "chưa đủ dữ liệu để xác nhận mức độ tăng trưởng";
 *  - engagement points only come from metrics a provider really returned (null = not reported, never 0, never guessed);
 *  - every point of the 0..100 score carries its reason, so the UI can say WHY a topic ranks high.
 */

import { normalizeNewsUrl } from "./news.js";

export const TREND_PROVIDER_IDS = ["yahoo_news", "tiktok", "manual"] as const;
export type TrendProviderId = (typeof TREND_PROVIDER_IDS)[number];
export const isTrendProviderId = (value: unknown): value is TrendProviderId => typeof value === "string" && (TREND_PROVIDER_IDS as readonly string[]).includes(value);

export const TREND_STATUSES = ["new", "reviewed", "approved", "rejected", "used"] as const;
export type TrendStatus = (typeof TREND_STATUSES)[number];
export const isTrendStatus = (value: unknown): value is TrendStatus => typeof value === "string" && (TREND_STATUSES as readonly string[]).includes(value);

export const TREND_RUN_STATUSES = ["pending", "running", "completed", "partial", "failed"] as const;
export type TrendRunStatus = (typeof TREND_RUN_STATUSES)[number];

/** Result of one source in one run. `not_connected` = no credential / account; `rights_unconfirmed` = the source's terms are not accepted yet. */
export const TREND_SOURCE_STATUSES = ["ok", "partial", "failed", "quota_exhausted", "not_connected", "rights_unconfirmed", "disabled"] as const;
export type TrendSourceStatus = (typeof TREND_SOURCE_STATUSES)[number];

export const TREND_CATEGORIES = ["society", "entertainment", "anime", "game", "celebrity", "lifestyle", "tech", "sports", "world", "business", "other"] as const;
export type TrendCategory = (typeof TREND_CATEGORIES)[number];
export const isTrendCategory = (value: unknown): value is TrendCategory => typeof value === "string" && (TREND_CATEGORIES as readonly string[]).includes(value);

export const TREND_BANDS = ["hot", "rising", "review", "low"] as const;
export type TrendBand = (typeof TREND_BANDS)[number];

/** Engagement a provider really returned. `null` = not reported (never a guessed 0). */
export type TrendMetrics = { views: number | null; likes: number | null; comments: number | null; shares: number | null; measuredAt: string };

/** How much of the source the system really has: headline only, headline + feed excerpt, real metrics, or what a user typed. */
export const TREND_DATA_COMPLETENESS = ["headline_only", "headline_excerpt", "embed_metadata", "with_metrics", "user_supplied"] as const;
export type TrendDataCompleteness = (typeof TREND_DATA_COMPLETENESS)[number];

/** One normalised item, whatever the provider. */
export type TrendItemInput = {
  provider: TrendProviderId;
  /** The provider's own stable id (`yahoo_jp:articles:<hash>`, a TikTok video id, ...). */
  sourceId: string;
  title: string;
  url: string;
  author: string | null;
  publisher: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  thumbnailUrl: string | null;
  hashtags: string[];
  keywords: string[];
  category: TrendCategory | null;
  metrics: TrendMetrics | null;
  completeness: TrendDataCompleteness;
};

// ---------------------------------------------------------------------------------------------------------------- normalisation

const TIKTOK_VIDEO = /^\/@([^/]+)\/(?:video|photo)\/(\d{8,25})\/?$/;

/** TikTok video id of a URL (`https://www.tiktok.com/@user/video/123...`), or null. Short links (`vm.tiktok.com`) have none until resolved. */
export function tiktokVideoIdOf(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!/(^|\.)tiktok\.com$/i.test(url.hostname)) return null;
    return TIKTOK_VIDEO.exec(url.pathname)?.[2] ?? null;
  } catch {
    return null;
  }
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|igshid|is_from_webapp|sender_device|_r|_t|lang|refer|referer|source)$/i;

/**
 * Canonical URL used for de-duplication: https, lower-case host without `www.`/`m.`, no fragment, no tracking parameters, no trailing slash;
 * a TikTok video becomes `https://www.tiktok.com/@<user>/video/<id>`; a news URL goes through the news normaliser. null = not a usable URL.
 */
export function normalizeTrendUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    const match = TIKTOK_VIDEO.exec(url.pathname);
    if (match) return `https://www.tiktok.com/@${match[1]!.toLowerCase()}/video/${match[2]}`;
  }
  const news = normalizeNewsUrl(url.toString());
  if (news && host.endsWith("yahoo.co.jp")) return news;
  url.protocol = "https:";
  url.hostname = host;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

/** Bracketed labels news headlines carry (【速報】, ［写真］, 〈動画〉) and a trailing publisher in parentheses. */
const LABELS = /[【［\[〈《][^】］\]〉》]{0,12}[】］\]〉》]/g;
const TRAILING_PUBLISHER = /[（(][^（）()]{1,40}[）)]\s*$/;

/** Title key for de-duplication / similarity: NFKC, no labels / trailing publisher / punctuation / spaces / emoji, lower-case. */
export function normalizeTrendTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(LABELS, "")
    .replace(TRAILING_PUBLISHER, "")
    .toLowerCase()
    .replace(/#[^\s#]+/g, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

/** Hashtag key: no `#`, NFKC, lower-case. */
export const normalizeHashtag = (tag: string): string => tag.normalize("NFKC").replace(/^#+/, "").trim().toLowerCase();

/** Character bigrams of a normalised title (works for Japanese, which has no spaces). */
export function titleBigrams(normalized: string): Set<string> {
  const chars = [...normalized];
  const grams = new Set<string>();
  if (chars.length === 1) grams.add(chars[0]!);
  for (let index = 0; index + 1 < chars.length; index += 1) grams.add(chars[index]! + chars[index + 1]!);
  return grams;
}

/** Dice coefficient of two normalised titles' bigrams, 0..1 (1 = same text). */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = titleBigrams(a);
  const y = titleBigrams(b);
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

// ---------------------------------------------------------------------------------------------------------------- de-duplication + clustering

export type ClusterCandidate = {
  id: string;
  /** Normalised titles of the cluster's items (the representative first). */
  titles: string[];
  urls: string[];
  hashtags: string[];
};

export const TREND_CLUSTER_DEFAULTS = {
  /** Same story: titles at least this similar. */
  titleSimilarity: 0.5,
  /** A shared hashtag lowers the bar to this. */
  hashtagSimilarity: 0.3,
} as const;

/**
 * The cluster a new item joins: the cluster already holding its canonical URL, else the most similar title (>= `titleSimilarity`, or
 * >= `hashtagSimilarity` with a shared hashtag), else null (a new cluster). The item keeps its own source link either way - clustering
 * groups sources, it never merges them away.
 */
export function clusterFor(item: { normalizedTitle: string; canonicalUrl: string; hashtags: readonly string[] }, clusters: readonly ClusterCandidate[], options: { titleSimilarity: number; hashtagSimilarity: number } = TREND_CLUSTER_DEFAULTS): { clusterId: string; similarity: number; reason: "url" | "title" | "title_hashtag" } | null {
  const byUrl = clusters.find((cluster) => cluster.urls.includes(item.canonicalUrl));
  if (byUrl) return { clusterId: byUrl.id, similarity: 1, reason: "url" };
  const tags = new Set(item.hashtags.map(normalizeHashtag));
  let best: { clusterId: string; similarity: number; reason: "title" | "title_hashtag" } | null = null;
  for (const cluster of clusters) {
    const similarity = Math.max(0, ...cluster.titles.map((title) => titleSimilarity(item.normalizedTitle, title)));
    const sharesTag = cluster.hashtags.some((tag) => tags.has(normalizeHashtag(tag)));
    const qualifies = similarity >= options.titleSimilarity || (sharesTag && similarity >= options.hashtagSimilarity);
    if (qualifies && (!best || similarity > best.similarity)) best = { clusterId: cluster.id, similarity, reason: similarity >= options.titleSimilarity ? "title" : "title_hashtag" };
  }
  return best;
}

/** Items of ONE run that are the same thing twice (same provider + source id, or same canonical URL): kept once, the rest counted as duplicates. */
export function dedupeTrendItems<T extends { provider: string; sourceId: string; canonicalUrl: string }>(items: readonly T[]): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  for (const item of items) {
    const keys = [`${item.provider}:${item.sourceId}`, item.canonicalUrl];
    if (keys.some((key) => seen.has(key))) {
      duplicates += 1;
      continue;
    }
    for (const key of keys) seen.add(key);
    unique.push(item);
  }
  return { unique, duplicates };
}

// ---------------------------------------------------------------------------------------------------------------- Trend Score

export type TrendThresholds = { hot: number; rising: number; review: number };
export const DEFAULT_TREND_THRESHOLDS: TrendThresholds = { hot: 80, rising: 60, review: 40 };

/** Thresholds as configured, kept ordered and inside 0..100 (hot > rising > review). */
export function sanitizeTrendThresholds(raw: Partial<TrendThresholds> | null | undefined): TrendThresholds {
  const clamp = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : fallback);
  const hot = clamp(raw?.hot, DEFAULT_TREND_THRESHOLDS.hot);
  const rising = Math.min(hot - 1, clamp(raw?.rising, DEFAULT_TREND_THRESHOLDS.rising));
  const review = Math.min(rising - 1, clamp(raw?.review, DEFAULT_TREND_THRESHOLDS.review));
  return { hot, rising: Math.max(1, rising), review: Math.max(0, review) };
}

export const bandOf = (score: number, thresholds: TrendThresholds = DEFAULT_TREND_THRESHOLDS): TrendBand =>
  score >= thresholds.hot ? "hot" : score >= thresholds.rising ? "rising" : score >= thresholds.review ? "review" : "low";

/** Rank of a band (hot = 3 ... low = 0), for "at least this band" comparisons. */
export const bandRank = (band: TrendBand): number => ({ hot: 3, rising: 2, review: 1, low: 0 })[band];

export type TrendScoreInput = {
  now: string;
  /** Newest publish time among the cluster's items; null when no source gave one. */
  publishedAt: string | null;
  firstSeenAt: string;
  /** Distinct platforms of the cluster's items (yahoo_news, tiktok, ...). */
  providers: readonly string[];
  /** Distinct ORIGINS of the cluster's items: the publisher (news) or author (video), the provider when neither is known. */
  origins: readonly string[];
  /** Items of the cluster seen in this run's window and in the previous window; `previous: null` = there is no previous observation. */
  appearances: { current: number; previous: number | null };
  /** Best real metrics of the cluster (a TikTok video), or null. */
  metrics: TrendMetrics | null;
  /** Views gained per hour between two measurements of the SAME video; null without two measurements. */
  viewsPerHour: number | null;
  relevance: { keywordHits: number; hashtagHits: number; categoryMatch: boolean };
  category: TrendCategory | null;
  /** The topic was already used / rejected (same story produced or dropped before). */
  alreadyHandled: boolean;
  /** Search window: content older than this many hours is stale. */
  windowHours: number;
};

export type TrendScoreComponent = { key: "freshness" | "sources" | "momentum" | "engagement" | "relevance" | "fit" | "penalty"; points: number; max: number; reason: string };
export type TrendScore = { score: number; band: TrendBand; components: TrendScoreComponent[]; notes: string[] };

export const TREND_NO_GROWTH_DATA = "Chưa đủ dữ liệu để xác nhận mức độ tăng trưởng";
export const TREND_NO_METRICS = "Chưa có số liệu tương tác";

const fmt = (value: number): string => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(Math.round(value)));
const SHORT_VIDEO_FIT: Partial<Record<TrendCategory, number>> = { entertainment: 5, anime: 5, game: 5, celebrity: 5, lifestyle: 5, tech: 4, sports: 4, society: 3, world: 2, business: 2 };

/** The 0..100 Trend Score with one reason per component. Pure; the API persists the breakdown so the UI can explain the rank. */
export function scoreTrend(input: TrendScoreInput, thresholds: TrendThresholds = DEFAULT_TREND_THRESHOLDS): TrendScore {
  const components: TrendScoreComponent[] = [];
  const notes: string[] = [];
  const now = Date.parse(input.now);
  const reference = input.publishedAt ?? input.firstSeenAt;
  const ageHours = Math.max(0, (now - Date.parse(reference)) / 3_600_000);

  // freshness (25)
  const freshness = ageHours <= 2 ? 25 : ageHours <= 6 ? 20 : ageHours <= 12 ? 15 : ageHours <= 24 ? 10 : ageHours <= 48 ? 5 : 0;
  components.push({ key: "freshness", points: freshness, max: 25, reason: `${input.publishedAt ? "Đăng" : "Thu thập"} cách đây ${ageHours < 1 ? "dưới 1" : Math.round(ageHours)} giờ` });

  // several sources (20)
  const sourceCount = new Set(input.origins.filter(Boolean)).size;
  const platforms = new Set(input.providers).size;
  const sources = sourceCount >= 4 ? 20 : sourceCount === 3 ? 15 : sourceCount === 2 ? 10 : 0;
  components.push({ key: "sources", points: sources, max: 20, reason: sourceCount >= 2 ? `Xuất hiện ở ${sourceCount} nguồn${platforms >= 2 ? ` trên ${platforms} nền tảng` : ""}` : "Mới thấy ở 1 nguồn" });

  // momentum (20): only from observations over time
  let momentum = 0;
  let momentumReason = TREND_NO_GROWTH_DATA;
  if (input.appearances.previous !== null) {
    const growth = input.appearances.current - input.appearances.previous;
    const fromAppearances = growth >= 3 ? 20 : growth === 2 ? 14 : growth === 1 ? 8 : 0;
    if (fromAppearances > 0) {
      momentum = fromAppearances;
      momentumReason = `Số bài/video về chủ đề tăng ${input.appearances.previous} → ${input.appearances.current} giữa hai lần quét`;
    } else momentumReason = `Không tăng giữa hai lần quét (${input.appearances.previous} → ${input.appearances.current})`;
  }
  if (input.viewsPerHour !== null) {
    const fromVelocity = input.viewsPerHour >= 100_000 ? 20 : input.viewsPerHour >= 20_000 ? 14 : input.viewsPerHour >= 5_000 ? 8 : input.viewsPerHour > 0 ? 3 : 0;
    if (fromVelocity > momentum) {
      momentum = fromVelocity;
      momentumReason = `Lượt xem tăng ~${fmt(input.viewsPerHour)}/giờ giữa hai lần đo`;
    }
  }
  if (input.appearances.previous === null && input.viewsPerHour === null) notes.push(TREND_NO_GROWTH_DATA);
  components.push({ key: "momentum", points: momentum, max: 20, reason: momentumReason });

  // engagement (20): real metrics only
  const m = input.metrics;
  if (m && m.views !== null && m.views > 0) {
    const views = m.views;
    const viewPoints = views >= 1_000_000 ? 12 : views >= 300_000 ? 9 : views >= 100_000 ? 6 : views >= 20_000 ? 3 : 0;
    const interactions = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0);
    const reported = m.likes !== null || m.comments !== null || m.shares !== null;
    const rate = reported ? interactions / views : null;
    const ratePoints = rate === null ? 0 : rate >= 0.08 ? 8 : rate >= 0.04 ? 5 : rate >= 0.02 ? 3 : 0;
    components.push({ key: "engagement", points: viewPoints + ratePoints, max: 20, reason: `${fmt(views)} lượt xem${rate === null ? "" : `, tương tác ${(rate * 100).toFixed(1)}%`} (số liệu tại thời điểm thu thập)` });
    if (input.viewsPerHour === null) notes.push("Lượt xem cao chưa chứng minh đang tăng: mới có một lần đo");
  } else {
    components.push({ key: "engagement", points: 0, max: 20, reason: TREND_NO_METRICS });
  }

  // relevance to the team's channels (10)
  const relevance = Math.min(10, input.relevance.keywordHits * 4 + input.relevance.hashtagHits * 3 + (input.relevance.categoryMatch ? 3 : 0));
  const relevanceBits = [input.relevance.keywordHits ? `${input.relevance.keywordHits} từ khoá` : "", input.relevance.hashtagHits ? `${input.relevance.hashtagHits} hashtag` : "", input.relevance.categoryMatch ? "đúng danh mục" : ""].filter(Boolean);
  components.push({ key: "relevance", points: relevance, max: 10, reason: relevanceBits.length ? `Khớp cấu hình kênh: ${relevanceBits.join(", ")}` : "Không khớp từ khoá / hashtag / danh mục đã cấu hình" });

  // fit for a 30-60 s short video (5)
  const fit = input.category ? (SHORT_VIDEO_FIT[input.category] ?? 1) : 1;
  components.push({ key: "fit", points: fit, max: 5, reason: input.category ? `Danh mục ${input.category} ${fit >= 4 ? "dễ làm video ngắn" : "làm video ngắn được nhưng khó hơn"}` : "Chưa rõ danh mục" });

  // penalties
  let penalty = 0;
  const penalties: string[] = [];
  if (ageHours > input.windowHours) {
    penalty += 15;
    penalties.push(`cũ hơn ${input.windowHours} giờ`);
  }
  if (input.alreadyHandled) {
    penalty += 10;
    penalties.push("đã dùng / đã bỏ qua trước đó");
  }
  if (!input.publishedAt) {
    penalty += 3;
    penalties.push("thiếu thời gian đăng");
  }
  if (penalty > 0) components.push({ key: "penalty", points: -penalty, max: 0, reason: `Trừ điểm: ${penalties.join(", ")}` });

  const score = Math.max(0, Math.min(100, components.reduce((sum, component) => sum + component.points, 0)));
  return { score, band: bandOf(score, thresholds), components, notes };
}

/** Relevance hits of a cluster against the configured keywords / hashtags / categories (case- and width-insensitive). */
export function relevanceOf(cluster: { titles: readonly string[]; hashtags: readonly string[]; category: TrendCategory | null }, config: { keywords: readonly string[]; hashtags: readonly string[]; categories: readonly string[] }): TrendScoreInput["relevance"] {
  const text = cluster.titles.map((title) => title.normalize("NFKC").toLowerCase()).join(" ");
  const keywordHits = config.keywords.filter((keyword) => keyword.trim() && text.includes(keyword.normalize("NFKC").toLowerCase().trim())).length;
  const tags = new Set(cluster.hashtags.map(normalizeHashtag));
  const hashtagHits = config.hashtags.filter((tag) => tags.has(normalizeHashtag(tag))).length;
  return { keywordHits, hashtagHits, categoryMatch: Boolean(cluster.category && config.categories.includes(cluster.category)) };
}

// ---------------------------------------------------------------------------------------------------------------- notifications

/** One notification per cluster per band reached: the key is unique per recipient, so later runs never repeat it. */
export const trendNotificationKey = (clusterId: string, band: TrendBand): string => `trend:${clusterId}:${band}`;

/** Should a cluster that now scores `score` notify, given the bands it already notified? Only when it reaches the threshold band for the first time. */
export function trendNotificationBand(score: number, notifyMinScore: number, notifiedBands: readonly TrendBand[], thresholds: TrendThresholds = DEFAULT_TREND_THRESHOLDS): TrendBand | null {
  if (score < notifyMinScore) return null;
  const band = bandOf(score, thresholds);
  if (notifiedBands.some((already) => bandRank(already) >= bandRank(band))) return null;
  return band;
}

// ---------------------------------------------------------------------------------------------------------------- Gemini budget

export type TrendAnalysisBudget = { autoPerDay: number; totalPerDay: number };
export const DEFAULT_TREND_ANALYSIS_BUDGET: TrendAnalysisBudget = { autoPerDay: 5, totalPerDay: 15 };

/**
 * May one more analysis call run? `auto` ones (Hot clusters, by the job) are capped by `autoPerDay`, every call (auto + on demand) by
 * `totalPerDay` for the model - a LyOnix-side cap under whatever quota the account really has (which is only learnt from the provider).
 */
export function analysisAllowed(kind: "auto" | "manual", usedToday: { auto: number; total: number }, budget: TrendAnalysisBudget): { ok: true } | { ok: false; reason: "auto_limit" | "total_limit" } {
  if (usedToday.total >= budget.totalPerDay) return { ok: false, reason: "total_limit" };
  if (kind === "auto" && usedToday.auto >= budget.autoPerDay) return { ok: false, reason: "auto_limit" };
  return { ok: true };
}

/** UTC day key of a usage counter (`2026-10-10`). */
export const usageDay = (at: Date): string => at.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------- duplicates with past jobs

export type PastProduction = { kind: "job" | "video_production"; id: string; title: string; sourceUrls: readonly string[]; createdAt: string };

/** Previous jobs that look like this topic: same source URL, or a similar title. Most similar first. */
export function similarProductions(topic: { titles: readonly string[]; urls: readonly string[] }, past: readonly PastProduction[], minSimilarity = 0.45): Array<PastProduction & { similarity: number; reason: "same_source" | "similar_title" }> {
  const urls = new Set(topic.urls.map((url) => normalizeTrendUrl(url) ?? url));
  const titles = topic.titles.map(normalizeTrendTitle).filter(Boolean);
  const out: Array<PastProduction & { similarity: number; reason: "same_source" | "similar_title" }> = [];
  for (const production of past) {
    if (production.sourceUrls.some((url) => urls.has(normalizeTrendUrl(url) ?? url))) {
      out.push({ ...production, similarity: 1, reason: "same_source" });
      continue;
    }
    const normalized = normalizeTrendTitle(production.title);
    const similarity = Math.max(0, ...titles.map((title) => titleSimilarity(title, normalized)));
    if (similarity >= minSimilarity) out.push({ ...production, similarity, reason: "similar_title" });
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}

/** The angle to suggest to the next person on a topic: the first one nobody else took (several people -> different videos). */
export function suggestAngle(angleCount: number, takenAngles: readonly number[]): number | null {
  for (let index = 0; index < angleCount; index += 1) if (!takenAngles.includes(index)) return index;
  return null;
}
