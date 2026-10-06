import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import { CATEGORY_SAMPLES, RELEASED_RECIPES, recipeCatalogEntry } from "@lyonix/render-recipes";

const api = vi.hoisted(() => ({ pinTemplateSnapshot: vi.fn(), fetchCreatomatePreviewConfig: vi.fn(async () => ({ configured: false, publicToken: null })) }));
vi.mock("../studio/timeline-api", () => api);

const { TemplatePreviewModal, TemplateThumb } = await import("./TemplatePreviewModal");
const { TemplateCard, CategoryChips } = await import("./TemplateCard");
const { TemplateSearch, TemplateSearchEmpty } = await import("./TemplateSearch");
const { ProviderBadge } = await import("./ProviderBadge");
const { RecipePreview } = await import("./RecipePreview");
const { locales } = await import("../i18n/locales");

const instance = i18n.createInstance();
await instance.init({ lng: "vi", resources: { vi: { translation: locales.vi } }, interpolation: { escapeValue: false } });

const recipe = RELEASED_RECIPES[0]!;
const sports = RELEASED_RECIPES.find((item) => item.id === "sports-highlight-score-headline-jp")!;
const ready = { ready: true, reason: null, rolloutPercent: 100, hasFallback: false } as const;
const templates = [
  { externalTemplateId: "tpl-a", name: "Tin tức A", previewUrl: "https://cdn.example/a.jpg", tags: ["news"], engine: "creatomate" as const },
  { externalTemplateId: `recipe:${recipe.id}@${recipe.version}`, name: recipe.name, previewUrl: null, tags: ["lyonix"], engine: "lyonix" as const, internalRender: ready },
  { externalTemplateId: "orshot-1", name: "Orshot không ảnh", previewUrl: null, tags: [], engine: "orshot" as const },
  { externalTemplateId: `recipe:${sports.id}@${sports.version}`, name: sports.name, previewUrl: null, tags: ["lyonix"], engine: "lyonix" as const, internalRender: { ready: false, reason: "rollout_off", rolloutPercent: 0, hasFallback: false } as const },
];

const wrap = (node: React.ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={instance}>{node}</I18nextProvider>);
const html = (index: number, extra: { selectedId?: string | null; onSelect?: () => void; selectLabel?: string } = {}) =>
  wrap(<TemplatePreviewModal templates={templates} index={index} onIndexChange={() => undefined} selectedId={extra.selectedId ?? null} onSelect={extra.onSelect ?? (() => undefined)} onClose={() => undefined} motionConfig={null} {...(extra.selectLabel ? { selectLabel: extra.selectLabel } : {})} />);

