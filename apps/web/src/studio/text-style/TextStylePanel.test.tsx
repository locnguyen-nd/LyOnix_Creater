import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import { captionDefaultsFromRecipeCaptions, resolveCaptionTextStyle } from "@lyonix/domain/caption-style";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1 } from "@lyonix/render-recipes";

// The panel and the caption preview are purely local: no render job, no provider, no AI/TTS call - any import of them would explode here.
const network = vi.hoisted(() => ({ calls: vi.fn() }));
vi.mock("../timeline-api", () => new Proxy({}, { get: () => network.calls }));
vi.mock("../../api", () => ({ api: network.calls, ApiError: class extends Error {} }));

const { TextStylePanel } = await import("./TextStylePanel");
const { CaptionPreview, layoutCaptionPage } = await import("./CaptionPreview");
const { locales } = await import("../../i18n/locales");

const defaults = captionDefaultsFromRecipeCaptions(NEWS_RECAP_BROADCAST_TELOP_JP_V1.captions);

const render = async (lng: "vi" | "en" | "ja" | "ko", props: Partial<Parameters<typeof TextStylePanel>[0]> = {}) => {
  const instance = i18n.createInstance();
  await instance.init({ lng, resources: { [lng]: { translation: locales[lng] } }, interpolation: { escapeValue: false } });
  return renderToStaticMarkup(
    <I18nextProvider i18n={instance}>
      <TextStylePanel
        ctx={{ engine: "lyonix", defaults, optionValues: {} }}
        scene={{ sceneId: "s1", index: 0, patch: null, text: "今日のニュース" }}
        allTexts={["今日のニュース"]}
        anySceneOverride={false}
        hasFallback={false}
        pending={null}
        onPreview={() => undefined}
        onCommit={() => undefined}
        onResetScene={() => undefined}
        onResetVideo={() => undefined}
        {...props}
      />
    </I18nextProvider>,
  );
};

describe("VE2E-93 TextStylePanel", () => {
  it("(19-22) renders every control with its label in vi / en / ja / ko", async () => {
    for (const lng of ["vi", "en", "ja", "ko"] as const) {
      const html = await render(lng);
      const s = locales[lng].studioPro;
      for (const label of [s.textStyleTitle, s.textStyleScopeVideo, s.textStyleScopeScene, s.textStylePosition, s.textStyleFont, s.textStyleFontSize, s.textStyleFillColor, s.textStyleStroke, s.textStyleMaxLines, s.textStyleAnimation, s.textStyleResetVideo, s.textStyleInherited]) {
        expect(html, `${lng}: ${label}`).toContain(label);
      }
      expect(html).not.toContain("studioPro.");
    }
  });

  it("LyOnix: every control enabled, word highlight available, numbers have a visible range", async () => {
    const html = await render("vi");
    expect(html).toContain('data-engine="lyonix"');
    expect(html).not.toMatch(/<fieldset[^>]*disabled=""[^>]*>/);
    expect(html).toContain(locales.vi.studioPro.textStyleAnimationWordHighlight);
    expect(html).toMatch(/type="range"[^>]*min="32"[^>]*max="128"/);
    expect(html).toMatch(/aria-label="Màu chữ: Mã HEX"/);
  });

  it("(13) Creatomate: the word highlight is disabled with its reason (tooltip + text)", async () => {
    const html = await render("vi", { ctx: { engine: "creatomate", defaults, optionValues: {} } });
    expect(html).toContain(`title="${locales.vi.studioPro.textStyleReasonNoWordHighlight}"`);
    expect(html).toMatch(/role="radio" aria-checked="false" disabled=""[^>]*>Tô sáng từng từ/);
    expect(html).toContain(locales.vi.studioPro.textStyleCreatomateApprox);
  });

  it("(13) Orshot: the panel is read-only with the provider tooltip, and saved values are reported as not applied", async () => {
    const html = await render("vi", { ctx: { engine: "orshot", defaults: null, optionValues: { "dynamicStyle.captionFontSizePx": "80" } } });
    const reason = "Nhà cung cấp này chưa hỗ trợ tùy chỉnh chữ trong Studio";
    expect(html).toContain(`title="${reason}"`);
    expect((html.match(/<fieldset[^>]*disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(7);
    expect(html).toContain(locales.vi.studioPro.textStyleNoticeStoredIgnored);
    expect(html).not.toContain(locales.vi.studioPro.textStyleResetVideo);
  });

  it("without a template it asks for one", async () => {
    const html = await render("en", { ctx: { engine: null, defaults: null, optionValues: {} } });
    expect(html).toContain(locales.en.studioPro.textStyleNeedTemplate);
    expect(html).not.toContain("type=\"range\"");
  });

  it("shows a legacy (VE2E-26) font as the current value with a warning, never swapped", async () => {
    const html = await render("en", { ctx: { engine: "lyonix", defaults, optionValues: { "dynamicStyle.captionFontFamily": "Inter Bold" } } });
    expect(html).toContain("Earlier font: Inter Bold");
    expect(html).toContain("The font &quot;Inter Bold&quot; was saved by an earlier version");
  });

  it("(16) the preview and the panel never reach the network", async () => {
    await render("vi");
    const style = resolveCaptionTextStyle({ engine: "lyonix", defaults, scene: { fillColor: "#FF0000", strokeWidthPx: 8, position: "top" } });
    const page = layoutCaptionPage("今日の注目ニュースをわかりやすく紹介します。背景と今後の動きを短くまとめました。", style, "lyonix")!;
    const svg = renderToStaticMarkup(<CaptionPreview page={page} style={style} engine="lyonix" spokenChars={3} />);
    expect(network.calls).not.toHaveBeenCalled();
    expect(svg).toContain('fill="#FF0000"');
    expect(svg).toContain('stroke-width="16"');
    expect(svg).toContain('data-anchor="top"');
    expect(svg).toContain("Noto Sans JP");
    expect(svg).toContain(`fill="${defaults.highlightColor}"`); // the spoken part, as the LyOnix karaoke draws it
    expect((svg.match(/<text /g) ?? []).length).toBeLessThanOrEqual(2);
  });
});

describe("VE2E-93 translations", () => {
  it("(19-22) has every text style key in vi/en/ja/ko with the same placeholders", () => {
    const keys = Object.keys(locales.vi.studioPro).filter((key) => key.startsWith("textStyle"));
    expect(keys.length).toBeGreaterThanOrEqual(57);
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].studioPro as Record<string, string>;
      for (const key of keys) {
        expect(strings[key], `${locale}.${key}`).toBeTruthy();
        const vi = (locales.vi.studioPro as Record<string, string>)[key]!;
        expect([...(strings[key]!.match(/{{\w+}}/g) ?? [])].sort(), `${locale}.${key}`).toEqual([...(vi.match(/{{\w+}}/g) ?? [])].sort());
      }
    }
  });
});
