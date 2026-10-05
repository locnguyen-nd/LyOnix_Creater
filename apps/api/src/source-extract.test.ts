import { describe, expect, it, vi } from "vitest";
import { extractArticleText, htmlToPlainText, type FetchLike, type LookupLike } from "./source-extract.js";

const okLookup: LookupLike = async () => [{ address: "93.184.216.34" }];
const privateLookup: LookupLike = async () => [{ address: "127.0.0.1" }];

const htmlResponse = (body: string, headers: Record<string, string> = {}) => ({
  status: 200,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? (name.toLowerCase() === "content-type" ? "text/html" : null) },
  text: async () => body,
});

describe("htmlToPlainText", () => {
  it("strips script/style and collapses whitespace", () => {
    const html = "<html><head><style>.a{}</style></head><body><script>evil()</script><h1>Title</h1><p>Hello&nbsp;world</p></body></html>";
    expect(htmlToPlainText(html)).toBe("Title\nHello world");
  });
});

describe("extractArticleText", () => {
  it("extracts plain text from a normal HTML page", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => htmlResponse("<p>Hello world</p>") as never);
    const result = await extractArticleText("https://example.com/a", { fetch: fetchMock, lookup: okLookup });
    expect(result).toEqual({ ok: true, extractedText: "Hello world", finalUrl: "https://example.com/a" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a URL whose DNS answer resolves to a private address", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => htmlResponse("<p>x</p>") as never);
    const result = await extractArticleText("https://example.com/a", { fetch: fetchMock, lookup: privateLookup });
    expect(result).toEqual({ ok: false, reason: "ssrf_blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-validates the SSRF guard on every redirect hop and blocks a private redirect target", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url: string) => {
      if (url === "https://example.com/a") {
        return { status: 302, headers: { get: (n: string) => (n.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data/" : null) }, text: async () => "" } as never;
      }
      return htmlResponse("<p>should not reach</p>") as never;
    });
    const result = await extractArticleText("https://example.com/a", { fetch: fetchMock, lookup: okLookup });
    expect(result).toEqual({ ok: false, reason: "ssrf_blocked" });
  });

  it("follows a same-origin-safe redirect once", async () => {
    const fetchMock = vi.fn<FetchLike>(async (url: string) => {
      if (url === "https://example.com/a") {
        return { status: 301, headers: { get: (n: string) => (n.toLowerCase() === "location" ? "https://example.com/b" : null) }, text: async () => "" } as never;
      }
      return htmlResponse("<p>Final content</p>") as never;
    });
    const result = await extractArticleText("https://example.com/a", { fetch: fetchMock, lookup: okLookup });
    expect(result).toEqual({ ok: true, extractedText: "Final content", finalUrl: "https://example.com/b" });
  });

  it("rejects a non-HTML content type", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => htmlResponse("binary", { "content-type": "application/pdf" }) as never);
    const result = await extractArticleText("https://example.com/a", { fetch: fetchMock, lookup: okLookup });
    expect(result).toEqual({ ok: false, reason: "unsupported_content_type" });
  });

  it("maps a network/timeout failure to fetch_failed", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => { throw new DOMException("aborted", "AbortError"); });
    const result = await extractArticleText("https://example.com/a", { fetch: fetchMock, lookup: okLookup });
    expect(result).toEqual({ ok: false, reason: "fetch_failed" });
  });

  it("returns empty when the extracted text has no content", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => htmlResponse("<script>x()</script><style>.a{}</style>") as never);
    const result = await extractArticleText("https://example.com/a", { fetch: fetchMock, lookup: okLookup });
    expect(result).toEqual({ ok: false, reason: "empty" });
  });
});
