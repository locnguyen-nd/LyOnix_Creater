import { describe, expect, it, vi } from "vitest";
import { NEWS_CATEGORIES, NEWS_SOURCE_IDS } from "@lyonix/domain";
import { decodeXmlEntities, parseRssItems } from "./news-rss.js";
import { NEWS_SOURCE_ADAPTERS, NewsFeedError, fetchNewsFeedDocument, type NewsFetch } from "./news-source.js";
import { YAHOO_JAPAN_NEWS_SOURCE, splitYahooPublisher } from "./news-yahoo-japan.js";
import { RSS_WITH_DOCTYPE_ENTITY, YAHOO_CATEGORY_SPORTS_RSS, YAHOO_TOPICS_TOP_PICKS_RSS } from "./fixtures/news-feeds.js";

const sportsFeed = YAHOO_JAPAN_NEWS_SOURCE.feeds.find((feed) => feed.category === "sports")!;
const trendingFeed = YAHOO_JAPAN_NEWS_SOURCE.feeds.find((feed) => feed.category === "trending")!;

describe("VE2E-96 RSS reader", () => {
  it("reads title / link / date / image / description, unwraps CDATA and strips markup", () => {
    const items = parseRssItems(YAHOO_CATEGORY_SPORTS_RSS);
    expect(items).toHaveLength(3); // the item with an empty title is skipped
    expect(items[0]).toMatchObject({
      link: "https://news.yahoo.co.jp/articles/aaaa1111bbbb2222?source=rss",
      pubDate: "Wed, 07 Oct 2026 03:46:42 GMT",
      image: "https://newsatcl-pctr.c.yimg.jp/t/amd-img/fixture-1.jpg?pri=l&w=450&h=300",
    });
    expect(items[0]!.description).toContain('"最高峰"');
    expect(items[1]!.description).toBe("架空リーグは10月7日、 開幕週 に発生した事象について説明した。");
  });

  it("finds an item picture in enclosure / media:thumbnail / media:content", () => {
    const doc = (inner: string) => `<rss><channel><item><title>t</title><link>https://x.jp/a</link>${inner}</item></channel></rss>`;
    expect(parseRssItems(doc('<enclosure url="https://x.jp/e.jpg" type="image/jpeg" length="1"/>'))[0]!.image).toBe("https://x.jp/e.jpg");
    expect(parseRssItems(doc('<enclosure url="https://x.jp/e.mp3" type="audio/mpeg"/>'))[0]!.image).toBe("");
    expect(parseRssItems(doc("<media:thumbnail url='https://x.jp/t.jpg'/>"))[0]!.image).toBe("https://x.jp/t.jpg");
    expect(parseRssItems(doc('<media:content url="https://x.jp/c.jpg" medium="image"/>'))[0]!.image).toBe("https://x.jp/c.jpg");
  });

  it("never expands DOCTYPE entities (no XXE); decodes only the fixed named and numeric references", () => {
    expect(parseRssItems(RSS_WITH_DOCTYPE_ENTITY)[0]!.title).toBe("危険 &xxe; タイトル");
    expect(decodeXmlEntities("&lt;b&gt; &#12354; &#x3042; &amp; &unknown;")).toBe("<b> あ あ & &unknown;");
  });
});

