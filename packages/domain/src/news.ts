/**
 * VE2E-96: news items for the create-video page - one normalised shape whatever the source (Yahoo! JAPAN today, NHK / Nikkei / ... later).
 * A news item is only what a source publishes in its feed (headline, short excerpt, thumbnail, link, time): the article itself is never
 * fetched. Pure, browser-safe (subpath `@lyonix/domain/news`): the API normalises / filters / dedupes with it, the web composes the topic.
 */

/** Feed categories LyOnix shows. A source maps its own feeds onto these. */
export const NEWS_CATEGORIES = ["japan", "sports", "entertainment", "trending"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

/** Sources with an adapter. Adding one = an adapter in `@lyonix/providers` + its id here. */
export const NEWS_SOURCE_IDS = ["yahoo_jp"] as const;
export type NewsSourceId = (typeof NEWS_SOURCE_IDS)[number];

/** Filter chips of the feed: everything, one source, or one category (across every enabled source). */
export const NEWS_FILTERS = ["all", "yahoo_jp", "japan", "sports", "entertainment", "trending"] as const;
export type NewsFilter = (typeof NEWS_FILTERS)[number];

export type NewsItem = {
  /** `<sourceId>:<the source's own id>` - stable across fetches. */
  id: string;
  sourceId: NewsSourceId;
  /** Display name of the source (e.g. "Yahoo!ニュース"). */
  source: string;
  /** Publisher named by the source when it aggregates (e.g. "スポーツ報知"); null when unknown. */
  publisher: string | null;
  title: string;
  excerpt: string | null;
  thumbnailUrl: string | null;
  /** Link to the original article (opened by the user, never fetched by LyOnix). */
  sourceUrl: string;
  /** ISO 8601; null when the feed has no date. */
  publishedAt: string | null;
  category: NewsCategory;
};

export const NEWS_LIMITS = {
  maxTitleChars: 300,
  maxExcerptChars: 400,
  maxNameChars: 80,
  maxUrlChars: 2_000,
  maxQueryChars: 100,
  /** Items returned by one feed request. */
  maxItems: 120,
} as const;

/** A video's `topic` source is at most 400 characters (`sources.service` rejects longer) - a topic made from a news item fits in it. */
export const NEWS_TOPIC_MAX_CHARS = 400;

export const isNewsFilter = (value: unknown): value is NewsFilter => typeof value === "string" && (NEWS_FILTERS as readonly string[]).includes(value);
export const isNewsCategory = (value: unknown): value is NewsCategory => typeof value === "string" && (NEWS_CATEGORIES as readonly string[]).includes(value);
export const isNewsSourceId = (value: unknown): value is NewsSourceId => typeof value === "string" && (NEWS_SOURCE_IDS as readonly string[]).includes(value);

/** What a filter keeps: one source, one category, or everything. */
export const newsFilterScope = (filter: NewsFilter): { sourceId: NewsSourceId | null; category: NewsCategory | null } => ({
  sourceId: isNewsSourceId(filter) ? filter : null,
  category: isNewsCategory(filter) ? filter : null,
});

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** One line of display text: control characters removed, whitespace collapsed, cut at `max` characters. */
export const cleanNewsText = (value: string, max: number): string => {
  const text = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
};

const TRACKING_PARAMS = /^(source|utm_[a-z]+|fbclid|gclid|ref)$/i;
/** http(s) URL with the host lowercased, the fragment and tracking parameters (`?source=rss`, `utm_*`) dropped; null when not a web URL. */
export const normalizeNewsUrl = (raw: string): string | null => {
  if (typeof raw !== "string" || raw.length > NEWS_LIMITS.maxUrlChars) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
};

const httpsUrl = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const normalized = normalizeNewsUrl(raw);
  return normalized && normalized.startsWith("https://") ? raw.trim() : null;
};

/** A complete, valid news item (from an adapter or a stored draft), or null. Text is cleaned and capped, URLs must be https. */
export function sanitizeNewsItem(raw: unknown): NewsItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? cleanNewsText(value, max) : null);
  const id = text(record.id, NEWS_LIMITS.maxNameChars * 2);
  const title = text(record.title, NEWS_LIMITS.maxTitleChars);
  const source = text(record.source, NEWS_LIMITS.maxNameChars);
  const sourceUrl = httpsUrl(record.sourceUrl);
  if (!id || !title || !source || !sourceUrl || !isNewsSourceId(record.sourceId) || !isNewsCategory(record.category)) return null;
  const published = typeof record.publishedAt === "string" ? new Date(record.publishedAt) : null;
  return {
    id,
    sourceId: record.sourceId,
    source,
    publisher: text(record.publisher, NEWS_LIMITS.maxNameChars),
    title,
    excerpt: text(record.excerpt, NEWS_LIMITS.maxExcerptChars),
    thumbnailUrl: httpsUrl(record.thumbnailUrl),
    sourceUrl,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
    category: record.category,
  };
}

