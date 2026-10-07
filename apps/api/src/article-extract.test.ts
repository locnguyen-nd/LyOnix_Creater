import { describe, expect, it, vi } from "vitest";
import { articleFromHtml, extractArticle } from "./article-extract.js";
import { MAX_EXTRACTED_CHARS, type FetchLike, type LookupLike } from "./source-extract.js";

const ARTICLE = `<!doctype html><html lang="en"><head>
<title>Bridge reopens after repairs | Example News</title>
<meta property="og:site_name" content="Example News">
<meta property="og:title" content="Bridge reopens after repairs - Example News">
<meta property="article:published_time" content="2026-10-05T08:30:00+09:00">
<script>var ads = "<p>not text</p>";</script>
</head><body>
<header><nav><a href="/">Home</a><p>Top menu paragraph that is long enough to pass the filter</p></nav></header>
<main><article>
<h1>Bridge reopens after repairs</h1>
<p>The old river bridge reopened on Monday after eight months of repairs costing 12 million dollars.</p>
<p>Engineers replaced <a href="/a">the deck</a> and strengthened the supports so heavier trucks can cross again.</p>
<figure><img src="x.jpg"><figcaption>Photo caption that should not be part of the article body text</figcaption></figure>
<p><a href="/r1">Related story one</a> <a href="/r2">Related story two about other bridges</a></p>
<p>Advertisement - continue reading below this sponsored placement please</p>
<p>The city expects about 20,000 vehicles a day to use the bridge, the mayor said.</p>
</article>
<aside><p>Related articles you might like to read next week maybe</p></aside></main>
<footer><p>© 2026 Example News. All rights reserved. Long footer text here.</p></footer>
</body></html>`;

