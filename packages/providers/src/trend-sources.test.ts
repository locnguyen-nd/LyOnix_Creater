import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { YAHOO_CATEGORY_SPORTS_RSS, YAHOO_TOPICS_TOP_PICKS_RSS } from "./fixtures/news-feeds.js";
import {
  TrendImportError,
  buildTikTokTrendInput,
  collectTikTokTrends,
  collectYahooTrends,
  fetchTikTokOembed,
  manualTikTokItem,
  normalizeTikTokTrendItem,
  type TikTokTrendRunner,
} from "./trend-sources.js";
import type { NewsFetch } from "./news-source.js";

// Fixtures only: nothing here reaches Yahoo, Apify or TikTok.
const respond = (status: number, body: string) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body });

describe("Yahoo!ニュース source (fixtures)", () => {
  it("reads the enabled feeds as headline (+ excerpt) items; a failing feed is reported and the others still count", async () => {
    const fetch: NewsFetch = vi.fn(async (url: string) => {
      if (url.includes("sports")) return respond(200, YAHOO_CATEGORY_SPORTS_RSS);
      if (url.includes("top-picks")) return respond(200, YAHOO_TOPICS_TOP_PICKS_RSS);
      return respond(503, "down");
    });
    const outcome = await collectYahooTrends({ fetch, categories: ["sports", "trending", "japan"] });
    expect(outcome.units.find((unit) => unit.unit === "yahoo:japan")).toMatchObject({ ok: false, error: { code: "FEED_HTTP_ERROR" } });
    expect(outcome.units.filter((unit) => unit.ok).map((unit) => unit.unit).sort()).toEqual(["yahoo:sports", "yahoo:trending"]);
    const sports = outcome.items.find((item) => item.category === "sports")!;
    expect(sports).toMatchObject({ provider: "yahoo_news", publisher: "スポーツ架空", metrics: null, completeness: "headline_excerpt" });
    expect(sports.url.startsWith("https://news.yahoo.co.jp/articles/")).toBe(true);
    expect(outcome.items.some((item) => item.completeness === "headline_only")).toBe(true); // topics feed: headline only
    expect(outcome.items.every((item) => item.metrics === null)).toBe(true);
    // the article page is never requested: only the feed URLs
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.every(([url]) => /\/rss\//.test(url as string))).toBe(true);
  });

  it("retries a timed-out feed once", async () => {
    let calls = 0;
    const fetch: NewsFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return respond(200, YAHOO_CATEGORY_SPORTS_RSS);
    });
    const outcome = await collectYahooTrends({ fetch, categories: ["sports"] });
    expect(calls).toBe(2);
    expect(outcome.units).toEqual([expect.objectContaining({ unit: "yahoo:sports", ok: true })]);
  });
});

// shaped like clockworks/tiktok-scraper dataset items (field names from the Actor's published output schema; values made up)
const actorItem = (over: Record<string, unknown> = {}) => ({
  id: "7412345678901234567",
  text: "新作アニメの放送日が決定！ #アニメ #新作",
  createTimeISO: "2026-10-10T08:00:00.000Z",
  authorMeta: { name: "anime_fan_jp", profileUrl: "https://www.tiktok.com/@anime_fan_jp" },
  webVideoUrl: "https://www.tiktok.com/@anime_fan_jp/video/7412345678901234567?is_from_webapp=1",
  videoMeta: { coverUrl: "https://p16-sign.tiktokcdn.com/cover.jpg", duration: 21 },
  playCount: 512000,
  diggCount: 41000,
  commentCount: 900,
  shareCount: 2100,
  hashtags: [{ name: "アニメ" }, "新作"],
  ...over,
});

