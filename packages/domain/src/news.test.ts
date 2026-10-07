import { describe, expect, it } from "vitest";
import {
  NEWS_FILTERS,
  NEWS_TOPIC_MAX_CHARS,
  composeNewsTopic,
  dedupeNewsItems,
  newsFilterScope,
  newsMatchesFilter,
  newsMatchesQuery,
  normalizeNewsUrl,
  parseSelectedNews,
  sanitizeNewsItem,
  serializeSelectedNews,
  sortNewsItems,
  type NewsItem,
} from "./news.js";
import { classifyIntakeUrl } from "./url-intake.js";
import { CREATION_CONTENT_KEYS, CREATION_PREFERENCE_KEYS, sanitizeCreationPreferences, sanitizeJobNewDraft } from "./creation-form.js";

const item = (overrides: Partial<NewsItem> = {}): NewsItem => ({
  id: "yahoo_jp:a1",
  sourceId: "yahoo_jp",
  source: "Yahoo!ニュース",
  publisher: "スポーツ報知",
  title: "山本由伸が7回1失点",
  excerpt: "ドジャースが突破に王手",
  thumbnailUrl: "https://img.example.jp/a1.jpg",
  sourceUrl: "https://news.yahoo.co.jp/articles/a1?source=rss",
  publishedAt: "2026-10-07T03:46:42.000Z",
  category: "sports",
  ...overrides,
});

describe("VE2E-96 news URL normalisation", () => {
  it("drops tracking parameters, the fragment and a trailing slash; lowercases the host", () => {
    expect(normalizeNewsUrl("https://News.Yahoo.co.jp/articles/a1/?source=rss&utm_medium=x#top")).toBe("https://news.yahoo.co.jp/articles/a1");
    expect(normalizeNewsUrl("https://news.yahoo.co.jp/pickup/6597854?page=2&source=rss")).toBe("https://news.yahoo.co.jp/pickup/6597854?page=2");
  });

  it("rejects what is not a plain web URL", () => {
    for (const raw of ["javascript:alert(1)", "ftp://x.jp/a", "not a url", "https://user:pw@x.jp/", ""]) expect(normalizeNewsUrl(raw), raw).toBeNull();
  });
});

