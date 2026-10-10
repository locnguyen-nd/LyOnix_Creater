import { describe, expect, it } from "vitest";
import {
  TREND_NO_GROWTH_DATA,
  TREND_NO_METRICS,
  analysisAllowed,
  bandOf,
  clusterFor,
  dedupeTrendItems,
  normalizeHashtag,
  normalizeTrendTitle,
  normalizeTrendUrl,
  relevanceOf,
  sanitizeTrendThresholds,
  scoreTrend,
  similarProductions,
  suggestAngle,
  tiktokVideoIdOf,
  titleSimilarity,
  trendNotificationBand,
  trendNotificationKey,
  type TrendScoreInput,
} from "./trend-radar.js";

describe("normalisation", () => {
  it("canonical URLs: TikTok video, tracking params, www / m, fragments, trailing slash", () => {
    expect(normalizeTrendUrl("https://m.tiktok.com/@Some.User/video/7412345678901234567?is_from_webapp=1&sender_device=pc#x")).toBe("https://www.tiktok.com/@some.user/video/7412345678901234567");
    expect(normalizeTrendUrl("http://www.example.jp/a/b/?utm_source=x&id=3&fbclid=y")).toBe("https://example.jp/a/b?id=3");
    expect(normalizeTrendUrl("https://news.yahoo.co.jp/articles/abc123?source=rss")).toBe("https://news.yahoo.co.jp/articles/abc123");
    expect(normalizeTrendUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeTrendUrl("not a url")).toBeNull();
    expect(tiktokVideoIdOf("https://www.tiktok.com/@a/video/7412345678901234567")).toBe("7412345678901234567");
    expect(tiktokVideoIdOf("https://vm.tiktok.com/ZMabc/")).toBeNull();
  });

  it("title keys drop labels, the trailing publisher, punctuation, spaces and width differences", () => {
    expect(normalizeTrendTitle("【速報】大谷翔平が４０号ホームラン！ (スポーツ報知)")).toBe(normalizeTrendTitle("大谷翔平が40号ホームラン"));
    expect(normalizeHashtag("#ＡＮＩＭＥ")).toBe("anime");
  });

  it("similar Japanese headlines about the same story score high, different stories low", () => {
    const a = normalizeTrendTitle("大谷翔平、今季40号ホームランを放つ");
    const b = normalizeTrendTitle("大谷翔平が40号ホームラン 今季");
    const c = normalizeTrendTitle("東京で記録的な大雨 交通に影響");
    expect(titleSimilarity(a, b)).toBeGreaterThan(0.5);
    expect(titleSimilarity(a, c)).toBeLessThan(0.2);
    expect(titleSimilarity(a, a)).toBe(1);
  });
});

describe("de-duplication and clustering", () => {
  it("one run: same provider id or same canonical URL counts once", () => {
    const items = [
      { provider: "yahoo_news", sourceId: "1", canonicalUrl: "https://x/1" },
      { provider: "yahoo_news", sourceId: "1", canonicalUrl: "https://x/1-other" },
      { provider: "tiktok", sourceId: "9", canonicalUrl: "https://x/1" },
      { provider: "tiktok", sourceId: "10", canonicalUrl: "https://x/10" },
    ];
    const { unique, duplicates } = dedupeTrendItems(items);
    expect(unique.map((item) => item.sourceId)).toEqual(["1", "10"]);
    expect(duplicates).toBe(2);
  });

  it("an item joins the cluster with its URL, else the most similar title, else a shared hashtag lowers the bar; otherwise a new cluster", () => {
    const clusters = [
      { id: "c-otani", titles: [normalizeTrendTitle("大谷翔平、今季40号ホームランを放つ")], urls: ["https://news.yahoo.co.jp/articles/1"], hashtags: ["大谷翔平"] },
      { id: "c-rain", titles: [normalizeTrendTitle("東京で記録的な大雨 交通に影響")], urls: [], hashtags: [] },
    ];
    expect(clusterFor({ normalizedTitle: "x", canonicalUrl: "https://news.yahoo.co.jp/articles/1", hashtags: [] }, clusters)).toMatchObject({ clusterId: "c-otani", reason: "url" });
    expect(clusterFor({ normalizedTitle: normalizeTrendTitle("大谷翔平が40号ホームラン"), canonicalUrl: "https://a/2", hashtags: [] }, clusters)).toMatchObject({ clusterId: "c-otani", reason: "title" });
    // similarity ~0.31: below the title bar alone, enough with a shared hashtag
    expect(clusterFor({ normalizedTitle: normalizeTrendTitle("大谷翔平の40号 試合後に語ったこと"), canonicalUrl: "https://a/3", hashtags: ["#大谷翔平"] }, clusters)).toMatchObject({ clusterId: "c-otani", reason: "title_hashtag" });
    expect(clusterFor({ normalizedTitle: normalizeTrendTitle("大谷翔平の40号 試合後に語ったこと"), canonicalUrl: "https://a/3", hashtags: [] }, clusters)).toBeNull();
    expect(clusterFor({ normalizedTitle: normalizeTrendTitle("新作アニメの放送日が決定"), canonicalUrl: "https://a/4", hashtags: [] }, clusters)).toBeNull();
  });
});

