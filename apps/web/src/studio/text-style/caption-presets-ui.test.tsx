import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import { CAPTION_PRESETS, captionPresetById } from "@lyonix/domain/caption-presets";
import { captionDefaultsFromRecipeCaptions } from "@lyonix/domain/caption-style";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1 } from "@lyonix/render-recipes";

// Choosing / previewing a preset is local: no render job, no provider, no AI/TTS - any network module touched would be recorded here.
const network = vi.hoisted(() => ({ calls: vi.fn() }));
vi.mock("../timeline-api", () => new Proxy({}, { get: () => network.calls }));
vi.mock("../../api", () => ({ api: network.calls, csrfHeaders: network.calls, ApiError: class extends Error {} }));
vi.mock("../../video-productions-api", () => new Proxy({}, { get: () => network.calls }));

const { CaptionPresetPicker } = await import("../../components/CaptionPresetPicker");
const { TextStylePanel } = await import("./TextStylePanel");
const { applyVideoCaptionPreset, applyVideoEdit } = await import("./caption-style-model");
const { locales } = await import("../../i18n/locales");

const defaults = captionDefaultsFromRecipeCaptions(NEWS_RECAP_BROADCAST_TELOP_JP_V1.captions);
const withI18n = async (lng: "vi" | "en" | "ja" | "ko", node: React.ReactNode) => {
  const instance = i18n.createInstance();
  await instance.init({ lng, resources: { [lng]: { translation: locales[lng] } }, interpolation: { escapeValue: false } });
  return renderToStaticMarkup(<I18nextProvider i18n={instance}>{node}</I18nextProvider>);
};
const picker = (engine: "lyonix" | "creatomate" | "orshot" | null, selectedId = "", lng: "vi" | "en" | "ja" | "ko" = "vi") =>
  withI18n(lng, <CaptionPresetPicker selectedId={selectedId} engine={engine} defaults={null} onChoose={() => undefined} />);
const panel = (engine: "lyonix" | "creatomate" | "orshot", optionValues: Record<string, string> = {}, lng: "vi" | "en" | "ja" | "ko" = "vi") =>
  withI18n(
    lng,
    <TextStylePanel
      ctx={{ engine, defaults, optionValues }}
      scene={{ sceneId: "s1", index: 0, patch: null, text: "今日のニュース" }}
      allTexts={["今日のニュース"]}
      anySceneOverride={false}
      hasFallback={false}
      pending={null}
      onPreview={() => undefined}
      onCommit={() => undefined}
      onResetScene={() => undefined}
      onResetVideo={() => undefined}
    />,
  );
const cardsOf = (html: string) => [...html.matchAll(/data-testid="caption-preset-card" data-preset="([^"]+)"/g)].map((m) => m[1]);
const studioOptionsOf = (html: string) => [...html.matchAll(/data-testid="caption-preset-option" data-preset="([^"]+)"/g)].map((m) => m[1]);
const disabledStudioOptions = (html: string) => [...html.matchAll(/<button[^>]*disabled=""[^>]*data-testid="caption-preset-option" data-preset="([^"]+)"/g)].map((m) => m[1]);