describe("VE2E-96 dedupe / sort / search / filter", () => {
  it("deduplicates by id and by normalised URL, keeping the first and filling its missing excerpt / thumbnail", () => {
    const first = item({ id: "yahoo_jp:a1", excerpt: null, thumbnailUrl: null });
    const sameUrl = item({ id: "yahoo_jp:other", sourceUrl: "https://news.yahoo.co.jp/articles/a1", excerpt: "抜粋", category: "trending" });
    const sameId = item({ sourceUrl: "https://news.yahoo.co.jp/articles/zzz" });
    const different = item({ id: "yahoo_jp:b2", sourceUrl: "https://news.yahoo.co.jp/articles/b2" });
    const out = dedupeNewsItems([first, sameUrl, sameId, different]);
    expect(out.map((row) => row.id)).toEqual(["yahoo_jp:a1", "yahoo_jp:b2"]);
    expect(out[0]).toMatchObject({ category: "sports", excerpt: "抜粋", thumbnailUrl: "https://img.example.jp/a1.jpg" });
  });

  it("sorts newest first, undated last, stable otherwise", () => {
    const rows = [item({ id: "a", publishedAt: null }), item({ id: "b", publishedAt: "2026-10-07T01:00:00.000Z" }), item({ id: "c", publishedAt: "2026-10-07T05:00:00.000Z" }), item({ id: "d", publishedAt: null })];
    expect(sortNewsItems(rows).map((row) => row.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("search: every word, case- and width-insensitive (NFKC), over title / excerpt / publisher / source", () => {
    const row = item({ title: "ＮＨＫ杯 フィギュア", excerpt: "Shoma Uno が首位" });
    expect(newsMatchesQuery(row, "nhk 首位")).toBe(true);
    expect(newsMatchesQuery(row, "SHOMA")).toBe(true);
    expect(newsMatchesQuery(row, "報知")).toBe(true);
    expect(newsMatchesQuery(row, "nhk 野球")).toBe(false);
    expect(newsMatchesQuery(row, "   ")).toBe(true);
  });

  it("filters: all, one source, one category", () => {
    expect(NEWS_FILTERS).toEqual(["all", "yahoo_jp", "japan", "sports", "entertainment", "trending"]);
    expect(newsFilterScope("yahoo_jp")).toEqual({ sourceId: "yahoo_jp", category: null });
    expect(newsFilterScope("sports")).toEqual({ sourceId: null, category: "sports" });
    expect(newsMatchesFilter(item(), "all")).toBe(true);
    expect(newsMatchesFilter(item(), "yahoo_jp")).toBe(true);
    expect(newsMatchesFilter(item(), "sports")).toBe(true);
    expect(newsMatchesFilter(item(), "entertainment")).toBe(false);
  });
});

describe("VE2E-96 news item validation", () => {
  it("keeps a valid item, cleaning and capping its text", () => {
    const out = sanitizeNewsItem({ ...item(), title: `  山本\n\t由伸 ${"あ".repeat(400)} `, extra: "dropped" });
    expect(out!.title.startsWith("山本 由伸 ")).toBe(true);
    expect([...out!.title]).toHaveLength(300);
    expect(out).not.toHaveProperty("extra");
  });

  it("rejects an item without https link, title, known source or category; drops a non-https thumbnail and a bad date", () => {
    expect(sanitizeNewsItem({ ...item(), sourceUrl: "http://news.yahoo.co.jp/a" })).toBeNull();
    expect(sanitizeNewsItem({ ...item(), sourceUrl: "javascript:alert(1)" })).toBeNull();
    expect(sanitizeNewsItem({ ...item(), title: " " })).toBeNull();
    expect(sanitizeNewsItem({ ...item(), sourceId: "nikkei" })).toBeNull();
    expect(sanitizeNewsItem({ ...item(), category: "world" })).toBeNull();
    expect(sanitizeNewsItem({ ...item(), thumbnailUrl: "http://img/x.jpg", publishedAt: "yesterday" })).toMatchObject({ thumbnailUrl: null, publishedAt: null });
  });
});

describe("VE2E-96 picking a news item for the video", () => {
  it("the topic is the headline, the feed excerpt and the named source with its link - nothing else", () => {
    expect(composeNewsTopic(item())).toBe("山本由伸が7回1失点\n\nドジャースが突破に王手\n\nSource: スポーツ報知 / Yahoo!ニュース - https://news.yahoo.co.jp/articles/a1?source=rss");
    expect(composeNewsTopic(item({ excerpt: null, publisher: null }))).toBe("山本由伸が7回1失点\n\nSource: Yahoo!ニュース - https://news.yahoo.co.jp/articles/a1?source=rss");
  });

  it("is stored in the draft (content), never in the user's defaults, and survives the draft whitelist", () => {
    expect(CREATION_CONTENT_KEYS).toContain("selectedNews");
    expect(CREATION_PREFERENCE_KEYS as readonly string[]).not.toContain("selectedNews");
    const stored = serializeSelectedNews(item());
    expect(parseSelectedNews(sanitizeJobNewDraft({ selectedNews: stored }).selectedNews ?? "")).toEqual(item());
    expect(sanitizeCreationPreferences({ selectedNews: stored })).toEqual({});
    expect(parseSelectedNews("")).toBeNull();
    expect(parseSelectedNews("{not json")).toBeNull();
    expect(parseSelectedNews(JSON.stringify({ ...item(), sourceUrl: "javascript:x" }))).toBeNull();
  });
});

describe("VE2E-96 topic length", () => {
  it("a topic made from a news item never exceeds the 400-character topic source limit; the named source stays", () => {
    const long = item({ title: "見".repeat(300), excerpt: "概".repeat(400) });
    const topic = composeNewsTopic(long);
    expect([...topic].length).toBeLessThanOrEqual(NEWS_TOPIC_MAX_CHARS);
    expect(topic.startsWith("見".repeat(200))).toBe(true);
    expect(topic.endsWith("Source: スポーツ報知 / Yahoo!ニュース - https://news.yahoo.co.jp/articles/a1?source=rss")).toBe(true);
    const noExcerpt = composeNewsTopic(item({ title: "見".repeat(300), excerpt: null }));
    expect([...noExcerpt].length).toBeLessThanOrEqual(NEWS_TOPIC_MAX_CHARS);
    expect(noExcerpt).toContain("Source: スポーツ報知 / Yahoo!ニュース");
    const hugeLink = composeNewsTopic(item({ sourceUrl: `https://news.yahoo.co.jp/articles/${"a".repeat(1500)}` }));
    expect([...hugeLink].length).toBeLessThanOrEqual(NEWS_TOPIC_MAX_CHARS);
    expect(hugeLink.endsWith("Source: スポーツ報知 / Yahoo!ニュース")).toBe(true);
  });
});

describe("VE2E-96 URL intake", () => {
  it("classifies TikTok, Yahoo! JAPAN News and any other page as an article; adds https to a bare host", () => {
    expect(classifyIntakeUrl("https://www.tiktok.com/@user/video/123")).toMatchObject({ ok: true, kind: "tiktok" });
    expect(classifyIntakeUrl("vt.tiktok.com/ZSabc/")).toEqual({ ok: true, kind: "tiktok", url: "https://vt.tiktok.com/ZSabc/" });
    expect(classifyIntakeUrl(" https://news.yahoo.co.jp/articles/abc?source=rss ")).toMatchObject({ ok: true, kind: "yahoo_news" });
    expect(classifyIntakeUrl("https://www3.nhk.or.jp/news/html/20261007/k1.html")).toMatchObject({ ok: true, kind: "article" });
    expect(classifyIntakeUrl("https://faketiktok.com/a")).toMatchObject({ kind: "article" });
  });

  it("rejects what is not a plain web URL", () => {
    for (const raw of ["", "   ", "not a url", "javascript:alert(1)", "ftp://x.jp/a", "https://user:pw@x.jp/", "localhost", "https://a b.jp"]) expect(classifyIntakeUrl(raw), raw).toEqual({ ok: false, reason: "invalid_url" });
  });
});
