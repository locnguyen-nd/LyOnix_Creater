/**
 * VE2E-96: a structured article for the create-video page's URL intake - title, site name, date, language and the article body with
 * menus, link lists, related stories, ads, captions and footer left out. Same SSRF-safe fetch as the Auto pipeline's article source
 * (`fetchPageSafely`); the pipeline's own `extractArticleText` is unchanged.
 */
import { MAX_EXTRACTED_CHARS, fetchPageSafely, htmlToPlainText, type ExtractArticleResult, type FetchLike, type LookupLike } from "./source-extract.js";

export type ArticleDetails = {
  title: string | null;
  siteName: string | null;
  publishedAt: string | null;
  language: string | null;
  /** The page's text before boilerplate filtering (capped). */
  rawText: string;
  /** The article body (capped at MAX_EXTRACTED_CHARS). */
  text: string;
  truncated: boolean;
};

type ExtractFailure = Extract<ExtractArticleResult, { ok: false }>["reason"];
export type ExtractArticleDetailsResult = ({ ok: true; finalUrl: string } & ArticleDetails) | { ok: false; reason: ExtractFailure };

const decodeHtml = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
/** Text of an HTML fragment: block tags / <br> become spaces, inline tags (a, b, span, sup ...) vanish without adding spaces; citation marks like [12] dropped. */
const textOf = (html: string): string =>
  decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|section|article|dd|dt)\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\[(\d{1,3}|[a-z]|citation needed|要出典|注 ?\d+)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `<meta property|name|itemprop="key" content="...">`: the first key (in order) that has a value. */
const metaContent = (html: string, keys: readonly string[]): string | null => {
  const tags = html.match(/<meta\s[^>]*>/gi) ?? [];
  for (const key of keys) {
    for (const tag of tags) {
      const name = /\s(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (name?.toLowerCase() !== key) continue;
      const content = /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const value = decodeHtml(content?.[1] ?? content?.[2] ?? "").trim();
      if (value) return value;
    }
  }
  return null;
};

const jsonLdValue = (html: string, key: "datePublished" | "headline"): string | null => {
  for (const block of html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,300})"`).exec(block);
    if (match) return decodeHtml(match[1]!);
  }
  return null;
};

const BOILERPLATE = /(©|copyright|all rights reserved|無断転載|関連記事|related (posts|articles|stories)|read more|đọc thêm|tin liên quan|advertisement|スポンサー|広告|subscribe|newsletter|cookie|share this|シェアする|follow us|đăng ký nhận tin)/i;
const CJK_CHAR = /[぀-ヿ㐀-鿿가-힯]/g;
const cjkShare = (text: string) => (text.match(CJK_CHAR)?.length ?? 0) / Math.max(1, text.length);

/** `<p>` texts that read like article prose - not menus, link lists, short captions or boilerplate. */
const proseParagraphs = (html: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  // a link that wraps a whole block (a "related story" card: <a><div><p>headline</p></div></a>) is not the article's prose
  const withoutCards = html.replace(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?<(?:p|div|h[1-6]|li|figure|img)\b[\s\S]*?<\/a>/gi, " ");
  for (const match of withoutCards.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)) {
    const inner = match[1]!;
    const text = textOf(inner);
    const linked = textOf((inner.match(/<a\b[\s\S]*?<\/a>/gi) ?? []).join(" "));
    const cjk = cjkShare(text) > 0.3;
    // CJK prose ends like a sentence (headlines and labels do not); a long line counts too
    if (cjk && !/[。．!?！？」』)）]$/.test(text) && [...text].length < 60) continue;
    if ([...text].length < (cjk ? 12 : 30) || BOILERPLATE.test(text) || linked.length > text.length * 0.6 || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
};

