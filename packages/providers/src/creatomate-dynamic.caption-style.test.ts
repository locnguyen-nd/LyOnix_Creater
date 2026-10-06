import { describe, expect, it } from "vitest";
import {
  applyDynamicStyleOverrides,
  buildDynamicCompositionWithWarnings,
  captionDefaultsFromCreatomateTemplate,
  extractDynamicStyleFromTemplate,
  isDynamicStyleOptionKey,
  isValidDynamicStyleOptionValue,
  type DynamicSceneInput,
} from "./creatomate-dynamic.js";
import { newsRecapJpTemplate } from "./fixtures/creatomate-templates.js";

/** VE2E-93 (21): the canonical caption style reaches every Creatomate caption element, whole video and per scene. */

type Node = Record<string, any>;

const scenes = (overrides: Array<Partial<DynamicSceneInput>> = []): DynamicSceneInput[] =>
  [0, 1, 2].map((index) => ({
    sceneId: `s${index + 1}`,
    mediaUrl: `https://lyonix.test/media/${index + 1}`,
    mediaKind: "image" as const,
    text: index === 0 ? "今日の注目ニュースをわかりやすく紹介します。背景と今後の動きを短くまとめました。" : `ナレーション ${index + 1}`,
    audioUrl: `https://lyonix.test/audio/${index + 1}`,
    audioDurationMs: 4000,
    ...overrides[index],
  }));

const captionsOf = (source: Record<string, unknown>, sceneIndex: number): Node[] => {
  const scene = (source.elements as Node[]).filter((el) => el.type === "composition")[sceneIndex]!;
  // template-scaled captions are named Subtitles-N(-k); style-only captions are the scene's (unnamed) text elements
  return (scene.elements as Node[]).filter((el) => el.type === "text" && (el.name === undefined || /^Subtitles/.test(String(el.name))));
};

const build = (raw: unknown, optionValues: Record<string, string>, input = scenes()) =>
  buildDynamicCompositionWithWarnings(input, applyDynamicStyleOverrides(extractDynamicStyleFromTemplate(raw), optionValues), { width: 1080, height: 1920 });

const WHOLE_VIDEO = {
  "dynamicStyle.captionFontId": "noto-sans-jp",
  "dynamicStyle.captionFontSizePx": "54",
  "dynamicStyle.captionStrokeColor": "#112233",
  "dynamicStyle.captionStrokeWidthPx": "6",
  "dynamicStyle.captionPosition": "top",
};

describe.each([
  ["template-scaled", newsRecapJpTemplate()],
  ["style-only", {}],
])("VE2E-93 Creatomate caption style (%s)", (_mode, raw) => {
  it("writes font, size (vmin of the 1080 reference), stroke and position onto every caption", () => {
    const { source, warnings } = build(raw, WHOLE_VIDEO);
    expect(warnings).not.toContain("caption_highlight_unsupported");
    for (const index of [0, 1, 2]) {
      for (const node of captionsOf(source, index)) {
        expect(node).toMatchObject({ font_family: "Noto Sans JP", font_size: "5 vmin", stroke_color: "#112233", stroke_width: "1.111 vmin", y: "10%", y_anchor: "0%", y_alignment: "0%" });
      }
    }
  });

  it("a scene's own style only changes that scene", () => {
    const { source } = build(raw, WHOLE_VIDEO, scenes([{}, { captionStyle: { fillColor: "#FF0000", position: "bottom", strokeEnabled: false } }]));
    const [first] = captionsOf(source, 0);
    const [second] = captionsOf(source, 1);
    expect(first).toMatchObject({ y: "10%", stroke_color: "#112233" });
    expect(second).toMatchObject({ fill_color: "#FF0000", y: "80%", y_anchor: "100%", y_alignment: "100%", font_size: "5 vmin" });
    expect(second).not.toHaveProperty("stroke_color");
    expect(second).not.toHaveProperty("stroke_width");
  });

  it("(11) one line per page when the style asks for it", () => {
    const two = captionsOf(build(raw, { "dynamicStyle.captionFontSizePx": "96" }).source, 0);
    const one = captionsOf(build(raw, { "dynamicStyle.captionFontSizePx": "96", "dynamicStyle.captionMaxLines": "1" }).source, 0);
    expect(two.every((node) => String(node.text).split("\n").length <= 2)).toBe(true);
    expect(one.every((node) => !String(node.text).includes("\n"))).toBe(true);
    expect(one.length).toBeGreaterThan(two.length);
  });

  it("(13) never draws a word highlight; asking for it is reported, not silently dropped", () => {
    const { warnings } = build(raw, {}, scenes([{ captionStyle: { animation: "word_highlight" } }]));
    expect(warnings).toContain("caption_highlight_unsupported");
    expect(build(raw, { "dynamicStyle.captionAnimation": "word_highlight" }).warnings).toContain("caption_highlight_unsupported");
  });
});

describe("VE2E-93 Creatomate option keys and template defaults", () => {
  it("validates the new keys with the shared caption rules", () => {
    expect(isDynamicStyleOptionKey("dynamicStyle.captionFontSizePx")).toBe(true);
    expect(isDynamicStyleOptionKey("dynamicStyle.captionBackground")).toBe(false);
    expect(isValidDynamicStyleOptionValue("dynamicStyle.captionFontSizePx", "54")).toBe(true);
    expect(isValidDynamicStyleOptionValue("dynamicStyle.captionFontSizePx", "999")).toBe(false);
    expect(isValidDynamicStyleOptionValue("dynamicStyle.captionPosition", "left")).toBe(false);
    expect(isValidDynamicStyleOptionValue("dynamicStyle.captionAnimation", "")).toBe(true);
    expect(isValidDynamicStyleOptionValue("dynamicStyle.imageAnimation", "none")).toBe(true);
  });

  it("derives the template's caption defaults in canonical units", () => {
    const defaults = captionDefaultsFromCreatomateTemplate(newsRecapJpTemplate());
    // Subtitles-1: font_size 6.2 vmin, stroke_width 1.2 vmin (centred: 6 px outside), y 6% with no fixed height
    expect(defaults).toMatchObject({ fontFamily: "Noto Sans JP", fontSizePx: 67, minFontSizePx: 67, bold: true, fillColor: "#ffffff", maxLines: 2, animation: "none", highlightColor: null });
    expect(defaults.stroke).toEqual({ enabled: true, color: "#000000", widthPx: 6 });
    expect(defaults.position).toEqual({ anchor: "center", percent: 6 });
    const generic = captionDefaultsFromCreatomateTemplate({});
    expect(generic).toMatchObject({ fontFamily: "Montserrat", fontSizePx: 86 });
    expect(generic.position.percent).toBeCloseTo(57, 0);
  });
});
