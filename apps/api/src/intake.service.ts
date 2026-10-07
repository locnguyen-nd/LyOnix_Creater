/**
 * VE2E-96: what a URL pasted in the create-video page's "Nguồn nội dung" box gives the form - one response shape for every source:
 *  - a TikTok video: its transcript (subtitles, else speech-to-text) - TikTokIntakeService;
 *  - a Yahoo! JAPAN News article: looked up in that source's feed only (its page is never fetched);
 *  - any other page: the article read by the SSRF-safe extractor (title, site, date, body without menus / ads / footer).
 * With `rewrite`, an original short-video script is written from the text (IntakeRewriteService). Nothing is created or stored.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { classifyIntakeUrl, countWords, detectTextLanguage, type NewsItem } from "@lyonix/domain";
import type { UrlIntakeErrorCode, UrlIntakeRequest, UrlIntakeResponse, UrlIntakeRewrite, UrlIntakeSource, UrlIntakeStage } from "@lyonix/contracts";
import type { TranscriptContext } from "./transcript-config.js";
import { NewsService } from "./news.service.js";
import { TikTokIntakeService } from "./tiktok-intake.service.js";
import { IntakeRewriteService } from "./intake-rewrite.service.js";
import { extractArticle } from "./article-extract.js";

export const INTAKE_SERVICE_OPTIONS = "INTAKE_SERVICE_OPTIONS";
export type IntakeServiceOptions = { extract?: typeof extractArticle };

type SourceOutcome = { ok: true; source: UrlIntakeSource } | { ok: false; sourceType: "tiktok" | "article"; sourceUrl: string; code: UrlIntakeErrorCode; message: string };

const ARTICLE_MESSAGES: Record<string, string> = {
  ssrf_blocked: "URL bị chặn (localhost / mạng nội bộ / địa chỉ không an toàn)",
  fetch_failed: "Không tải được trang",
  too_large: "Trang quá lớn",
  unsupported_content_type: "Không phải trang văn bản (HTML)",
  empty: "Trang không có nội dung bài viết",
  too_many_redirects: "Trang chuyển hướng quá nhiều lần",
};

@Injectable()
export class IntakeService {
  private readonly extract: typeof extractArticle;

  constructor(
    @Inject(NewsService) private readonly news: NewsService,
    @Inject(TikTokIntakeService) private readonly tiktok: TikTokIntakeService,
    @Inject(IntakeRewriteService) private readonly rewriter: IntakeRewriteService,
    @Optional() @Inject(INTAKE_SERVICE_OPTIONS) options?: IntakeServiceOptions,
  ) {
    this.extract = options?.extract ?? extractArticle;
  }

  /** null = not a web URL (the controller answers VALIDATION_FAILED). */
  async analyze(userId: string, role: "admin" | "staff", request: UrlIntakeRequest, onStage?: (stage: UrlIntakeStage) => void): Promise<UrlIntakeResponse | null> {
    const context: TranscriptContext = { userId, role, ...(request.mediaAccountId ? { mediaAccountId: request.mediaAccountId } : {}), ...(request.voiceAccountId ? { voiceAccountId: request.voiceAccountId } : {}) };
    const outcome = await this.read(request.url, { context, languageHint: request.language ?? null, ...(onStage ? { onStage } : {}) });
    if (!outcome) return null;
    if (!outcome.ok) return { ok: false, sourceType: outcome.sourceType, sourceUrl: outcome.sourceUrl, error: { code: outcome.code, message: outcome.message } };
    const rewrite: UrlIntakeRewrite = request.rewrite
      ? await this.rewriter.rewrite(userId, role, {
          source: outcome.source,
          ...(request.contentAccountId ? { contentAccountId: request.contentAccountId } : {}),
          ...(request.language ? { language: request.language } : {}),
          ...(request.durationSec ? { durationSec: request.durationSec } : {}),
        })
      : { status: "skipped", reason: "not_requested" };
    return { ok: true, source: outcome.source, rewrite };
  }

  /** The source text of a URL, without rewriting. null = not a web URL. */
  async read(raw: string, options: { context: TranscriptContext; languageHint?: string | null; onStage?: (stage: UrlIntakeStage) => void }): Promise<SourceOutcome | null> {
    const classified = classifyIntakeUrl(raw);
    if (!classified.ok) return null;
    const { kind, url } = classified;
    if (kind === "tiktok") {
      const read = await this.tiktok.read(url, options);
      return read.ok ? read : { ok: false, sourceType: "tiktok", sourceUrl: url, code: read.code, message: read.message };
    }
    options.onStage?.("reading");
    if (kind === "yahoo_news") return this.newsArticle(url);

    const article = await this.extract(url);
    if (!article.ok) return { ok: false, sourceType: "article", sourceUrl: url, code: article.reason, message: ARTICLE_MESSAGES[article.reason] ?? "Không đọc được bài viết" };
    // a link that redirected to a news-source article is handled like that article (its extracted page is discarded)
    const landed = classifyIntakeUrl(article.finalUrl);
    if (landed.ok && landed.kind === "yahoo_news") return this.newsArticle(landed.url);
    if (landed.ok && landed.kind === "tiktok") return { ok: false, sourceType: "article", sourceUrl: url, code: "invalid_tiktok_url", message: "Link chuyển hướng tới TikTok: hãy dán link video TikTok trực tiếp" };
    const chars = [...article.text].length;
    return {
      ok: true,
      source: {
        sourceType: "article",
        sourceUrl: article.finalUrl,
        title: article.title,
        sourceName: article.siteName,
        publishedAt: article.publishedAt,
        rawText: article.rawText,
        cleanedText: article.text,
        language: article.language?.slice(0, 2) ?? detectTextLanguage(article.text),
        characterCount: chars,
        wordCount: countWords(article.text),
        method: "article_extractor",
        providerUsed: "article_extractor",
        truncated: article.truncated,
        newsItem: null,
      },
    };
  }

  private async newsArticle(url: string): Promise<SourceOutcome> {
    const found = await this.news.findByUrl("yahoo_jp", url);
    if (found.status !== "found") {
      return found.status === "source_disabled"
        ? { ok: false, sourceType: "article", sourceUrl: url, code: "news_source_disabled", message: "Nguồn tin Yahoo JP chưa được bật trên server (NEWS_SOURCES)" }
        : { ok: false, sourceType: "article", sourceUrl: url, code: "news_not_in_feed", message: "Không thấy bài này trong feed Yahoo JP hiện tại (LyOnix không tải trang bài viết của Yahoo)" };
    }
    return { ok: true, source: newsSource(found.item) };
  }
}

/** A feed item as an intake source: only what the feed published (headline + excerpt). */
export function newsSource(item: NewsItem): UrlIntakeSource {
  const text = [item.title, item.excerpt].filter(Boolean).join("\n");
  return {
    sourceType: "article",
    sourceUrl: item.sourceUrl,
    title: item.title,
    sourceName: item.publisher ? `${item.publisher} / ${item.source}` : item.source,
    publishedAt: item.publishedAt,
    rawText: text,
    cleanedText: text,
    language: detectTextLanguage(text),
    characterCount: [...text].length,
    wordCount: countWords(text),
    method: "news_feed",
    providerUsed: `${item.sourceId}_feed`,
    truncated: false,
    newsItem: item,
  };
}
