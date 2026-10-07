import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import type { NewsItemResponse, UrlIntakeRewrite, UrlIntakeSource } from "@lyonix/contracts";
import { SYSTEM_CREATION_DEFAULTS, type JobNewFormValues } from "@lyonix/domain/creation-form";
import { serializeSelectedNews } from "@lyonix/domain/news";

const network = vi.hoisted(() => ({ calls: vi.fn() }));
vi.mock("../api", () => ({ api: network.calls, csrfHeaders: network.calls, ApiError: class extends Error {} }));

const { ContentSourceBar } = await import("./ContentSourceBar");
const { NewsDrawer } = await import("../news/NewsDrawer");
const { intakeApply, intakeProgress, intakeTopic } = await import("./url-intake");
const { locales } = await import("../i18n/locales");
type IntakeState = import("./url-intake").IntakeState;

type Lng = "vi" | "en" | "ja" | "ko";
const render = async (node: React.ReactNode, lng: Lng = "vi") => {
  const instance = i18n.createInstance();
  await instance.init({ lng, resources: { [lng]: { translation: locales[lng] } }, interpolation: { escapeValue: false } });
  return renderToStaticMarkup(<I18nextProvider i18n={instance}>{node}</I18nextProvider>);
};
const noop = () => undefined;
const bar = (state: IntakeState, lng: Lng = "vi") => render(<ContentSourceBar state={state} onAnalyze={noop} onSearchNews={noop} onApply={noop} onRetryRewrite={noop} />, lng);

const tiktok: UrlIntakeSource = {
  sourceType: "tiktok",
  sourceUrl: "https://www.tiktok.com/@osaka.news/video/7412345678901234567",
  title: "新駅を紹介",
  sourceName: "TikTok · @osaka.news",
  publishedAt: null,
  rawText: "大阪に新しい駅\n大阪に新しい駅ができます",
  cleanedText: "大阪に新しい駅ができます。開業は2025年3月です。",
  language: "ja",
  characterCount: 25,
  wordCount: 12,
  method: "subtitle",
  providerUsed: "apify",
  truncated: false,
  newsItem: null,
};
const done: UrlIntakeRewrite = { status: "done", script: "来年3月、大阪に新駅が誕生します。", hook: "大阪に新駅!", language: "ja", characterCount: 17, providerUsed: "openai/gpt-4.1-mini", overlapRatio: 0.05, overlapHigh: false };
const auto: JobNewFormValues = { ...SYSTEM_CREATION_DEFAULTS, entryMode: "auto" };
const studio: JobNewFormValues = { ...SYSTEM_CREATION_DEFAULTS, entryMode: "manual" };