describe("TemplatePreviewModal (V04-XX, V04-01)", () => {
  it("shows a provider template's picture in a 9:16 frame, with loading state, navigation and the explicit choose button", () => {
    const out = html(0);
    expect(out).toContain('data-testid="template-preview"');
    expect(out).toContain("aspect-ratio:9 / 16");
    expect(out).toContain('src="https://cdn.example/a.jpg"');
    expect(out).toContain("lyx-skeleton");
    expect(out).toContain("Chọn template này");
    expect(out).toContain("Đóng");
    expect(out).toContain("Template sau");
    expect(out).toContain("1 / 4");
    expect(out).toContain("không render và không tốn credit");
  });

  it("previewing never selects, pins or renders: rendering it calls nothing", () => {
    const onSelect = vi.fn();
    for (const index of [0, 1, 2, 3]) html(index, { onSelect });
    expect(onSelect).not.toHaveBeenCalled();
    expect(api.pinTemplateSnapshot).not.toHaveBeenCalled();
  });

  it("a LyOnix template opens on its motion simulation, labelled as a simulation, with the LyOnix preview source", () => {
    const out = html(1);
    expect(out).toContain('data-testid="recipe-preview"');
    expect(out).toContain("Mô phỏng");
    expect(out).toMatch(/aria-selected="true"[^>]*>Chuyển động</);
    expect(out).toContain("chỉ dùng hiệu ứng mà engine LyOnix render được");
    expect(out).toMatch(/data-testid="template-preview-source"[^>]*>Mô phỏng LyOnix \(trên trình duyệt\)</);
  });

  it("keeps the render engine and the preview source apart: a Creatomate picture is the provider's image, a LyOnix one never claims a provider render", () => {
    const creatomate = html(0);
    expect(creatomate).toMatch(/data-testid="engine-badge" data-provider="creatomate"/);
    expect(creatomate).toContain(">Creatomate</span>");
    expect(creatomate).toMatch(/data-testid="template-preview-source"[^>]*>Ảnh preview của Creatomate</);
    const lyonix = html(1);
    expect(lyonix).toMatch(/data-testid="engine-badge" data-provider="lyonix"/);
    expect(lyonix).not.toContain("Ảnh preview của Creatomate");
  });

  it("shows the library details of a built-in template: group, tags, 9:16, language, description, suited for, status", () => {
    const out = html(1);
    const info = out.slice(out.indexOf('data-testid="template-preview-info"'));
    for (const text of ["Engine render", "Nhóm", "Tin tức", "Tỉ lệ", "9:16", "Ngôn ngữ", "Tiếng Nhật", "Mô tả", "Phù hợp với", "Nguồn xem trước", "Trạng thái", "Sẵn sàng render"]) expect(info, text).toContain(text);
    expect(info).toContain("telop");
  });

  it("a template that is not ready to render can be previewed but not chosen, with the reason", () => {
    const onSelect = vi.fn();
    const out = html(3, { onSelect });
    expect(out).toContain('data-testid="recipe-preview"');
    expect(out).toContain('data-testid="template-preview-blocked"');
    expect(out).toContain("rollout 0 %");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*data-testid="template-preview-select"/);
    expect(out).toMatch(/data-testid="template-preview-status"[^>]*>Chưa sẵn sàng render</);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a template without any picture shows a clear fallback, never a broken image", () => {
    const out = html(2);
    expect(out).toContain('data-testid="template-preview-fallback"');
    expect(out).toContain("Template này chưa có ảnh xem trước.");
    expect(out).not.toContain("<img");
    expect(out).toContain("Không có ảnh xem trước");
  });

  it("the template already in use is marked instead of offering to choose it again; the Studio gallery can rename the button", () => {
    const out = html(0, { selectedId: "tpl-a" });
    expect(out).toContain('data-testid="template-preview-selected"');
    expect(out).toContain("Đang sử dụng");
    expect(out).not.toContain('data-testid="template-preview-select"');
    expect(html(0, { selectLabel: "Dùng template" })).toContain("Dùng template");
  });

  it("card thumbnails: provider image, recipe simulation, else a styled fallback (never a broken image)", () => {
    expect(wrap(<TemplateThumb template={templates[0]!} />)).toContain('data-testid="template-thumb-image"');
    expect(wrap(<TemplateThumb template={templates[1]!} />)).toContain('data-testid="recipe-preview"');
    const fallback = wrap(<TemplateThumb template={templates[2]!} />);
    expect(fallback).toContain('data-testid="template-fallback-thumb"');
    expect(fallback).not.toContain("<img");
    expect(fallback).toContain("Orshot không ảnh");
    expect(fallback).toContain("9:16");
  });
});

describe("TemplateCard (V04-01)", () => {
  const card = (index: number, selected = false) => wrap(<TemplateCard template={templates[index]!} selected={selected} onPreview={() => undefined} />);

  it("only offers 'Xem trước' - there is no choose button on a card", () => {
    const out = card(1);
    expect(out).toContain("Xem trước");
    expect(out).not.toContain(">Chọn<");
    expect(out).not.toContain("Chọn template này");
    expect((out.match(/<button/g) ?? []).length).toBe(1);
  });

  it("shows name, group · 9:16 and the engine badge", () => {
    const out = card(1);
    expect(out).toContain(recipe.name);
    expect(out).toContain("Tin tức · 9:16");
    expect(out).toMatch(/data-testid="engine-badge" data-provider="lyonix"/);
    expect(out).toContain(">LyOnix Render</span>");
    expect(card(3)).toContain("Thể thao · 9:16");
    expect(card(2)).toContain("Chưa phân nhóm · 9:16");
  });

  it("marks the template in use (border + check) and a template that is not ready", () => {
    expect(card(1, true)).toContain('data-testid="template-card-check"');
    expect(card(1, true)).toContain('data-selected="true"');
    expect(card(1, false)).not.toContain('data-testid="template-card-check"');
    expect(card(3)).toContain('data-testid="template-not-ready"');
    expect(card(3)).toContain("Chưa sẵn sàng render");
    expect(card(1)).not.toContain('data-testid="template-not-ready"');
  });

  it("category chips list the five filters with counts", () => {
    const out = wrap(<CategoryChips filters={["all", "news", "sports", "faceless", "breaking_news"] as const} value="all" counts={{ all: 8, news: 2, sports: 2, faceless: 2, breaking_news: 2 }} onChange={() => undefined} label="Nhóm" />);
    for (const label of ["Tất cả", "Tin tức", "Thể thao", "Faceless", "Breaking News"]) expect(out).toContain(label);
    expect(out).toContain('aria-pressed="true"');
  });
});