describe("VE2E-96 article extraction (structured)", () => {
  it("title (site suffix removed), site name, date, language, and the body without menu / caption / related / ads / footer", () => {
    const article = articleFromHtml(ARTICLE, "https://www.example.com/news/bridge");
    expect(article).toMatchObject({ title: "Bridge reopens after repairs", siteName: "Example News", publishedAt: "2026-10-04T23:30:00.000Z", language: "en", truncated: false });
    expect(article.text.split("\n\n")).toEqual([
      "The old river bridge reopened on Monday after eight months of repairs costing 12 million dollars.",
      "Engineers replaced the deck and strengthened the supports so heavier trucks can cross again.",
      "The city expects about 20,000 vehicles a day to use the bridge, the mayor said.",
    ]);
    expect(article.text).not.toMatch(/menu|caption|Related|Advertisement|©|not text/);
  });

  it("falls back to JSON-LD / <time> for the date, the host for the site, <title> for the title", () => {
    const html = `<html><head><title>見出し</title><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-09-01T10:00:00Z"}</script></head><body><article><p>大阪で新しい駅が開業しました。地元の人々が集まりました。</p></article></body></html>`;
    expect(articleFromHtml(html, "https://news.example.jp/a")).toMatchObject({ title: "見出し", siteName: "news.example.jp", publishedAt: "2026-09-01T10:00:00.000Z", text: "大阪で新しい駅が開業しました。地元の人々が集まりました。" });
    const timeOnly = `<html><body><main><time datetime="2026-08-01">Aug 1</time><p>${"A long enough paragraph of article prose. ".repeat(3)}</p></main></body></html>`;
    expect(articleFromHtml(timeOnly, "https://x.example/a").publishedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("inline markup adds no stray spaces, citation marks are dropped, the host's name is stripped from the title", () => {
    const html = `<html><head><title>Tokyo Tower - Wikipedia</title></head><body><main><p><b>Tokyo Tower</b> (<span lang="ja">東京タワー</span>, <i>Tōkyō Tawā</i>) is a communications tower in Minato, Tokyo.<sup class="reference">[1]</sup> It is 333 m tall.[12]</p></main></body></html>`;
    const article = articleFromHtml(html, "https://en.wikipedia.org/wiki/Tokyo_Tower");
    expect(article.title).toBe("Tokyo Tower");
    expect(article.text).toBe("Tokyo Tower (東京タワー, Tōkyō Tawā) is a communications tower in Minato, Tokyo. It is 333 m tall.");
  });

  it("a page without <p> prose keeps its real lines (short / repeated / boilerplate lines left out)", () => {
    const html = `<html><body><div>Home</div><div>This is a sentence of the article that is long enough.</div><div>This is a sentence of the article that is long enough.</div><div>Another line of the article with real content inside it.</div><div>Subscribe to our newsletter today for more news</div></body></html>`;
    expect(articleFromHtml(html, "https://x.example/a").text).toBe("This is a sentence of the article that is long enough.\n\nAnother line of the article with real content inside it.");
  });

  it("a page that renders only its lead server-side keeps the lead - never the headlines of related links around it", () => {
    const html = `<html><head><meta property="og:site_name" content="NHKニュース"></head><body><main>
      <p>大型で非常に強い台風13号は、沖縄本島の西の海上を進んでいます。</p>
      <div><a href="/a1"><span>NHK ONE ニュース・防災アプリ</span></a></div>
      <a href="/card"><div class="card"><p>バンス副大統領の故郷にいって評判を聞いてみた</p></div></a>
      <p>ネクタイの締め方がわからない</p>
      <ul><li><a href="/a2"><em>アルツハイマー病だった父 私は・・・</em></a></li><li><a href="/a3">「人工的に豪雨が…」 大雨フェイクを検証 AIで偽の予測画像も</a></li></ul>
      <div><span>“市場価値60年延びた” 注目の「再生建築」に迫る</span></div>
    </main></body></html>`;
    expect(articleFromHtml(html, "https://www3.nhk.or.jp/news/html/x.html").text).toBe("大型で非常に強い台風13号は、沖縄本島の西の海上を進んでいます。");
  });

  it("an article longer than the intake keeps is cut and flagged", () => {
    const html = `<html><body><article>${Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} of a very long article with enough words to count as prose here.</p>`).join("")}</article></body></html>`;
    const article = articleFromHtml(html, "https://x.example/a");
    expect([...article.text]).toHaveLength(MAX_EXTRACTED_CHARS);
    expect(article.truncated).toBe(true);
  });
});

const page = (body: string, init: { status?: number; type?: string; location?: string } = {}) => ({
  status: init.status ?? 200,
  headers: { get: (name: string) => (name === "content-type" ? init.type ?? "text/html; charset=utf-8" : name === "location" ? init.location ?? null : null) },
  text: async () => body,
});
const publicLookup: LookupLike = async (host) => [{ address: host === "internal.example" ? "10.0.0.5" : "93.184.216.34" }];

describe("VE2E-96 article fetch (SSRF-safe)", () => {
  it("success, following a redirect (each hop re-checked)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => (url === "https://short.example/x" ? page("", { status: 301, location: "https://www.example.com/news/bridge" }) : page(ARTICLE)));
    const result = await extractArticle("https://short.example/x", { fetch: fetchImpl, lookup: publicLookup });
    expect(result).toMatchObject({ ok: true, finalUrl: "https://www.example.com/news/bridge", title: "Bridge reopens after repairs" });
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.redirect])).toEqual([["https://short.example/x", "manual"], ["https://www.example.com/news/bridge", "manual"]]);
  });

  it("failures: HTTP error, not HTML, empty page, too many redirects", async () => {
    const run = (fetchImpl: FetchLike) => extractArticle("https://www.example.com/a", { fetch: fetchImpl, lookup: publicLookup });
    expect(await run(async () => page("", { status: 404 }))).toEqual({ ok: false, reason: "fetch_failed" });
    expect(await run(async () => page("%PDF", { type: "application/pdf" }))).toEqual({ ok: false, reason: "unsupported_content_type" });
    expect(await run(async () => page("<html><body><nav>menu</nav></body></html>"))).toEqual({ ok: false, reason: "empty" });
    expect(await run(async (url) => page("", { status: 302, location: `${url}x` }))).toEqual({ ok: false, reason: "too_many_redirects" });
    expect(await run(async () => { throw new Error("ECONNRESET"); })).toEqual({ ok: false, reason: "fetch_failed" });
  });

  it("security: localhost, loopback, private / link-local / metadata addresses, other schemes and a redirect into the network are blocked", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => page(ARTICLE));
    for (const url of ["http://localhost/a", "http://127.0.0.1/a", "http://[::1]/a", "http://10.1.2.3/a", "http://192.168.1.10/a", "http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/x", "ftp://example.com/a", "file:///etc/passwd", "https://internal.example/a"]) {
      expect(await extractArticle(url, { fetch: fetchImpl, lookup: publicLookup }), url).toEqual({ ok: false, reason: "ssrf_blocked" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    const redirectIn = vi.fn<FetchLike>(async () => page("", { status: 302, location: "http://169.254.169.254/latest/meta-data/" }));
    expect(await extractArticle("https://www.example.com/a", { fetch: redirectIn, lookup: publicLookup })).toEqual({ ok: false, reason: "ssrf_blocked" });
    expect(redirectIn).toHaveBeenCalledTimes(1);
  });
});
