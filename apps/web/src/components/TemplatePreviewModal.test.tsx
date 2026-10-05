import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import { RELEASED_RECIPES } from "@lyonix/render-recipes";

const api = vi.hoisted(() => ({ pinTemplateSnapshot: vi.fn(), fetchCreatomatePreviewConfig: vi.fn(async () => ({ configured: false, publicToken: null })) }));
vi.mock("../studio/timeline-api", () => api);

const { TemplatePreviewModal, TemplateThumb } = await import("./TemplatePreviewModal");
const { RecipePreview } = await import("./RecipePreview");
const { locales } = await import("../i18n/locales");

const instance = i18n.createInstance();
await instance.init({ lng: "vi", resources: { vi: { translation: locales.vi } }, interpolation: { escapeValue: false } });

const recipe = RELEASED_RECIPES[0]!;
const templates = [
  { externalTemplateId: "tpl-a", name: "Tin tức A", previewUrl: "https://cdn.example/a.jpg", tags: ["news"], engine: "creatomate" as const },
  { externalTemplateId: `recipe:${recipe.id}@${recipe.version}`, name: recipe.name, previewUrl: null, tags: ["lyonix"], engine: "lyonix" as const },
  { externalTemplateId: "orshot-1", name: "Orshot không ảnh", previewUrl: null, tags: [], engine: "orshot" as const },
];

const html = (index: number, extra: { selectedId?: string | null; onSelect?: () => void } = {}) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={instance}>
      <TemplatePreviewModal templates={templates} index={index} onIndexChange={() => undefined} selectedId={extra.selectedId ?? null} onSelect={extra.onSelect ?? (() => undefined)} onClose={() => undefined} motionConfig={null} />
    </I18nextProvider>,
  );

describe("TemplatePreviewModal (V04-XX)", () => {
  it("shows a provider template's picture in a 9:16 frame, with loading state, navigation and the explicit choose button", () => {
    const out = html(0);
    expect(out).toContain('data-testid="template-preview"');
    expect(out).toContain('aspect-ratio:9 / 16');
    expect(out).toContain('src="https://cdn.example/a.jpg"');
    expect(out).toContain("lyx-skeleton");
    expect(out).toContain("Chọn template này");
    expect(out).toContain("Template sau");
    expect(out).toContain("1 / 3");
    expect(out).toContain("không render và không tốn credit");
  });

  it("previewing never selects, pins or renders: rendering it calls nothing", () => {
    const onSelect = vi.fn();
    html(0, { onSelect });
    html(1, { onSelect });
    expect(onSelect).not.toHaveBeenCalled();
    expect(api.pinTemplateSnapshot).not.toHaveBeenCalled();
  });

  it("a LyOnix template is drawn from its recipe and labelled as a simulation", () => {
    const out = html(1);
    expect(out).toContain('data-testid="recipe-preview"');
    expect(out).toContain("Mô phỏng");
    expect(out).toContain("không phải video render thật");
  });

  it("a template without any picture shows a clear fallback, never a broken image", () => {
    const out = html(2);
    expect(out).toContain('data-testid="template-preview-fallback"');
    expect(out).toContain("Template này chưa có ảnh xem trước.");
    expect(out).not.toContain("<img");
  });

  it("the template already in use is marked instead of offering to choose it again", () => {
    const out = html(0, { selectedId: "tpl-a" });
    expect(out).toContain('data-testid="template-preview-selected"');
    expect(out).toContain("Đang dùng template này");
    expect(out).not.toContain('data-testid="template-preview-select"');
  });

  it("card thumbnails use the same source: image, recipe simulation, or a label", () => {
    expect(renderToStaticMarkup(<TemplateThumb template={templates[0]!} fallbackLabel="Xem trước" />)).toContain("<img");
    expect(renderToStaticMarkup(<TemplateThumb template={templates[1]!} fallbackLabel="Xem trước" />)).toContain('data-testid="recipe-preview"');
    expect(renderToStaticMarkup(<TemplateThumb template={templates[2]!} fallbackLabel="Xem trước" />)).toBe("<span>Xem trước</span>");
  });
});

describe("RecipePreview (V04-XX)", () => {
  it("every released recipe renders with the sample headline and a caption of at most 2 lines", () => {
    for (const item of RELEASED_RECIPES) {
      const out = renderToStaticMarkup(<RecipePreview recipe={item} />);
      expect(out, item.id).toContain(`viewBox="0 0 ${item.canvas.width} ${item.canvas.height}"`);
      const captionLines = out.match(/data-testid="recipe-preview-caption"/g) ?? [];
      expect(captionLines.length, item.id).toBeGreaterThan(0);
      expect(captionLines.length, item.id).toBeLessThanOrEqual(2);
    }
  });

  it("text layers use the engine's line breaker: the headline fits its layer's maxLines instead of being clipped", () => {
    for (const item of RELEASED_RECIPES) {
      const out = renderToStaticMarkup(<RecipePreview recipe={item} />);
      const headline = item.layers.find((layer) => layer.type === "text" && layer.slot === "headline");
      if (!headline || headline.type !== "text") continue;
      const lines = out.match(/data-testid="recipe-preview-layer-text"/g) ?? [];
      expect(lines.length, item.id).toBeGreaterThan(0);
      expect(out, item.id).not.toContain("<foreignObject");
      // Every headline character survives the layout (nothing cut off at the layer edge).
      const drawn = [...out.matchAll(/data-testid="recipe-preview-layer-text"[^>]*>([^<]*)</g)].map((match) => match[1]).join("");
      for (const char of "東京の夜景過去最多の観光客") expect(drawn, item.id).toContain(char);
    }
  });
});

describe("template preview translations (V04-XX)", () => {
  it("has every preview key in vi/en/ja/ko with the same placeholders", () => {
    const keys = Object.keys(locales.vi.templates).filter((key) => key.startsWith("preview") || key === "choose");
    expect(keys.length).toBeGreaterThanOrEqual(20);
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].templates as Record<string, string>;
      for (const key of keys) {
        expect(strings[key], `${locale}.templates.${key}`).toBeTruthy();
        const vi = (locales.vi.templates as Record<string, string>)[key]!;
        expect([...(strings[key]!.match(/{{\w+}}/g) ?? [])].sort(), `${locale}.templates.${key}`).toEqual([...(vi.match(/{{\w+}}/g) ?? [])].sort());
      }
    }
  });
});