describe("RecipePreview (V04-XX, V04-01)", () => {
  it("every released recipe renders a still frame with a caption of at most 2 lines, playing or not (no clock on the server)", () => {
    for (const item of RELEASED_RECIPES) {
      for (const playing of [false, true]) {
        const out = renderToStaticMarkup(<RecipePreview recipe={item} playing={playing} />);
        expect(out, item.id).toContain(`viewBox="0 0 ${item.canvas.width} ${item.canvas.height}"`);
        const captionLines = out.match(/data-testid="recipe-preview-caption"/g) ?? [];
        expect(captionLines.length, item.id).toBeGreaterThan(0);
        expect(captionLines.length, item.id).toBeLessThanOrEqual(2);
        expect(out).not.toContain("<audio");
        expect(out).not.toContain("<video");
        expect(out).not.toMatch(/href="https?:/);
      }
    }
  });

  it("a frame inside a scene change draws both pictures with the recipe's own transition (and only that one)", () => {
    for (const item of RELEASED_RECIPES) {
      const sceneMs = { "news-clean": 2400, "sports-energy": 2000, "faceless-zoom": 3500, "breaking-alert": 2000 }[recipeCatalogEntry(item.id)!.previewPreset];
      const out = renderToStaticMarkup(<RecipePreview recipe={item} atMs={sceneMs + 100} />);
      expect(out, item.id).toContain(`data-transition="${item.transition.kind}"`);
      expect(out, item.id).toContain('data-scene="1"');
      if (item.transition.kind === "wipe" || item.transition.kind === "circle") expect(out, item.id).toContain("reveal-");
      expect(renderToStaticMarkup(<RecipePreview recipe={item} atMs={sceneMs + 1500} />), item.id).toContain('data-transition="none"');
    }
  });

  it("text layers use the engine's line breaker: the group's sample headline fits its layer instead of being clipped", () => {
    for (const item of RELEASED_RECIPES) {
      const out = renderToStaticMarkup(<RecipePreview recipe={item} />);
      const headline = item.layers.find((layer) => layer.type === "text" && layer.slot === "headline");
      if (!headline || headline.type !== "text") continue;
      const lines = out.match(/data-testid="recipe-preview-layer-text"/g) ?? [];
      expect(lines.length, item.id).toBeGreaterThan(0);
      expect(out, item.id).not.toContain("<foreignObject");
      const drawn = [...out.matchAll(/data-testid="recipe-preview-layer-text"[^>]*>([^<]*)</g)].map((match) => match[1]).join("");
      const sample = CATEGORY_SAMPLES[recipeCatalogEntry(item.id)!.category].headline;
      for (const char of sample) expect(drawn, item.id).toContain(char);
    }
  });
});

describe("template search and provider identity (V04-02)", () => {
  it("search box: accessible label, placeholder, magnifier; the clear button only appears with text and has an aria-label", () => {
    const empty = wrap(<TemplateSearch value="" onChange={() => undefined} />);
    expect(empty).toMatch(/<label for="[^"]+" class="sr-only">Tìm template<\/label>/);
    expect(empty).toContain('placeholder="Tìm template theo tên, loại hoặc nhà cung cấp..."');
    expect(empty).toContain('type="search"');
    expect(empty).not.toContain('data-testid="template-search-clear"');
    const typed = wrap(<TemplateSearch value="news" onChange={() => undefined} summary="Kết quả cho “news” · 3 template" />);
    expect(typed).toMatch(/aria-label="Xoá nội dung tìm kiếm"[^>]*data-testid="template-search-clear"/);
    expect(typed).toMatch(/role="status"[^>]*>Kết quả cho “news” · 3 template</);
  });

  it("empty state: title, hint and 'Xóa tìm kiếm'; 'Xóa bộ lọc' only when a group filter is also on", () => {
    const searchOnly = wrap(<TemplateSearchEmpty onClearSearch={() => undefined} />);
    for (const text of ["Không tìm thấy template", "Thử tên khác hoặc xoá bộ lọc tìm kiếm.", "Xóa tìm kiếm"]) expect(searchOnly).toContain(text);
    expect(searchOnly).not.toContain("Xóa bộ lọc");
    expect(wrap(<TemplateSearchEmpty onClearSearch={() => undefined} onClearAll={() => undefined} />)).toContain("Xóa bộ lọc");
  });

  it("provider badge: mark + name for LyOnix Render / Creatomate / Orshot, no external logo URL", () => {
    for (const [engine, name] of [["lyonix", "LyOnix Render"], ["creatomate", "Creatomate"], ["orshot", "Orshot"]] as const) {
      for (const variant of ["inline", "overlay"] as const) {
        const out = wrap(<ProviderBadge engine={engine} variant={variant} />);
        expect(out, `${engine}/${variant}`).toContain(`data-provider="${engine}"`);
        expect(out).toContain(`data-provider-mark="${engine}"`);
        expect(out).toContain(`>${name}</span>`);
        expect(out).not.toMatch(/<img|(src|href)="https?:/); // inline marks only (the SVG xmlns is not a request)
      }
    }
  });

  it("card: provider mark on the picture, provider badge in the details, readiness below the picture, fallback picture without image", () => {
    const creatomate = wrap(<TemplateCard template={templates[0]!} selected={false} onPreview={() => undefined} />);
    expect(creatomate).toMatch(/data-testid="template-card-provider-mark"[^>]*><span aria-hidden="true"[^>]*data-provider-mark="creatomate"/);
    expect(creatomate).toContain('data-testid="template-thumb-image"');
    expect(creatomate).toMatch(/aria-label="Xem trước: Tin tức A · Creatomate"/);
    const orshot = wrap(<TemplateCard template={templates[2]!} selected={false} onPreview={() => undefined} />);
    expect(orshot).toContain('data-testid="template-fallback-thumb"');
    expect(orshot).toContain('data-provider-mark="orshot"');
    expect(orshot).not.toContain("<img");
    const notReady = wrap(<TemplateCard template={templates[3]!} selected={false} onPreview={() => undefined} />);
    expect(notReady.indexOf('data-testid="template-not-ready"')).toBeGreaterThan(notReady.indexOf("</button>")); // not over the picture
  });
});

describe("template preview translations (V04-XX, V04-01)", () => {
  const flatten = (value: unknown, prefix = ""): Record<string, string> =>
    typeof value === "string" ? { [prefix]: value } : Object.assign({}, ...Object.entries(value as Record<string, unknown>).map(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key)));

  it("has every preview / library key in vi/en/ja/ko with the same placeholders", () => {
    const vi = flatten(locales.vi.templates);
    const keys = Object.keys(vi).filter((key) => key.startsWith("preview") || key === "choose" || key.startsWith("library.") || key.startsWith("search."));
    expect(keys.length).toBeGreaterThanOrEqual(60);
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = flatten(locales[locale].templates);
      for (const key of keys) {
        expect(strings[key], `${locale}.templates.${key}`).toBeTruthy();
        expect([...(strings[key]!.match(/{{\w+}}/g) ?? [])].sort(), `${locale}.templates.${key}`).toEqual([...(vi[key]!.match(/{{\w+}}/g) ?? [])].sort());
      }
    }
  });

  it("describes every released recipe in every language", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = flatten(locales[locale].templates);
      for (const item of RELEASED_RECIPES) {
        expect(strings[`library.catalog.${item.id}.description`], `${locale} ${item.id}`).toBeTruthy();
        expect(strings[`library.catalog.${item.id}.suited`], `${locale} ${item.id}`).toBeTruthy();
      }
    }
  });
});
