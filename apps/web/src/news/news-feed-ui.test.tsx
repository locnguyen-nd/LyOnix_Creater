import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import type { NewsFeedResponse, NewsItemResponse } from "@lyonix/contracts";
import { SYSTEM_CREATION_DEFAULTS } from "@lyonix/domain/creation-form";
import { NEWS_FILTERS, composeNewsTopic, parseSelectedNews, serializeSelectedNews } from "@lyonix/domain/news";

// Browsing news is a read of the server's cached feeds only: any other network module touched would be recorded here.
const network = vi.hoisted(() => ({ calls: vi.fn() }));
vi.mock("../api", () => ({ api: network.calls, csrfHeaders: network.calls, ApiError: class extends Error {} }));

const { NewsFeedView } = await import("./NewsFeed");
const { SelectedNewsCard } = await import("../job-new/SelectedNewsCard");
const { newsPick, newsUnpick } = await import("../job-new/news-pick");
const { relativeNewsTime } = await import("./news-format");
const { locales } = await import("../i18n/locales");

type Lng = "vi" | "en" | "ja" | "ko";
const render = async (node: React.ReactNode, lng: Lng = "vi") => {
  const instance = i18n.createInstance();
  await instance.init({ lng, resources: { [lng]: { translation: locales[lng] } }, interpolation: { escapeValue: false } });
  return renderToStaticMarkup(<I18nextProvider i18n={instance}>{node}</I18nextProvider>);
};

const NOW = Date.UTC(2026, 9, 7, 4, 0);
const item = (id: string, overrides: Partial<NewsItemResponse> = {}): NewsItemResponse => ({
  id: `yahoo_jp:articles:${id}`,
  sourceId: "yahoo_jp",
  source: "Yahoo!ニュース",
  publisher: "スポーツ架空",
  title: `見出し ${id}`,
  excerpt: `概要 ${id}`,
  thumbnailUrl: `https://img.test/${id}.jpg`,
  sourceUrl: `https://news.yahoo.co.jp/articles/${id}`,
  publishedAt: new Date(NOW - 5 * 60_000).toISOString(),
  category: "sports",
  ...overrides,
});
const response = (items: NewsItemResponse[], overrides: Partial<NewsFeedResponse> = {}): NewsFeedResponse => ({
  filter: "all",
  query: "",
  items,
  sources: [{ id: "yahoo_jp", label: "Yahoo!ニュース", status: "ok", termsUrl: "https://news.yahoo.co.jp/rss", message: null }],
  fetchedAt: new Date(NOW).toISOString(),
  ...overrides,
});
const noop = () => undefined;
const feed = (state: { loading: boolean; data: NewsFeedResponse | null; error: string | null }, opts: { selectedId?: string | null; lng?: Lng; filter?: (typeof NEWS_FILTERS)[number] } = {}) =>
  render(
    <NewsFeedView filter={opts.filter ?? "all"} input="" state={state} selectedId={opts.selectedId ?? null} now={NOW} onFilter={noop} onInput={noop} onClearSearch={noop} onRetry={noop} onUse={noop} />,
    opts.lng,
  );
const cards = (html: string) => [...html.matchAll(/data-testid="news-card" data-news-id="([^"]+)"/g)].map((m) => m[1]);