/** Title, site name, date, language and the main text of an article page. Pure (no network). */
export function articleFromHtml(page: string, finalUrl: string): ArticleDetails {
  const cleaned = page
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|form|button|select|figure)\b[\s\S]*?<\/\1>/gi, " ");
  let hostname: string | null = null;
  try {
    hostname = new URL(finalUrl).hostname.replace(/^www\./, "");
  } catch {
    hostname = null;
  }
  const siteName = metaContent(page, ["og:site_name", "application-name"]) ?? hostname;
  const titleTag = textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1] ?? "") || null;
  const heading = textOf(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(cleaned)?.[1] ?? "") || null;
  const rawTitle = metaContent(page, ["og:title", "twitter:title"]) ?? jsonLdValue(page, "headline") ?? titleTag ?? heading;
  // "Headline | Site" / "Headline - Site" -> "Headline"
  // the site's name, or the main label of its host ("en.wikipedia.org" -> "wikipedia"), at the end of the title
  const hostLabel = hostname?.split(".").filter((label) => !/^(www|m|en|ja|jp|vi|ko|news|co|com|org|net|ne|or|go)$/i.test(label))[0] ?? null;
  const suffixes = [siteName, hostLabel].filter((value): value is string => Boolean(value));
  const title = rawTitle
    ? suffixes.reduce((current, suffix) => current.replace(new RegExp(`\\s*[|｜\\-–—:]\\s*${escapeRegExp(suffix)}\\s*$`, "i"), "").trim() || current, rawTitle)
    : rawTitle;
  const dateRaw = metaContent(page, ["article:published_time", "og:published_time", "datepublished", "publish-date", "pubdate", "date"]) ?? jsonLdValue(page, "datePublished") ?? /<time[^>]+datetime\s*=\s*["']([^"']+)["']/i.exec(cleaned)?.[1] ?? null;
  const date = dateRaw ? new Date(dateRaw) : null;
  const language = /<html[^>]*\slang\s*=\s*["']?([a-zA-Z]{2,3})/i.exec(page)?.[1]?.toLowerCase() ?? null;

  const withoutChrome = cleaned.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const articles = [...withoutChrome.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((match) => match[1]!);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(withoutChrome)?.[1];
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(withoutChrome)?.[1] ?? withoutChrome;
  const container = articles.sort((a, b) => textOf(b).length - textOf(a).length)[0] ?? main ?? body;

  let paragraphs = proseParagraphs(container);
  const proseChars = paragraphs.join("").length;
  if (proseChars < 200) {
    // little <p> prose: the container's block lines (short / boilerplate / repeated ones left out), used only when they hold clearly more
    const seen = new Set<string>();
    const lines = container
      // links are other stories / navigation, never the article's own sentences
      .replace(/<a\b[\s\S]*?<\/a>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|section|article|dd|dt)\b[^>]*>/gi, "\n")
      .split("\n")
      .map(textOf)
      .filter((line) => {
        // prose: a sentence (ends like one) or a long line - not a headline / label
        const sentence = /[。．.!?！？」』)）]$/.test(line) || [...line].length >= 80;
        if (!sentence || [...line].length < (cjkShare(line) > 0.3 ? 10 : 25) || BOILERPLATE.test(line) || seen.has(line)) return false;
        seen.add(line);
        return true;
      });
    if (lines.join("").length > proseChars * 1.5) paragraphs = lines;
  }
  const chars = [...paragraphs.join("\n\n")];
  return {
    title: title ? title.slice(0, 300) : null,
    siteName: siteName ? siteName.slice(0, 100) : null,
    publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    language,
    rawText: htmlToPlainText(body).slice(0, MAX_EXTRACTED_CHARS),
    text: chars.slice(0, MAX_EXTRACTED_CHARS).join(""),
    truncated: chars.length > MAX_EXTRACTED_CHARS,
  };
}

/** The SSRF-safe fetch (DNS check on every hop, <= 5 redirects, 15 s, 2 MB, html/text only) + `articleFromHtml`. */
export async function extractArticle(originalUrl: string, deps: { fetch?: FetchLike; lookup?: LookupLike } = {}): Promise<ExtractArticleDetailsResult> {
  const page = await fetchPageSafely(originalUrl, deps);
  if (!page.ok) return page;
  const article = articleFromHtml(page.html, page.finalUrl);
  if (!article.text) return { ok: false, reason: "empty" };
  return { ok: true, finalUrl: page.finalUrl, ...article };
}