const base = (over: Partial<TrendScoreInput> = {}): TrendScoreInput => ({
  now: "2026-10-10T12:00:00Z",
  publishedAt: "2026-10-10T11:00:00Z",
  firstSeenAt: "2026-10-10T11:30:00Z",
  providers: ["yahoo_news"],
  origins: ["スポーツ報知"],
  appearances: { current: 1, previous: null },
  metrics: null,
  viewsPerHour: null,
  relevance: { keywordHits: 0, hashtagHits: 0, categoryMatch: false },
  category: "sports",
  alreadyHandled: false,
  windowHours: 48,
  ...over,
});

describe("Trend Score", () => {
  it("every point has a reason; a fresh single headline without metrics stays well under Hot and says growth is not established", () => {
    const result = scoreTrend(base());
    expect(result.components.every((component) => component.reason.length > 0)).toBe(true);
    expect(result.score).toBe(25 + 0 + 0 + 0 + 0 + 4);
    expect(result.band).toBe("low");
    expect(result.components.find((c) => c.key === "momentum")).toMatchObject({ points: 0, reason: TREND_NO_GROWTH_DATA });
    expect(result.components.find((c) => c.key === "engagement")).toMatchObject({ points: 0, reason: TREND_NO_METRICS });
    expect(result.notes).toContain(TREND_NO_GROWTH_DATA);
  });

  it("a big view count from ONE measurement scores engagement but never momentum", () => {
    const result = scoreTrend(base({ providers: ["tiktok"], origins: ["@creator"], metrics: { views: 2_000_000, likes: 150_000, comments: 4_000, shares: 9_000, measuredAt: "2026-10-10T11:59:00Z" } }));
    expect(result.components.find((c) => c.key === "engagement")?.points).toBe(12 + 8);
    expect(result.components.find((c) => c.key === "momentum")?.points).toBe(0);
    expect(result.notes.join(" ")).toContain("mới có một lần đo");
  });

  it("momentum only from observations over time: appearances growing between runs, or views/hour between two measurements", () => {
    expect(scoreTrend(base({ appearances: { current: 5, previous: 2 } })).components.find((c) => c.key === "momentum")).toMatchObject({ points: 20 });
    expect(scoreTrend(base({ appearances: { current: 2, previous: 2 } })).components.find((c) => c.key === "momentum")?.points).toBe(0);
    expect(scoreTrend(base({ viewsPerHour: 30_000 })).components.find((c) => c.key === "momentum")).toMatchObject({ points: 14 });
  });

  it("several sources + growth + relevance can reach Hot; old / handled / undated content is penalised", () => {
    const hot = scoreTrend(base({ providers: ["yahoo_news", "tiktok"], origins: ["NHK", "TBS", "@creator"], appearances: { current: 6, previous: 2 }, metrics: { views: 400_000, likes: 30_000, comments: 500, shares: 900, measuredAt: "2026-10-10T11:00:00Z" }, viewsPerHour: 25_000, relevance: { keywordHits: 2, hashtagHits: 1, categoryMatch: true } }));
    expect(hot.band).toBe("hot");
    const old = scoreTrend(base({ publishedAt: "2026-10-06T00:00:00Z", alreadyHandled: true }));
    expect(old.components.find((c) => c.key === "penalty")).toMatchObject({ points: -25 });
    expect(scoreTrend(base({ publishedAt: null })).components.find((c) => c.key === "penalty")?.reason).toContain("thiếu thời gian đăng");
  });

  it("bands follow the (configurable, kept ordered) thresholds", () => {
    expect(bandOf(85)).toBe("hot");
    expect(bandOf(65)).toBe("rising");
    expect(bandOf(45)).toBe("review");
    expect(bandOf(10)).toBe("low");
    expect(bandOf(55, { hot: 70, rising: 50, review: 30 })).toBe("rising");
    expect(sanitizeTrendThresholds({ hot: 50, rising: 70, review: 90 })).toEqual({ hot: 50, rising: 49, review: 48 });
  });

  it("relevance counts the team's keywords, hashtags and categories", () => {
    expect(relevanceOf({ titles: ["新作アニメの放送日が決定"], hashtags: ["#アニメ"], category: "anime" }, { keywords: ["アニメ", "ゲーム"], hashtags: ["アニメ"], categories: ["anime"] })).toEqual({ keywordHits: 1, hashtagHits: 1, categoryMatch: true });
  });
});

