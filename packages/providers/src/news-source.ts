/**
 * VE2E-96: news-source adapters. An adapter names its public feeds (one per LyOnix category) and turns a feed document into normalised
 * `NewsItem`s; it never fetches an article page. Adding NHK / Nikkei / ... = one more adapter + its id in `@lyonix/domain` NEWS_SOURCE_IDS,
 * registered in NEWS_SOURCE_ADAPTERS. Fetching is a separate, injectable step (`fetchNewsFeedDocument`) so parsing stays pure and tested
 * offline.
 */
import type { NewsCategory, NewsItem, NewsSourceId } from "@lyonix/domain";
import { YAHOO_JAPAN_NEWS_SOURCE } from "./news-yahoo-japan.js";

export type NewsSourceFeed = { category: NewsCategory; url: string };

export type NewsSourceAdapter = {
  id: NewsSourceId;
  label: string;
  homepageUrl: string;
  /** Where the source states how its feeds may be used: an operator must accept these terms before enabling the source. */
  termsUrl: string;
  feeds: readonly NewsSourceFeed[];
  /** One feed document -> normalised, valid items in feed order (invalid entries skipped). No network. */
  parseFeed(document: string, feed: NewsSourceFeed): NewsItem[];
};

/** Every adapter LyOnix has. Which ones run is decided by configuration (`NEWS_SOURCES`), never by this list. */
export const NEWS_SOURCE_ADAPTERS: readonly NewsSourceAdapter[] = [YAHOO_JAPAN_NEWS_SOURCE];

export type NewsFetchResponse = { ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> };
export type NewsFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: "follow" }) => Promise<NewsFetchResponse>;

export class NewsFeedError extends Error {
  constructor(readonly reason: "timeout" | "http_error" | "too_large" | "network", message: string) {
    super(message);
  }
}

export const NEWS_FEED_LIMITS = { timeoutMs: 8_000, maxBytes: 1_500_000 } as const;

/** GET one feed document (headlines only), with a timeout and a size cap. Throws NewsFeedError. */
export async function fetchNewsFeedDocument(url: string, fetchImpl: NewsFetch, limits: { timeoutMs: number; maxBytes: number } = NEWS_FEED_LIMITS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow", headers: { accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8", "user-agent": "LyOnix-NewsFeed/1.0" } });
    if (!response.ok) throw new NewsFeedError("http_error", `HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > limits.maxBytes) throw new NewsFeedError("too_large", `feed larger than ${limits.maxBytes} bytes`);
    const body = await response.text();
    if (body.length > limits.maxBytes) throw new NewsFeedError("too_large", `feed larger than ${limits.maxBytes} bytes`);
    return body;
  } catch (error) {
    if (error instanceof NewsFeedError) throw error;
    if (controller.signal.aborted) throw new NewsFeedError("timeout", `no answer within ${limits.timeoutMs} ms`);
    throw new NewsFeedError("network", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