describe("VE2E-96 Yahoo! JAPAN adapter", () => {
  it("normalises category-feed items: id from the article path, publisher split from the title, tracking param dropped", () => {
    const items = YAHOO_JAPAN_NEWS_SOURCE.parseFeed(YAHOO_CATEGORY_SPORTS_RSS, sportsFeed);
    expect(items).toHaveLength(2); // the external link is not a Yahoo! JAPAN News article
    expect(items[0]).toEqual({
      id: "yahoo_jp:articles:aaaa1111bbbb2222",
      sourceId: "yahoo_jp",
      source: "Yahoo!ニュース",
      publisher: "スポーツ架空",
      title: "架空投手が7回1失点の快投 突破に王手",
      excerpt: '◆架空リーグ 地区シリーズ第３戦 架空チームが３―１で勝利。先発投手は"最高峰"と評された（２',
      thumbnailUrl: "https://newsatcl-pctr.c.yimg.jp/t/amd-img/fixture-1.jpg?pri=l&w=450&h=300",
      sourceUrl: "https://news.yahoo.co.jp/articles/aaaa1111bbbb2222",
      publishedAt: "2026-10-07T03:46:42.000Z",
      category: "sports",
    });
    expect(items[1]).toMatchObject({ publisher: "バスケ架空", title: "架空リーグが開幕週の事象を説明「しっかり守る」" });
  });

  it("publisher = the last balanced parentheses of the title, even when the name has its own parentheses", () => {
    expect(splitYahooPublisher("農水大臣発言の調査結果(テレビ朝日系（ANN）)")).toEqual({ title: "農水大臣発言の調査結果", publisher: "テレビ朝日系（ANN）" });
    expect(splitYahooPublisher("所信表明演説を解剖する(Wedge（ウェッジ）)")).toEqual({ title: "所信表明演説を解剖する", publisher: "Wedge（ウェッジ）" });
    expect(splitYahooPublisher("再交付を受け付け (テレビ朝日系（ANN）)")).toEqual({ title: "再交付を受け付け", publisher: "テレビ朝日系（ANN）" });
    expect(splitYahooPublisher("括弧のない見出し")).toEqual({ title: "括弧のない見出し", publisher: null });
    expect(splitYahooPublisher("(全文が括弧)")).toEqual({ title: "(全文が括弧)", publisher: null });
    expect(splitYahooPublisher("閉じ忘れ）")).toEqual({ title: "閉じ忘れ）", publisher: null });
  });

  it("topics feed: headline + link only (no excerpt / thumbnail), and its titles are kept whole", () => {
    const items = YAHOO_JAPAN_NEWS_SOURCE.parseFeed(YAHOO_TOPICS_TOP_PICKS_RSS, trendingFeed);
    expect(items.map((item) => [item.id, item.title, item.publisher, item.excerpt, item.thumbnailUrl, item.category])).toEqual([
      ["yahoo_jp:pickup:6500001", "架空大臣 会見で辞任を否定", null, null, null, "trending"],
      ["yahoo_jp:pickup:6500002", "架空政府 補正予算を検討 (続報)", null, null, null, "trending"],
    ]);
  });

  it("declares one public feed per LyOnix category on news.yahoo.co.jp and links its terms", () => {
    expect(YAHOO_JAPAN_NEWS_SOURCE.feeds.map((feed) => feed.category).sort()).toEqual([...NEWS_CATEGORIES].sort());
    for (const feed of YAHOO_JAPAN_NEWS_SOURCE.feeds) expect(feed.url).toMatch(/^https:\/\/news\.yahoo\.co\.jp\/rss\/(categories|topics)\/[a-z-]+\.xml$/);
    expect(YAHOO_JAPAN_NEWS_SOURCE.termsUrl).toBe("https://news.yahoo.co.jp/rss");
    expect(NEWS_SOURCE_ADAPTERS.map((adapter) => adapter.id)).toEqual([...NEWS_SOURCE_IDS]);
  });

  it("parsing is offline: no fetch at all", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    YAHOO_JAPAN_NEWS_SOURCE.parseFeed(YAHOO_CATEGORY_SPORTS_RSS, sportsFeed);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("VE2E-96 feed fetch", () => {
  const response = (body: string, init: { ok?: boolean; status?: number; length?: string } = {}) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (name: string) => (name === "content-length" ? init.length ?? null : null) },
    text: async () => body,
  });

  it("GETs only the feed URL it was given, with an accept header for RSS", async () => {
    const fetchImpl = vi.fn<NewsFetch>(async () => response("<rss/>"));
    await expect(fetchNewsFeedDocument(sportsFeed.url, fetchImpl)).resolves.toBe("<rss/>");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(sportsFeed.url);
    expect(fetchImpl.mock.calls[0]![1].headers.accept).toContain("application/rss+xml");
  });

  it("fails with a reason on HTTP error, oversized feed, timeout, network error", async () => {
    const reason = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => (error instanceof NewsFeedError ? error.reason : "other"));
    expect(await reason(fetchNewsFeedDocument("u", async () => response("", { ok: false, status: 503 })))).toBe("http_error");
    expect(await reason(fetchNewsFeedDocument("u", async () => response("", { length: "9999999" })))).toBe("too_large");
    expect(await reason(fetchNewsFeedDocument("u", async () => response("x".repeat(20)), { timeoutMs: 1000, maxBytes: 10 }))).toBe("too_large");
    expect(await reason(fetchNewsFeedDocument("u", async () => { throw new Error("ECONNRESET"); }))).toBe("network");
    const hanging: NewsFetch = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(await reason(fetchNewsFeedDocument("u", hanging, { timeoutMs: 20, maxBytes: 100 }))).toBe("timeout");
  });
});
