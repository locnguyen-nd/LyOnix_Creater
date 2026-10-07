import { describe, expect, it, vi } from "vitest";
import { YAHOO_JAPAN_NEWS_SOURCE, type NewsFetch } from "@lyonix/providers";
import type { UrlIntakeRewrite } from "@lyonix/contracts";
import { IntakeService } from "./intake.service.js";
import { NewsService } from "./news.service.js";
import type { TikTokIntakeService } from "./tiktok-intake.service.js";
import type { IntakeRewriteService } from "./intake-rewrite.service.js";
import type { extractArticle } from "./article-extract.js";

const sportsUrl = YAHOO_JAPAN_NEWS_SOURCE.feeds.find((feed) => feed.category === "sports")!.url;
const SPORTS_RSS = `<rss><channel><item><title>架空投手が快投 (スポーツ架空)</title><link>https://news.yahoo.co.jp/articles/sp1?source=rss</link><pubDate>Wed, 07 Oct 2026 03:46:42 GMT</pubDate><description>概要です</description></item></channel></rss>`;
const ARTICLE_OK = { ok: true as const, finalUrl: "https://example.jp/final", title: "見出し", siteName: "Example", publishedAt: null, language: "ja", rawText: "全文", text: "本文の段落です。", truncated: false };

const setup = (opts: { enabled?: string | undefined; extracted?: Awaited<ReturnType<typeof extractArticle>> } = {}) => {
  const fetchImpl = vi.fn<NewsFetch>(async (url) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => (url === sportsUrl ? SPORTS_RSS : "<rss/>") }));
  const news = new NewsService({ fetch: fetchImpl, enabledSources: () => opts.enabled });
  const tiktok = { read: vi.fn(async () => ({ ok: false as const, code: "transcript_provider_not_configured" as const, message: "not configured" })) };
  const rewrite = vi.fn(async (): Promise<UrlIntakeRewrite> => ({ status: "done", script: "新しい台本", hook: "新しい", language: "ja", characterCount: 5, providerUsed: "openai/m", overlapRatio: 0, overlapHigh: false }));
  const extract = vi.fn<typeof extractArticle>(async () => opts.extracted ?? ARTICLE_OK);
  const intake = new IntakeService(news, tiktok as unknown as TikTokIntakeService, { rewrite } as unknown as IntakeRewriteService, { extract });
  return { intake, tiktok, rewrite, extract, fetchImpl };
};

describe("VE2E-96 URL intake (one response for every source)", () => {
  it("article: structured source; rewritten only when asked, with the form's account / language / length", async () => {
    const { intake, rewrite } = setup();
    const plain = await intake.analyze("u1", "staff", { url: "example.jp/a" });
    expect(plain).toEqual({
      ok: true,
      source: { sourceType: "article", sourceUrl: "https://example.jp/final", title: "見出し", sourceName: "Example", publishedAt: null, rawText: "全文", cleanedText: "本文の段落です。", language: "ja", characterCount: 8, wordCount: expect.any(Number), method: "article_extractor", providerUsed: "article_extractor", truncated: false, newsItem: null },
      rewrite: { status: "skipped", reason: "not_requested" },
    });
    expect(rewrite).not.toHaveBeenCalled();
    const rewritten = await intake.analyze("u1", "staff", { url: "https://example.jp/a", rewrite: true, contentAccountId: "acc-1", language: "ja", durationSec: 55 });
    expect(rewritten).toMatchObject({ ok: true, rewrite: { status: "done", script: "新しい台本" } });
    expect(rewrite.mock.calls[0]).toEqual(["u1", "staff", expect.objectContaining({ contentAccountId: "acc-1", language: "ja", durationSec: 55 })]);
  });

  it("article failure: an error with its code, never a rewrite", async () => {
    const { intake, rewrite } = setup({ extracted: { ok: false, reason: "ssrf_blocked" } });
    expect(await intake.analyze("u1", "staff", { url: "http://10.0.0.1/a", rewrite: true })).toEqual({ ok: false, sourceType: "article", sourceUrl: "http://10.0.0.1/a", error: { code: "ssrf_blocked", message: expect.any(String) } });
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("TikTok goes to the TikTok intake; its error comes back as is", async () => {
    const { intake, tiktok, extract } = setup();
    expect(await intake.analyze("u1", "staff", { url: "https://www.tiktok.com/@a/video/7412345678901234567" })).toMatchObject({ ok: false, sourceType: "tiktok", error: { code: "transcript_provider_not_configured" } });
    // who asks (their Provider Settings accounts are used) travels with the URL
    expect(tiktok.read).toHaveBeenCalledWith("https://www.tiktok.com/@a/video/7412345678901234567", { context: { userId: "u1", role: "staff" }, languageHint: null });
    expect(extract).not.toHaveBeenCalled();
  });

  it("Yahoo! JAPAN News: only the feed is read (headline + excerpt), never the article page", async () => {
    const { intake, extract } = setup({ enabled: "yahoo_jp" });
    const result = await intake.analyze("u1", "staff", { url: "https://news.yahoo.co.jp/articles/sp1" });
    expect(result).toMatchObject({ ok: true, source: { method: "news_feed", providerUsed: "yahoo_jp_feed", title: "架空投手が快投", sourceName: "スポーツ架空 / Yahoo!ニュース", cleanedText: "架空投手が快投\n概要です", newsItem: { id: "yahoo_jp:articles:sp1" } } });
    expect(extract).not.toHaveBeenCalled();
    expect(await setup().intake.analyze("u1", "staff", { url: "https://news.yahoo.co.jp/articles/sp1" })).toMatchObject({ ok: false, error: { code: "news_source_disabled" } });
    expect(await setup({ enabled: "yahoo_jp" }).intake.analyze("u1", "staff", { url: "https://news.yahoo.co.jp/articles/zzz" })).toMatchObject({ ok: false, error: { code: "news_not_in_feed" } });
  });

  it("a link redirecting to a Yahoo! JAPAN article is handled like that article", async () => {
    const { intake } = setup({ enabled: "yahoo_jp", extracted: { ...ARTICLE_OK, finalUrl: "https://news.yahoo.co.jp/articles/sp1", text: "Yahoo の記事全文" } });
    const result = await intake.analyze("u1", "staff", { url: "https://short.example/x" });
    expect(result).toMatchObject({ ok: true, source: { method: "news_feed" } });
    expect(JSON.stringify(result)).not.toContain("記事全文");
  });

  it("not a web URL: null (VALIDATION_FAILED)", async () => {
    const { intake } = setup();
    for (const url of ["", "javascript:alert(1)", "not a url", "ftp://example.com/a"]) expect(await intake.analyze("u1", "staff", { url }), url).toBeNull();
  });
});