describe("VE2E-96 'Nguồn nội dung' states", () => {
  it("idle: URL box + [Phân tích], news search + [Tìm kiếm], nothing else", async () => {
    const html = await bar({ kind: "idle" });
    expect(html).toContain("Nguồn nội dung");
    expect(html).toContain('data-testid="intake-url"');
    expect(html).toContain(">Phân tích</button>");
    expect(html).toContain(">Tìm kiếm</button>");
    expect(html).not.toContain('data-testid="intake-preview"');
  });

  it("loading: the progress line shows the step running and blocks a second analyse", async () => {
    const html = await bar({ kind: "loading", stage: "subtitles", sourceType: "tiktok" });
    expect(html).toContain('data-testid="intake-progress"');
    expect(html).toMatch(/data-step="reading" data-status="done"[\s\S]*?Đang đọc TikTok/);
    expect(html).toMatch(/data-step="subtitles" data-status="current"[\s\S]*?aria-current="step"[\s\S]*?Đang lấy phụ đề/);
    expect(html).toMatch(/data-step="rewriting" data-status="pending"[\s\S]*?Đang viết lại kịch bản/);
    expect(html).toMatch(/data-step="done" data-status="pending"[\s\S]*?Hoàn tất/);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Đang phân tích…<\/button>/);
  });

  it("missing providers say exactly what to do", async () => {
    const noApify = await bar({ kind: "error", code: "transcript_provider_not_configured", message: "x", stage: "reading", sourceType: "tiktok" });
    expect(noApify).toContain('data-testid="intake-error"');
    expect(noApify).toContain("Chưa cấu hình Apify. Vào Cài đặt &gt; Provider để thêm tài khoản.");
    expect(noApify).toMatch(/data-step="reading" data-status="failed"/);
    expect(noApify).not.toContain('data-testid="intake-preview"');
    const noStt = await bar({ kind: "error", code: "stt_provider_not_configured", message: "x", stage: "subtitles", sourceType: "tiktok" });
    expect(noStt).toContain("Video không có phụ đề và chưa cấu hình Speech-to-Text.");
    expect(await bar({ kind: "error", code: "something_new", message: "boom" })).toContain("Không phân tích được URL: boom");
  });

  it("success preview: type, title, source, characters, method, provider, first lines; buttons wait for the rewrite", async () => {
    const pending = await bar({ kind: "ready", source: tiktok, rewrite: { status: "pending" }, applied: null });
    expect(pending).toMatch(/data-testid="intake-preview" data-source-type="tiktok" data-method="subtitle"/);
    for (const text of ["TikTok", "新駅を紹介", "TikTok · @osaka.news", "25 ký tự", "Phụ đề của video", "Provider: apify", "開業は2025年3月です"]) expect(pending, text).toContain(text);
    expect(pending).toContain("Đang viết lại thành kịch bản mới");
    expect(pending).toMatch(/disabled=""[^>]*data-testid="intake-to-topic"/);
    expect(pending).toMatch(/disabled=""[^>]*data-testid="intake-to-script"/);

    const ready = await bar({ kind: "ready", source: tiktok, rewrite: done, applied: "topic" });
    expect(ready).toContain("来年3月、大阪に新駅が誕生します。");
    expect(ready).not.toMatch(/disabled=""[^>]*data-testid="intake-to-(topic|script)"/);
    expect(ready).toContain("Đã đưa vào chủ đề.");
  });

  it("rewrite failed: message + [Viết lại]; no content account: topic still possible, script not", async () => {
    const failed = await bar({ kind: "ready", source: tiktok, rewrite: { status: "failed", code: "PROVIDER_RATE_LIMITED", message: "rate limited" }, applied: null });
    expect(failed).toContain("Chưa viết lại được: tài khoản content đang bị giới hạn tốc độ. Thử lại sau ít phút."); // the code is translated, not the provider's English
    const unknown = await bar({ kind: "ready", source: tiktok, rewrite: { status: "failed", code: "SOMETHING_NEW", message: "raw reason" }, applied: null });
    expect(unknown).toContain("Chưa viết lại được: raw reason");
    expect(failed).toContain(">Viết lại</button>");
    const skipped = await bar({ kind: "ready", source: tiktok, rewrite: { status: "skipped", reason: "no_content_account" }, applied: null });
    expect(skipped).toContain("Chưa có tài khoản content để viết lại");
    expect(skipped).not.toMatch(/disabled=""[^>]*data-testid="intake-to-topic"/);
    expect(skipped).toMatch(/disabled=""[^>]*data-testid="intake-to-script"/);
  });

  it("is translated in vi / en / ja / ko with the same keys and placeholders", async () => {
    const flatten = (value: unknown, prefix = ""): Record<string, string> =>
      Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((out, [key, entry]) => (typeof entry === "string" ? { ...out, [prefix + key]: entry } : { ...out, ...flatten(entry, `${prefix}${key}.`) }), {});
    const vi = flatten(locales.vi.intake);
    for (const lng of ["en", "ja", "ko"] as const) {
      const strings = flatten(locales[lng].intake);
      expect(Object.keys(strings).sort(), lng).toEqual(Object.keys(vi).sort());
      for (const [key, value] of Object.entries(vi)) expect([...(strings[key]!.match(/{{\w+}}/g) ?? [])].sort(), `${lng}.${key}`).toEqual([...(value.match(/{{\w+}}/g) ?? [])].sort());
      const html = await bar({ kind: "ready", source: tiktok, rewrite: done, applied: "script" }, lng);
      expect(html).not.toMatch(/[>"]intake\./);
    }
  });
});

describe("VE2E-96 news drawer", () => {
  it("opens as a dialog with the news feed (filters + search) and a close button", async () => {
    const html = await render(<NewsDrawer initialQuery="大谷" selectedId={null} onUse={noop} onClose={noop} />);
    expect(html).toMatch(/role="dialog" aria-modal="true"[^>]*data-testid="news-drawer"/);
    expect(html).toContain('data-testid="news-filters"');
    expect(html).toContain('value="大谷"');
    expect(network.calls).not.toHaveBeenCalled();
  });
});

describe("VE2E-96 'Đưa vào chủ đề' / 'Đưa vào kịch bản'", () => {
  it("topic: the rewritten script cut to 400 characters at a boundary, the source named; Auto topic source / Studio topic mode", () => {
    const longScript: UrlIntakeRewrite = { ...done, script: "大阪に新しい駅ができます。".repeat(60) };
    const topic = intakeTopic(tiktok, longScript);
    expect([...topic].length).toBeLessThanOrEqual(400);
    expect(topic.endsWith(`Source: TikTok · @osaka.news - ${tiktok.sourceUrl}`)).toBe(true);
    expect(topic.split("\n\n")[0]!.endsWith("。…")).toBe(true);
    expect(intakeApply(auto, tiktok, done, "topic", {})).toMatchObject({ needsConfirm: false, patch: { autoSourceType: "topic", selectedNews: "" } });
    expect(intakeApply(studio, tiktok, done, "topic", {})).toMatchObject({ patch: { mode: "topic" } });
    expect(intakeTopic(tiktok, { status: "skipped", reason: "no_content_account" })).toContain("大阪に新しい駅ができます。");
  });

  it("script: Auto raw_script source; Studio 'revise' with a topic only when the topic is empty; needs a rewrite", () => {
    expect(intakeApply(auto, tiktok, done, "script", {})).toEqual({ patch: { autoSourceType: "raw_script", autoRawScript: done.script, selectedNews: "" }, needsConfirm: false, written: done.script });
    const studioScript = intakeApply(studio, tiktok, done, "script", {})!;
    expect(studioScript.patch).toMatchObject({ mode: "revise", existingScript: done.script });
    expect(studioScript.patch.topic).toContain("新駅を紹介");
    expect(intakeApply({ ...studio, topic: "chủ đề có sẵn" }, tiktok, done, "script", {})!.patch).not.toHaveProperty("topic");
    expect(intakeApply(auto, tiktok, { status: "pending" }, "script", {})).toBeNull();
  });

  it("asks before overwriting what the user typed - not what this panel wrote itself", () => {
    expect(intakeApply({ ...auto, topic: "chủ đề tự gõ" }, tiktok, done, "topic", {})!.needsConfirm).toBe(true);
    const first = intakeApply(auto, tiktok, done, "topic", {})!;
    expect(intakeApply({ ...auto, topic: first.written }, tiktok, { ...done, script: "別の台本です。" }, "topic", { topic: first.written })!.needsConfirm).toBe(false);
    expect(intakeApply({ ...auto, autoRawScript: "kịch bản tự viết" }, tiktok, done, "script", {})!.needsConfirm).toBe(true);
    expect(intakeApply({ ...studio, existingScript: "kịch bản tự viết" }, tiktok, done, "script", {})!.needsConfirm).toBe(true);
  });

  it("a news-feed source keeps its news item in the draft", () => {
    const item: NewsItemResponse = { id: "yahoo_jp:articles:a1", sourceId: "yahoo_jp", source: "Yahoo!ニュース", publisher: "架空", title: "見出し", excerpt: "概要", thumbnailUrl: null, sourceUrl: "https://news.yahoo.co.jp/articles/a1", publishedAt: null, category: "sports" };
    const news: UrlIntakeSource = { ...tiktok, sourceType: "article", method: "news_feed", newsItem: item, sourceUrl: item.sourceUrl };
    expect(intakeApply(auto, news, { status: "skipped", reason: "no_content_account" }, "topic", {})!.patch).toMatchObject({ selectedNews: serializeSelectedNews(item), topic: expect.stringContaining("見出し") });
  });
});

describe("intake progress (what really happened)", () => {
  const steps = (state: IntakeState) => intakeProgress(state).map((step) => `${step.id}:${step.status}`).join(" > ");
  it("TikTok while running: reading > subtitles > (speech only once reached) > rewriting > done", () => {
    expect(steps({ kind: "loading", stage: "reading", sourceType: "tiktok" })).toBe("reading:current > subtitles:pending > rewriting:pending > done:pending");
    expect(steps({ kind: "loading", stage: "speech", sourceType: "tiktok" })).toBe("reading:done > subtitles:done > speech:current > rewriting:pending > done:pending");
    expect(steps({ kind: "error", code: "stt_provider_not_configured", message: "x", stage: "subtitles", sourceType: "tiktok" })).toBe("reading:done > subtitles:failed > rewriting:pending > done:pending");
  });

  it("TikTok result: subtitles used, or no subtitles -> speech; then the rewrite", () => {
    expect(steps({ kind: "ready", source: tiktok, rewrite: { status: "pending" }, applied: null })).toBe("reading:done > subtitles:done > rewriting:current > done:pending");
    expect(steps({ kind: "ready", source: { ...tiktok, method: "speech_to_text" }, rewrite: done, applied: null })).toBe("reading:done > subtitles:skipped > speech:done > rewriting:done > done:done");
    expect(steps({ kind: "ready", source: tiktok, rewrite: { status: "failed", code: "PROVIDER_TIMEOUT", message: "x" }, applied: null })).toBe("reading:done > subtitles:done > rewriting:failed > done:pending");
  });

  it("an article: reading > rewriting > done; nothing before analysing", () => {
    expect(steps({ kind: "loading", stage: "reading", sourceType: "article" })).toBe("reading:current > rewriting:pending > done:pending");
    expect(steps({ kind: "ready", source: { ...tiktok, sourceType: "article", method: "article_extractor" }, rewrite: done, applied: null })).toBe("reading:done > rewriting:done > done:done");
    expect(intakeProgress({ kind: "idle" })).toEqual([]);
  });
});
