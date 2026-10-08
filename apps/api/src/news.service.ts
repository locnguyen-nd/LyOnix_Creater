/**
 * VE2E-96: the news feed of the create-video page. Reads the public feeds of the ENABLED news sources only (`NEWS_SOURCES`, comma-separated
 * adapter ids; empty = none - every source has terms an operator must accept first), caches each feed, then filters / searches / dedupes /
 * sorts. Headlines only: an article page is never requested, nothing is stored, no AI / paid provider is called.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  NEWS_LIMITS,
  dedupeNewsItems,
  isNewsSourceId,
  newsFilterScope,
  newsMatchesQuery,
  normalizeNewsUrl,
  normalizeNewsQuery,
  sortNewsItems,
  type NewsFilter,
  type NewsItem,
  type NewsSourceId,
} from "@lyonix/domain";
import { NEWS_SOURCE_ADAPTERS, NewsFeedError, fetchNewsFeedDocument, type NewsFetch, type NewsSourceAdapter, type NewsSourceFeed } from "@lyonix/providers";
import type { NewsFeedResponse, NewsSourceStatusResponse } from "@lyonix/contracts";

/** A feed is read again at most every 10 minutes, whoever asks. */
export const NEWS_FEED_TTL_MS = 10 * 60_000;
/** After a failure the feed is not retried for a minute (a stale copy, when there is one, is served meanwhile). */
export const NEWS_FEED_RETRY_MS = 60_000;

export const NEWS_SERVICE_OPTIONS = "NEWS_SERVICE_OPTIONS";
export type NewsServiceOptions = { fetch?: NewsFetch; now?: () => number; adapters?: readonly NewsSourceAdapter[]; enabledSources?: () => string | undefined };

/** Adapter ids from `NEWS_SOURCES` ("yahoo_jp,nhk"); unknown ids are ignored. */
export const enabledNewsSourceIds = (raw: string | undefined): Set<NewsSourceId> =>
  new Set((raw ?? "").split(",").map((value) => value.trim()).filter(isNewsSourceId));

type FeedState = { items: NewsItem[]; fetchedAt: number | null; error: string | null; failedAt: number | null };

const defaultFetch: NewsFetch = (url, init) => fetch(url, init);

@Injectable()
export class NewsService {
  private readonly cache = new Map<string, FeedState>();
  private readonly inflight = new Map<string, Promise<FeedState>>();
  private readonly fetchImpl: NewsFetch;
  private readonly now: () => number;
  private readonly adapters: readonly NewsSourceAdapter[];
  private readonly enabledSources: () => string | undefined;

  constructor(@Optional() @Inject(NEWS_SERVICE_OPTIONS) options?: NewsServiceOptions) {
    this.fetchImpl = options?.fetch ?? defaultFetch;
    this.now = options?.now ?? Date.now;
    this.adapters = options?.adapters ?? NEWS_SOURCE_ADAPTERS;
    this.enabledSources = options?.enabledSources ?? (() => process.env.NEWS_SOURCES);
  }

  async feed(input: { filter: NewsFilter; query: string }): Promise<NewsFeedResponse> {
    const enabled = enabledNewsSourceIds(this.enabledSources());
    const scope = newsFilterScope(input.filter);
    const query = normalizeNewsQuery(input.query);
    const sources: NewsSourceStatusResponse[] = [];
    const items: NewsItem[] = [];

    await Promise.all(
      this.adapters.map(async (adapter) => {
        const status: NewsSourceStatusResponse = { id: adapter.id, label: adapter.label, status: "disabled", termsUrl: adapter.termsUrl, message: null };
        sources.push(status);
        if (!enabled.has(adapter.id)) return;
        const feeds = adapter.feeds.filter((feed) => (!scope.sourceId || scope.sourceId === adapter.id) && (!scope.category || scope.category === feed.category));
        const states = await Promise.all(feeds.map((feed) => this.feedState(adapter, feed)));
        const failed = states.filter((state) => state.error);
        status.status = feeds.length > 0 && failed.length === feeds.length && states.every((state) => state.items.length === 0) ? "error" : failed.length > 0 ? "partial" : "ok";
        status.message = failed[0]?.error ?? null;
        for (const state of states) items.push(...state.items);
      }),
    );

    const matching = items.filter((item) => newsMatchesQuery(item, query));
    return {
      filter: input.filter,
      query,
      items: dedupeNewsItems(sortNewsItems(matching)).slice(0, NEWS_LIMITS.maxItems),
      sources: sources.sort((a, b) => a.id.localeCompare(b.id)),
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * A pasted article URL of a news source, looked up in that source's feeds (same cache) - never by fetching the article page.
   * `source_disabled` when the source is not enabled (nothing is read), `not_found` when no current feed item has that URL.
   */
  async findByUrl(sourceId: NewsSourceId, rawUrl: string): Promise<{ status: "found"; item: NewsItem } | { status: "source_disabled" } | { status: "not_found" }> {
    const adapter = this.adapters.find((candidate) => candidate.id === sourceId);
    if (!adapter || !enabledNewsSourceIds(this.enabledSources()).has(sourceId)) return { status: "source_disabled" };
    const target = normalizeNewsUrl(rawUrl);
    if (!target) return { status: "not_found" };
    const states = await Promise.all(adapter.feeds.map((feed) => this.feedState(adapter, feed)));
    const matches = dedupeNewsItems(sortNewsItems(states.flatMap((state) => state.items))).filter((item) => normalizeNewsUrl(item.sourceUrl) === target);
    return matches[0] ? { status: "found", item: matches[0] } : { status: "not_found" };
  }

  /** The feed's items: from the cache while fresh, else read again (one request per feed at a time); a failure keeps the stale copy. */
  private async feedState(adapter: NewsSourceAdapter, feed: NewsSourceFeed): Promise<FeedState> {
    const key = `${adapter.id} ${feed.url}`;
    const cached = this.cache.get(key);
    const now = this.now();
    if (cached?.fetchedAt !== null && cached?.fetchedAt !== undefined && now - cached.fetchedAt < NEWS_FEED_TTL_MS) return cached;
    if (cached?.failedAt !== null && cached?.failedAt !== undefined && now - cached.failedAt < NEWS_FEED_RETRY_MS) return cached;
    const running = this.inflight.get(key);
    if (running) return running;
    const task = (async (): Promise<FeedState> => {
      try {
        const document = await fetchNewsFeedDocument(feed.url, this.fetchImpl);
        const state: FeedState = { items: adapter.parseFeed(document, feed), fetchedAt: this.now(), error: null, failedAt: null };
        this.cache.set(key, state);
        return state;
      } catch (error) {
        const reason = error instanceof NewsFeedError ? error.reason : "parse_error";
        const state: FeedState = { items: cached?.items ?? [], fetchedAt: cached?.fetchedAt ?? null, error: `${feed.category}: ${reason}`, failedAt: this.now() };
        this.cache.set(key, state);
        return state;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }
}
