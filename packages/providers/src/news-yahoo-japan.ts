/**
 * VE2E-96: Yahoo! JAPAN News through its public RSS feeds (https://news.yahoo.co.jp/rss) - headline, feed excerpt, thumbnail, link and
 * time only; the article page is never requested.
 *
 * TERMS: Yahoo! JAPAN states its RSS is for personal use only and may not be used to build or distribute a public site / app, nor
 * redistributed. The source is therefore OFF unless the operator enables it (`NEWS_SOURCES=yahoo_jp`) after confirming LyOnix's right
 * to use it (e.g. an agreement with LY Corporation).
 */
import { cleanNewsText, normalizeNewsUrl, sanitizeNewsItem, type NewsItem } from "@lyonix/domain";
import { parseRssItems } from "./news-rss.js";
import type { NewsSourceAdapter, NewsSourceFeed } from "./news-source.js";

const LABEL = "Yahoo!ニュース";
const HOST = "news.yahoo.co.jp";

const OPEN = new Set(["(", "（"]);
const CLOSE = new Set([")", "）"]);
/**
 * "見出し　(スポーツ報知)" / "見出し(テレビ朝日系（ANN）)" -> headline + publisher: category feeds name the publishing outlet in the last,
 * balanced parentheses of the title (the name itself may contain parentheses).
 */
export const splitYahooPublisher = (raw: string): { title: string; publisher: string | null } => {
  const chars = [...raw.trim()];
  if (!CLOSE.has(chars.at(-1) ?? "")) return { title: raw, publisher: null };
  let depth = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (CLOSE.has(chars[index]!)) depth += 1;
    else if (OPEN.has(chars[index]!) && --depth === 0) {
      const publisher = chars.slice(index + 1, -1).join("").trim();
      const title = chars.slice(0, index).join("").trim();
      return publisher && title && [...publisher].length <= 40 ? { title, publisher } : { title: raw, publisher: null };
    }
  }
  return { title: raw, publisher: null };
};

/** Stable id from the article path: `/articles/<hash>` or `/pickup/<number>`. */
const idOf = (url: URL): string | null => {
  const match = /^\/(articles|pickup)\/([A-Za-z0-9]+)$/.exec(url.pathname.replace(/\/+$/, ""));
  return match ? `yahoo_jp:${match[1]}:${match[2]}` : null;
};

const toItem = (entry: ReturnType<typeof parseRssItems>[number], feed: NewsSourceFeed): NewsItem | null => {
  const link = normalizeNewsUrl(entry.link);
  if (!link) return null;
  const url = new URL(link);
  if (url.hostname !== HOST) return null;
  const id = idOf(url);
  if (!id) return null;
  const titled = id.includes(":articles:") ? splitYahooPublisher(entry.title) : { title: entry.title, publisher: null };
  const published = entry.pubDate ? new Date(entry.pubDate) : null;
  return sanitizeNewsItem({
    id,
    sourceId: "yahoo_jp",
    source: LABEL,
    publisher: titled.publisher,
    title: titled.title,
    excerpt: entry.description ? cleanNewsText(entry.description, 400) : null,
    thumbnailUrl: entry.image || null,
    sourceUrl: link,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
    category: feed.category,
  });
};

export const YAHOO_JAPAN_NEWS_SOURCE: NewsSourceAdapter = {
  id: "yahoo_jp",
  label: LABEL,
  homepageUrl: "https://news.yahoo.co.jp/",
  termsUrl: "https://news.yahoo.co.jp/rss",
  feeds: [
    // category feeds carry an excerpt and a thumbnail; the topics feed ("主要") is headline + link only
    { category: "japan", url: "https://news.yahoo.co.jp/rss/categories/domestic.xml" },
    { category: "sports", url: "https://news.yahoo.co.jp/rss/categories/sports.xml" },
    { category: "entertainment", url: "https://news.yahoo.co.jp/rss/categories/entertainment.xml" },
    { category: "trending", url: "https://news.yahoo.co.jp/rss/topics/top-picks.xml" },
  ],
  parseFeed(document, feed) {
    return parseRssItems(document)
      .map((entry) => toItem(entry, feed))
      .filter((item): item is NewsItem => item !== null);
  },
};
