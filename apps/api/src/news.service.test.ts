import { describe, expect, it, vi } from "vitest";
import { YAHOO_JAPAN_NEWS_SOURCE, type NewsFetch } from "@lyonix/providers";
import { NEWS_FEED_RETRY_MS, NEWS_FEED_TTL_MS, NewsService, enabledNewsSourceIds } from "./news.service.js";

const feedUrl = (category: string) => YAHOO_JAPAN_NEWS_SOURCE.feeds.find((feed) => feed.category === category)!.url;
const FEED_URLS = new Set(YAHOO_JAPAN_NEWS_SOURCE.feeds.map((feed) => feed.url));

const rss = (items: Array<{ id: string; title: string; minutes: number; image?: string; description?: string; pickup?: boolean }>) =>
  `<rss><channel>${items
    .map((item) => `<item><title>${item.title}</title><link>https://news.yahoo.co.jp/${item.pickup ? "pickup" : "articles"}/${item.id}?source=rss</link><pubDate>${new Date(Date.UTC(2026, 9, 7, 3, item.minutes)).toUTCString()}</pubDate>${item.image ? `<image>${item.image}</image>` : ""}${item.description ? `<description>${item.description}</description>` : ""}</item>`)
    .join("")}</channel></rss>`;

const FEEDS: Record<string, string> = {
  [feedUrl("japan")]: rss([{ id: "jp1", title: "国会で補正予算 (架空通信)", minutes: 30, image: "https://img.test/jp1.jpg", description: "補正予算の審議" }]),
  [feedUrl("sports")]: rss([
    { id: "sp1", title: "架空投手が快投 (スポーツ架空)", minutes: 40, image: "https://img.test/sp1.jpg" },
    { id: "sp2", title: "ＮＨＫ杯で首位 (スポーツ架空)", minutes: 10 },
  ]),
  [feedUrl("entertainment")]: rss([{ id: "en1", title: "新作映画が公開 (芸能架空)", minutes: 20 }, { id: "sp1", title: "架空投手が快投 (別媒体)", minutes: 45 }]),
  [feedUrl("trending")]: rss([{ id: "6500001", title: "主要: 架空大臣が会見", minutes: 50, pickup: true }]),
};

const setup = (opts: { enabled?: string | undefined; fail?: Set<string>; now?: { value: number } } = {}) => {
  const clock = opts.now ?? { value: Date.UTC(2026, 9, 7, 4, 0) };
  const fetchImpl = vi.fn<NewsFetch>(async (url) => {
    if (opts.fail?.has(url)) return { ok: false, status: 503, headers: { get: () => null }, text: async () => "" };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => FEEDS[url] ?? "<rss/>" };
  });
  const service = new NewsService({ fetch: fetchImpl, now: () => clock.value, enabledSources: () => opts.enabled });
  return { service, fetchImpl, clock };
};
const ids = (response: { items: Array<{ id: string }> }) => response.items.map((item) => item.id);

describe("VE2E-96 news feed service", () => {
  it("every source is OFF unless NEWS_SOURCES enables it: no request at all, the source is reported as disabled", async () => {
    const { service, fetchImpl } = setup({ enabled: undefined });
    const response = await service.feed({ filter: "all", query: "" });
    expect(response.items).toEqual([]);
    expect(response.sources).toEqual([{ id: "yahoo_jp", label: "Yahoo!ニュース", status: "disabled", termsUrl: "https://news.yahoo.co.jp/rss", message: null }]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect([...enabledNewsSourceIds(" yahoo_jp , nikkei,,")]).toEqual(["yahoo_jp"]);
  });

  it("all: reads every feed of the source, newest first, one item per story", async () => {
    const { service, fetchImpl } = setup({ enabled: "yahoo_jp" });
    const response = await service.feed({ filter: "all", query: "" });
    expect(new Set(fetchImpl.mock.calls.map(([url]) => url))).toEqual(FEED_URLS);
    expect(ids(response)).toEqual(["yahoo_jp:pickup:6500001", "yahoo_jp:articles:sp1", "yahoo_jp:articles:jp1", "yahoo_jp:articles:en1", "yahoo_jp:articles:sp2"]);
    // the duplicate of sp1 from another feed is dropped; the kept one has the thumbnail
    expect(response.items[1]).toMatchObject({ thumbnailUrl: "https://img.test/sp1.jpg", sourceUrl: "https://news.yahoo.co.jp/articles/sp1" });
    expect(response.sources[0]).toMatchObject({ status: "ok", message: null });
  });

  it("a category filter reads only that feed; the source filter reads all of its feeds", async () => {
    const sports = setup({ enabled: "yahoo_jp" });
    const response = await sports.service.feed({ filter: "sports", query: "" });
    expect(sports.fetchImpl.mock.calls.map(([url]) => url)).toEqual([feedUrl("sports")]);
    expect(response.items.every((item) => item.category === "sports")).toBe(true);
    const source = setup({ enabled: "yahoo_jp" });
    await source.service.feed({ filter: "yahoo_jp", query: "" });
    expect(source.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("search matches every word, width-insensitive", async () => {
    const { service } = setup({ enabled: "yahoo_jp" });
    expect(ids(await service.feed({ filter: "all", query: "nhk 首位" }))).toEqual(["yahoo_jp:articles:sp2"]);
    expect((await service.feed({ filter: "all", query: "存在しない語" })).items).toEqual([]);
  });

  it("caches each feed for 10 minutes; concurrent requests share one fetch", async () => {
    const { service, fetchImpl, clock } = setup({ enabled: "yahoo_jp" });
    await Promise.all([service.feed({ filter: "sports", query: "" }), service.feed({ filter: "sports", query: "" })]);
    await service.feed({ filter: "sports", query: "架空" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.value += NEWS_FEED_TTL_MS;
    await service.feed({ filter: "sports", query: "" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a failing feed: partial (the others still shown), all failing: error; the stale copy is kept and retried after a minute", async () => {
    const fail = new Set([feedUrl("sports")]);
    const partial = setup({ enabled: "yahoo_jp", fail });
    const response = await partial.service.feed({ filter: "all", query: "" });
    expect(response.sources[0]).toMatchObject({ status: "partial", message: "sports: http_error" });
    expect(ids(response)).not.toContain("yahoo_jp:articles:sp2");

    const clock = { value: Date.UTC(2026, 9, 7, 4, 0) };
    const broken = new Set<string>();
    const stale = setup({ enabled: "yahoo_jp", fail: broken, now: clock });
    await stale.service.feed({ filter: "sports", query: "" });
    clock.value += NEWS_FEED_TTL_MS;
    broken.add(feedUrl("sports"));
    const afterFailure = await stale.service.feed({ filter: "sports", query: "" });
    expect(afterFailure.sources[0]).toMatchObject({ status: "partial" });
    expect(ids(afterFailure)).toEqual(["yahoo_jp:articles:sp1", "yahoo_jp:articles:sp2"]);
    await stale.service.feed({ filter: "sports", query: "" });
    expect(stale.fetchImpl).toHaveBeenCalledTimes(2); // not retried within NEWS_FEED_RETRY_MS
    clock.value += NEWS_FEED_RETRY_MS;
    broken.clear();
    expect((await stale.service.feed({ filter: "sports", query: "" })).sources[0]).toMatchObject({ status: "ok" });

    const allDown = setup({ enabled: "yahoo_jp", fail: new Set(FEED_URLS) });
    const down = await allDown.service.feed({ filter: "all", query: "" });
    expect(down.sources[0]!.status).toBe("error");
    expect(down.items).toEqual([]);
  });

  it("only ever requests the source's own feed URLs - never an article page", async () => {
    const { service, fetchImpl } = setup({ enabled: "yahoo_jp" });
    const response = await service.feed({ filter: "all", query: "" });
    expect(response.items.length).toBeGreaterThan(0);
    for (const [url] of fetchImpl.mock.calls) expect(FEED_URLS.has(url), url).toBe(true);
    for (const item of response.items) expect(fetchImpl.mock.calls.some(([url]) => url === item.sourceUrl)).toBe(false);
  });
});