describe("TikTok source (Apify, fixtures - no Actor run)", () => {
  it("search-only input: Japan, no video / cover downloads; a hashtag goes to `hashtags`", () => {
    expect(buildTikTokTrendInput({ kind: "keyword", value: " アニメ 新作 " }, 20)).toMatchObject({ searchQueries: ["アニメ 新作"], searchSection: "/video", resultsPerPage: 20, proxyCountryCode: "JP", shouldDownloadVideos: false, shouldDownloadCovers: false });
    expect(buildTikTokTrendInput({ kind: "hashtag", value: "#アニメ" }, 10)).toMatchObject({ hashtags: ["アニメ"], shouldDownloadVideos: false });
  });

  it("keeps exactly the metrics the Actor returned; a missing field stays null; ads / broken items are dropped", () => {
    const item = normalizeTikTokTrendItem(actorItem(), "2026-10-10T09:00:00.000Z")!;
    expect(item).toMatchObject({
      provider: "tiktok",
      sourceId: "7412345678901234567",
      url: "https://www.tiktok.com/@anime_fan_jp/video/7412345678901234567",
      author: "@anime_fan_jp",
      publishedAt: "2026-10-10T08:00:00.000Z",
      hashtags: ["アニメ", "新作"],
      metrics: { views: 512000, likes: 41000, comments: 900, shares: 2100, measuredAt: "2026-10-10T09:00:00.000Z" },
      completeness: "with_metrics",
    });
    const partial = normalizeTikTokTrendItem(actorItem({ playCount: undefined, shareCount: "n/a" }), "2026-10-10T09:00:00.000Z")!;
    expect(partial.metrics).toMatchObject({ views: null, shares: null, likes: 41000 });
    const none = normalizeTikTokTrendItem(actorItem({ playCount: undefined, diggCount: undefined, commentCount: undefined, shareCount: undefined }), "x")!;
    expect(none.metrics).toBeNull();
    expect(none.completeness).toBe("embed_metadata");
    expect(normalizeTikTokTrendItem(actorItem({ isAd: true }), "x")).toBeNull();
    expect(normalizeTikTokTrendItem({ error: "blocked" }, "x")).toBeNull();
    expect(normalizeTikTokTrendItem(actorItem({ webVideoUrl: "https://evil.example/video/1", id: "abc" }), "x")).toBeNull();
  });

  it("PROVIDER_QUOTA_EXHAUSTED stops the source (no further paid query); another query error is recorded and the next query runs", async () => {
    const quota: TikTokTrendRunner = vi.fn(async () => {
      throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED", "not-enough-usage-to-run-paid-actor", false);
    });
    const stopped = await collectTikTokTrends({ token: "t", queries: [{ kind: "keyword", value: "アニメ" }, { kind: "hashtag", value: "ゲーム" }], limit: 10, maxQueries: 5, timeoutSecs: 60, run: quota, now: () => new Date() });
    expect(quota).toHaveBeenCalledTimes(1);
    expect(stopped.stopped).toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" });
    expect(stopped.items).toEqual([]);

    let call = 0;
    const flaky: TikTokTrendRunner = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new ProviderError("PROVIDER_TIMEOUT", "run timed out", true);
      return { runId: "r2", items: [actorItem()] };
    });
    const mixed = await collectTikTokTrends({ token: "t", queries: [{ kind: "keyword", value: "a" }, { kind: "keyword", value: "アニメ" }, { kind: "keyword", value: "c" }], limit: 10, maxQueries: 2, timeoutSecs: 60, run: flaky, now: () => new Date("2026-10-10T09:00:00Z") });
    expect(flaky).toHaveBeenCalledTimes(2); // maxQueries bounds the paid calls
    expect(mixed.stopped).toBeNull();
    expect(mixed.units.map((unit) => [unit.unit, unit.ok])).toEqual([["tiktok:keyword:a", false], ["tiktok:keyword:アニメ", true]]);
    expect(mixed.items[0]!.keywords).toEqual(["アニメ"]);
  });
});

describe("manual TikTok URL (oEmbed, fixtures)", () => {
  it("keeps only the fields oEmbed returned (title / author / thumbnail), no metrics", async () => {
    const fetch: NewsFetch = vi.fn(async (url: string) => {
      expect(url.startsWith("https://www.tiktok.com/oembed?url=")).toBe(true);
      return respond(200, JSON.stringify({ version: "1.0", type: "video", title: "テスト動画 #アニメ", author_name: "creator_jp", author_url: "https://www.tiktok.com/@creator_jp", thumbnail_url: "https://p16.tiktokcdn.com/t.jpg", html: "<blockquote/>" }));
    });
    const oembed = await fetchTikTokOembed("https://www.tiktok.com/@creator_jp/video/7412345678901234567", fetch);
    expect(oembed).toEqual({ title: "テスト動画 #アニメ", authorName: "creator_jp", authorUrl: "https://www.tiktok.com/@creator_jp", thumbnailUrl: "https://p16.tiktokcdn.com/t.jpg" });
    const item = manualTikTokItem("https://www.tiktok.com/@creator_jp/video/7412345678901234567", oembed);
    expect(item).toMatchObject({ provider: "manual", sourceId: "tiktok:7412345678901234567", author: "@creator_jp", hashtags: ["アニメ"], metrics: null, completeness: "embed_metadata" });
  });

  it("404 / HTTP error / timeout become clear import errors; without oEmbed the user's URL is still kept", async () => {
    await expect(fetchTikTokOembed("https://www.tiktok.com/@a/video/1234567890", vi.fn(async () => respond(404, "")))).rejects.toMatchObject({ code: "OEMBED_NOT_FOUND" });
    await expect(fetchTikTokOembed("https://www.tiktok.com/@a/video/1234567890", vi.fn(async () => respond(500, "")))).rejects.toMatchObject({ code: "OEMBED_UNAVAILABLE" });
    const hanging: NewsFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(fetchTikTokOembed("https://www.tiktok.com/@a/video/1234567890", hanging, 20)).rejects.toBeInstanceOf(TrendImportError);
    expect(manualTikTokItem("https://www.tiktok.com/@a/video/1234567890", null)).toMatchObject({ title: "TikTok 1234567890", metrics: null, completeness: "user_supplied" });
  });
});