describe("notifications: once per cluster per band", () => {
  it("notifies when the threshold band is reached for the first time, never again for the same or a lower band", () => {
    expect(trendNotificationBand(70, 60, [])).toBe("rising");
    expect(trendNotificationBand(72, 60, ["rising"])).toBeNull();
    expect(trendNotificationBand(85, 60, ["rising"])).toBe("hot");
    expect(trendNotificationBand(85, 60, ["hot"])).toBeNull();
    expect(trendNotificationBand(55, 60, [])).toBeNull();
    expect(trendNotificationKey("c1", "hot")).toBe("trend:c1:hot");
  });
});

describe("Gemini budget", () => {
  it("auto analyses stop at the daily auto cap; every call stops at the total cap", () => {
    const budget = { autoPerDay: 5, totalPerDay: 12 };
    expect(analysisAllowed("auto", { auto: 4, total: 4 }, budget)).toEqual({ ok: true });
    expect(analysisAllowed("auto", { auto: 5, total: 5 }, budget)).toEqual({ ok: false, reason: "auto_limit" });
    expect(analysisAllowed("manual", { auto: 5, total: 11 }, budget)).toEqual({ ok: true });
    expect(analysisAllowed("manual", { auto: 5, total: 12 }, budget)).toEqual({ ok: false, reason: "total_limit" });
  });
});

describe("duplicates with past jobs and angles for several people", () => {
  it("finds a past job with the same source or a similar title", () => {
    const past = [
      { kind: "job" as const, id: "j1", title: "大谷翔平40号ホームランの裏側", sourceUrls: [], createdAt: "2026-10-09T00:00:00Z" },
      { kind: "video_production" as const, id: "v1", title: "別の話題", sourceUrls: ["https://news.yahoo.co.jp/articles/1?source=rss"], createdAt: "2026-10-09T00:00:00Z" },
      { kind: "job" as const, id: "j2", title: "東京の大雨", sourceUrls: [], createdAt: "2026-10-09T00:00:00Z" },
    ];
    const found = similarProductions({ titles: ["大谷翔平が40号ホームラン"], urls: ["https://news.yahoo.co.jp/articles/1"] }, past);
    expect(found.map((entry) => [entry.id, entry.reason])).toEqual([["v1", "same_source"], ["j1", "similar_title"]]);
  });

  it("suggests the first angle nobody took", () => {
    expect(suggestAngle(3, [])).toBe(0);
    expect(suggestAngle(3, [0, 2])).toBe(1);
    expect(suggestAngle(3, [0, 1, 2])).toBeNull();
  });
});