describe("VE2E-96 news feed", () => {
  it("search box and the six filter chips (Tất cả / Yahoo JP / Nhật Bản / Thể thao / Giải trí / Trending)", async () => {
    const html = await feed({ loading: false, data: response([item("a")]), error: null }, { filter: "sports" });
    expect(html).toContain('data-testid="news-search"');
    const chips = [...html.matchAll(/role="radio" aria-checked="(true|false)"[^>]*data-filter="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[3], m[1]]);
    expect(chips).toEqual([
      ["all", "Tất cả", "false"],
      ["yahoo_jp", "Yahoo JP", "false"],
      ["japan", "Nhật Bản", "false"],
      ["sports", "Thể thao", "true"],
      ["entertainment", "Giải trí", "false"],
      ["trending", "Trending", "false"],
    ]);
  });

  it("a card: thumbnail, title, source, time, excerpt, [Dùng tin này], [Xem bài gốc] in a new tab without referrer", async () => {
    const html = await feed({ loading: false, data: response([item("a")]), error: null });
    expect(cards(html)).toEqual(["yahoo_jp:articles:a"]);
    expect(html).toContain('src="https://img.test/a.jpg"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("見出し a");
    expect(html).toContain("スポーツ架空 · Yahoo!ニュース");
    expect(html).toMatch(/<time dateTime="[^"]+">5 phút trước<\/time>/);
    expect(html).toContain("概要 a");
    expect(html).toContain(">Dùng tin này</button>");
    expect(html).toMatch(/<a href="https:\/\/news\.yahoo\.co\.jp\/articles\/a" target="_blank" rel="noopener noreferrer"[^>]*data-testid="news-open-original"/);
  });

  it("the item in use is marked; a story listed twice is shown once (id / URL)", async () => {
    const html = await feed({ loading: false, data: response([item("a"), item("b"), item("a2", { sourceUrl: "https://news.yahoo.co.jp/articles/a?source=rss" }), item("b")]), error: null }, { selectedId: "yahoo_jp:articles:b" });
    expect(cards(html)).toEqual(["yahoo_jp:articles:a", "yahoo_jp:articles:b"]);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="news-use"/);
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
  });

  it("an item without picture / excerpt / date still renders (placeholder, no empty excerpt)", async () => {
    const html = await feed({ loading: false, data: response([item("t", { thumbnailUrl: null, excerpt: null, publishedAt: null, publisher: null, category: "trending" })]), error: null });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<time");
    expect(html).toContain(">Trending</span>");
  });

  it("states: loading skeleton, error with retry, empty, empty search with clear, partial / failed source", async () => {
    expect(await feed({ loading: true, data: null, error: null })).toContain('data-testid="news-skeleton"');
    const error = await feed({ loading: false, data: null, error: "boom" });
    expect(error).toContain('data-testid="news-error"');
    expect(error).toContain("Thử lại");
    expect(await feed({ loading: false, data: response([]), error: null })).toContain("Chưa có tin nào trong mục này.");
    const noMatch = await feed({ loading: false, data: response([], { query: "野球" }), error: null });
    expect(noMatch).toContain("Không có tin khớp &quot;野球&quot;.");
    expect(noMatch).toContain("Xoá tìm kiếm");
    const partial = await feed({ loading: false, data: response([item("a")], { sources: [{ id: "yahoo_jp", label: "Yahoo!ニュース", status: "partial", termsUrl: "https://news.yahoo.co.jp/rss", message: "sports: timeout" }] }), error: null });
    expect(partial).toContain('data-testid="news-source-warning"');
    expect(cards(partial)).toHaveLength(1);
  });

  it("no source enabled: explains NEWS_SOURCES and links each source's terms, shows no card", async () => {
    const html = await feed({ loading: false, data: response([], { sources: [{ id: "yahoo_jp", label: "Yahoo!ニュース", status: "disabled", termsUrl: "https://news.yahoo.co.jp/rss", message: null }] }), error: null });
    expect(html).toContain('data-testid="news-disabled"');
    expect(html).toContain("NEWS_SOURCES");
    expect(html).toContain('href="https://news.yahoo.co.jp/rss"');
    expect(cards(html)).toEqual([]);
  });

  it("is translated in vi / en / ja / ko (same keys and placeholders, no raw key on screen)", async () => {
    const flatten = (value: unknown, prefix = ""): Record<string, string> =>
      Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((out, [key, entry]) => (typeof entry === "string" ? { ...out, [prefix + key]: entry } : { ...out, ...flatten(entry, `${prefix}${key}.`) }), {});
    const vi = flatten(locales.vi.news);
    for (const lng of ["en", "ja", "ko"] as const) {
      const strings = flatten(locales[lng].news);
      expect(Object.keys(strings).sort(), lng).toEqual(Object.keys(vi).sort());
      for (const [key, value] of Object.entries(vi)) expect([...(strings[key]!.match(/{{\w+}}/g) ?? [])].sort(), `${lng}.${key}`).toEqual([...(value.match(/{{\w+}}/g) ?? [])].sort());
      const html = await feed({ loading: false, data: response([item("a")]), error: null }, { lng });
      expect(html).not.toMatch(/[>"]news\.[a-zA-Z]/); // a raw i18n key ("news.yahoo.co.jp" in links is fine)
      for (const filter of NEWS_FILTERS) expect(html, `${lng} ${filter}`).toContain(locales[lng].news.filter[filter]);
    }
  });

  it("rendering the feed never calls the API by itself in a static render, nor any AI / render module", () => {
    expect(network.calls).not.toHaveBeenCalled();
  });
});

describe("VE2E-96 selected story in the create-video form", () => {
  it("shows the picked story with its original link and an unselect button", async () => {
    const html = await render(<SelectedNewsCard item={item("a")} onClear={noop} />);
    expect(html).toContain('data-testid="selected-news"');
    expect(html).toContain("見出し a");
    expect(html).toContain("LyOnix không tải bài gốc");
    expect(html).toContain('href="https://news.yahoo.co.jp/articles/a"');
    expect(html).toContain('aria-label="Bỏ chọn tin"');
  });

  it("'Dùng tin này' sets a topic source from the headline + excerpt + named source and keeps the item in the draft", () => {
    const auto = newsPick({ ...SYSTEM_CREATION_DEFAULTS, entryMode: "auto" }, item("a"));
    expect(auto).toEqual({ kind: "apply", needsConfirm: false, patch: { selectedNews: serializeSelectedNews(item("a")), topic: composeNewsTopic(item("a")), autoSourceType: "topic" } });
    const manual = newsPick({ ...SYSTEM_CREATION_DEFAULTS, entryMode: "manual" }, item("a"));
    expect(manual).toMatchObject({ kind: "apply", patch: { mode: "topic" } });
    expect(parseSelectedNews((auto as { patch: { selectedNews: string } }).patch.selectedNews)).toEqual(item("a"));
  });

  it("asks before replacing a topic the user typed; switching between stories does not ask; the same story is a no-op", () => {
    expect(newsPick({ ...SYSTEM_CREATION_DEFAULTS, topic: "chủ đề tự gõ" }, item("a"))).toMatchObject({ needsConfirm: true });
    const picked = { ...SYSTEM_CREATION_DEFAULTS, topic: composeNewsTopic(item("a")), selectedNews: serializeSelectedNews(item("a")) };
    expect(newsPick(picked, item("b"))).toMatchObject({ kind: "apply", needsConfirm: false });
    expect(newsPick(picked, item("a"))).toEqual({ kind: "same" });
    expect(newsPick({ ...picked, topic: `${picked.topic} + sửa tay` }, item("b"))).toMatchObject({ needsConfirm: true });
  });

  it("unselecting clears the topic only while it is still the one made from the story", () => {
    const picked = { ...SYSTEM_CREATION_DEFAULTS, topic: composeNewsTopic(item("a")), selectedNews: serializeSelectedNews(item("a")) };
    expect(newsUnpick(picked)).toEqual({ selectedNews: "", topic: "" });
    expect(newsUnpick({ ...picked, topic: "đã sửa" })).toEqual({ selectedNews: "" });
  });
});

describe("VE2E-96 news time", () => {
  it("relative within a week, a date after; in the UI language", () => {
    expect(relativeNewsTime(new Date(NOW - 20_000).toISOString(), NOW, "vi", "Vừa xong")).toBe("Vừa xong");
    expect(relativeNewsTime(new Date(NOW - 5 * 60_000).toISOString(), NOW, "en", "now")).toBe("5 minutes ago");
    expect(relativeNewsTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW, "ja", "")).toBe("3 時間前");
    expect(relativeNewsTime(new Date(NOW - 30 * 86_400_000).toISOString(), NOW, "en", "")).toMatch(/Sep/);
    expect(relativeNewsTime(null, NOW, "vi", "")).toBeNull();
    expect(relativeNewsTime("bad", NOW, "vi", "")).toBeNull();
  });
});