/**
 * One item per story: the same id or the same normalised URL is a duplicate. The first one wins (callers order by preference); a
 * duplicate only fills an excerpt / thumbnail the kept item lacks.
 */
export function dedupeNewsItems(items: readonly NewsItem[]): NewsItem[] {
  const kept: NewsItem[] = [];
  const byKey = new Map<string, number>();
  for (const item of items) {
    const keys = [`id:${item.id}`, `url:${normalizeNewsUrl(item.sourceUrl) ?? item.sourceUrl}`];
    const at = keys.map((key) => byKey.get(key)).find((index) => index !== undefined);
    if (at === undefined) {
      keys.forEach((key) => byKey.set(key, kept.length));
      kept.push(item);
      continue;
    }
    const first = kept[at]!;
    if ((!first.excerpt && item.excerpt) || (!first.thumbnailUrl && item.thumbnailUrl)) kept[at] = { ...first, excerpt: first.excerpt ?? item.excerpt, thumbnailUrl: first.thumbnailUrl ?? item.thumbnailUrl };
    keys.forEach((key) => byKey.set(key, at));
  }
  return kept;
}

/** Newest first; items without a date last; otherwise the input order. */
export const sortNewsItems = (items: readonly NewsItem[]): NewsItem[] =>
  items
    .map((item, index) => ({ item, index, time: item.publishedAt ? Date.parse(item.publishedAt) : Number.NEGATIVE_INFINITY }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map(({ item }) => item);

/** Case- and width-insensitive (NFKC: full-width "ＮＨＫ" = "nhk"). */
export const normalizeNewsQuery = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, NEWS_LIMITS.maxQueryChars);

/** Every word of the query appears in the title, excerpt, publisher or source. An empty query matches everything. */
export const newsMatchesQuery = (item: NewsItem, query: string): boolean => {
  const words = normalizeNewsQuery(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeNewsQuery([item.title, item.excerpt ?? "", item.publisher ?? "", item.source].join(" "));
  return words.every((word) => haystack.includes(word));
};

export const newsMatchesFilter = (item: NewsItem, filter: NewsFilter): boolean => {
  const scope = newsFilterScope(filter);
  return (!scope.sourceId || item.sourceId === scope.sourceId) && (!scope.category || item.category === scope.category);
};

/**
 * The topic the video is made from when the user picks a news item: headline, the feed's excerpt and the source (named, with its link).
 * Only what the feed published - the article is never fetched (the run gets a `topic` source, not `article_url`).
 */
export const composeNewsTopic = (item: Pick<NewsItem, "title" | "excerpt" | "source" | "publisher" | "sourceUrl">): string => {
  const named = `Source: ${item.publisher ? `${item.publisher} / ` : ""}${item.source}`;
  // a link too long to leave room for the headline is dropped (the source stays named; the item keeps its link in the draft)
  const sourceLine = [...`${named} - ${item.sourceUrl}`].length <= NEWS_TOPIC_MAX_CHARS - 60 ? `${named} - ${item.sourceUrl}` : named;
  const fit = (parts: Array<string | null>) => parts.filter(Boolean).join("\n\n");
  const full = fit([item.title, item.excerpt, sourceLine]);
  if ([...full].length <= NEWS_TOPIC_MAX_CHARS) return full;
  // over the limit: shorten the excerpt first, then the headline; the named source and its link always stay
  const room = NEWS_TOPIC_MAX_CHARS - [...fit([item.title, sourceLine])].length - 2;
  if (item.excerpt && room >= 20) return fit([item.title, cleanNewsText(item.excerpt, room), sourceLine]);
  const titleRoom = Math.max(20, NEWS_TOPIC_MAX_CHARS - [...sourceLine].length - 2);
  return fit([cleanNewsText(item.title, titleRoom), sourceLine]);
};

/** The picked item as stored in the create-video draft (`selectedNews`). */
export const serializeSelectedNews = (item: NewsItem | null): string => (item ? JSON.stringify(item) : "");

/** The picked item back from a draft value; null when empty or not a valid item. */
export const parseSelectedNews = (raw: string): NewsItem | null => {
  if (!raw) return null;
  try {
    return sanitizeNewsItem(JSON.parse(raw));
  } catch {
    return null;
  }
};