describe("VE2E-94 caption presets in Auto (create video)", () => {
  it("(5, 16) VE2E-96 compact: the template default + every preset as a chip (swatch, name, description), ONE local preview", async () => {
    const html = await picker("lyonix");
    expect(cardsOf(html)).toEqual(["template", ...CAPTION_PRESETS.map((item) => item.id)]);
    // one VE2E-93 caption preview for the style being looked at - not one large card per preset
    expect((html.match(/data-testid="scene-caption-preview"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/data-testid="caption-preset-preview" data-preset="template"/);
    expect((html.match(/data-testid="caption-preset-swatch"/g) ?? []).length).toBe(7);
    const strings = locales.vi.captionPresets.items;
    for (const item of CAPTION_PRESETS) {
      expect(html).toContain(strings[item.id as keyof typeof strings].name);
      expect(html).toContain(`title="${strings[item.id as keyof typeof strings].description}"`);
    }
    expect(html).not.toContain('data-testid="caption-preset-compat"'); // the template default has no compatibility chips
    const chosen = await picker("lyonix", "news-bold");
    expect(chosen).toMatch(/data-testid="caption-preset-preview" data-preset="news-bold"/);
    expect((chosen.match(/data-testid="caption-preset-compat"/g) ?? []).length).toBe(1);
    expect(network.calls).not.toHaveBeenCalled();
  });

  it("(12, 13, 14) karaoke works on LyOnix, is disabled with the reason on Creatomate; Orshot disables every preset", async () => {
    const lyonix = await picker("lyonix");
    expect(lyonix).not.toContain('aria-disabled="true"'); // every preset, karaoke included, can be chosen
    const creatomate = await picker("creatomate");
    expect(creatomate).toMatch(/data-preset="karaoke-highlight"[\s\S]*?Creatomate không tô sáng từng từ/);
    expect((creatomate.match(/aria-disabled="true"/g) ?? []).length).toBe(1);
    const orshot = await picker("orshot");
    expect((orshot.match(/aria-disabled="true"/g) ?? []).length).toBe(6); // only the template default stays
    expect(orshot).toContain(locales.vi.studioPro.textStyleReasonProviderUnsupported);
  });

  it("shows the selected state, and asks for a template before judging compatibility", async () => {
    const html = await picker(null, "news-bold");
    expect(html).toMatch(/role="radio" aria-checked="true" aria-disabled="false"[^>]*data-preset="news-bold"/);
    expect(html).toContain(locales.vi.captionPresets.pickTemplateFirst);
  });

  it("(19-22) is translated in vi / en / ja / ko", async () => {
    for (const lng of ["vi", "en", "ja", "ko"] as const) {
      const html = await picker("creatomate", "", lng);
      const strings = locales[lng].captionPresets;
      for (const item of CAPTION_PRESETS) expect(html, `${lng}: ${item.id}`).toContain(strings.items[item.id as keyof typeof strings.items].name);
      expect(html).toContain(strings.templateDefault);
      expect(html).not.toContain("captionPresets.");
    }
  });
});

describe("VE2E-94 caption presets in Studio (text style panel)", () => {
  it("(6) lists the same catalog as Auto, in the whole-video scope", async () => {
    const html = await panel("lyonix");
    expect(studioOptionsOf(html)).toEqual(CAPTION_PRESETS.map((item) => item.id));
    expect(html).toContain('data-status="template"');
    expect(disabledStudioOptions(html)).toEqual([]);
  });

  it("(7, 9) shows the chosen preset, then 'customised from' with a restore button after a manual edit", async () => {
    const ctx = { engine: "lyonix" as const, defaults, optionValues: {} };
    const applied = applyVideoCaptionPreset(ctx, captionPresetById("news-bold")!);
    const chosen = await panel("lyonix", applied);
    expect(chosen).toContain('data-status="preset"');
    expect(chosen).toMatch(/aria-pressed="true"[^>]*data-preset="news-bold"/);
    const edited = applyVideoEdit({ ...ctx, optionValues: applied }, { scope: "video", sceneId: null, changes: [{ field: "fontSizePx", value: 100 }] });
    const custom = await panel("lyonix", edited, "en");
    expect(custom).toContain("Customised (from Bold news)");
    expect(custom).toContain("Restore Bold news");
  });

  it("(13-15) Creatomate disables only karaoke; Orshot disables every preset (as the rest of the panel)", async () => {
    expect(disabledStudioOptions(await panel("creatomate"))).toEqual(["karaoke-highlight"]);
    expect(disabledStudioOptions(await panel("orshot"))).toEqual(CAPTION_PRESETS.map((item) => item.id));
  });

  it("(8) previewing and choosing in Studio never reaches the network (no render job)", async () => {
    await panel("lyonix");
    expect(network.calls).not.toHaveBeenCalled();
  });
});

describe("VE2E-94 translations (19-22)", () => {
  it("has every caption preset string in vi/en/ja/ko with the same placeholders, and a name + description per preset", () => {
    const flatten = (value: unknown, prefix = ""): Record<string, string> =>
      Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((out, [key, entry]) => (typeof entry === "string" ? { ...out, [prefix + key]: entry } : { ...out, ...flatten(entry, `${prefix}${key}.`) }), {});
    const vi = flatten(locales.vi.captionPresets);
    for (const item of CAPTION_PRESETS) {
      expect(vi[item.nameKey.replace("captionPresets.", "")], item.nameKey).toBeTruthy();
      expect(vi[item.descriptionKey.replace("captionPresets.", "")], item.descriptionKey).toBeTruthy();
    }
    for (const lng of ["en", "ja", "ko"] as const) {
      const strings = flatten(locales[lng].captionPresets);
      expect(Object.keys(strings).sort()).toEqual(Object.keys(vi).sort());
      for (const [key, value] of Object.entries(vi)) expect([...(strings[key]!.match(/{{\w+}}/g) ?? [])].sort(), `${lng}.${key}`).toEqual([...(value.match(/{{\w+}}/g) ?? [])].sort());
    }
  });
});
