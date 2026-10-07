import { describe, expect, it } from "vitest";
import { buildCaptionAss } from "./caption-ass.js";
import { CAPTION_FONTS, captionFontByFamily, captionFontById, detectCaptionScripts, unverifiedCaptionScripts } from "./caption-fonts.js";
import { CAPTION_STYLE_CAPABILITIES, CAPTION_STYLE_FIELDS, captionStyleEngineFor, captionStyleFieldReason } from "./caption-style-capabilities.js";
import {
  applyCaptionStyleEdit,
  CAPTION_POSITION_LAYOUT,
  captionAssStyle,
  captionDefaultsFromRecipeCaptions,
  captionLayoutOptions,
  captionStyleFieldValue,
  captionStyleFromOptionValues,
  captionStylePatchToOptionValues,
  clearCaptionStyleOptionValues,
  isValidCaptionStyleOptionValue,
  legacyCaptionFontFamily,
  normalizeCaptionTextStylePatch,
  normalizeHexColor,
  resolveCaptionTextStyle,
  setCaptionStyleOptionValue,
  SYSTEM_CAPTION_DEFAULTS,
  unsupportedCaptionPatchFields,
  validateCaptionTextStylePatch,
  type CaptionTemplateDefaults,
} from "./caption-style.js";
import { duplicateScene, splitScene, type TimelineEditScene, type TimelineEditState } from "./timeline-edit.js";

const recipeCaptions = {
  fontFamily: "Noto Sans CJK JP",
  fontSizePx: 72,
  minFontSizePx: 48,
  maxLines: 2,
  bold: true,
  textColor: "#FFFFFF",
  highlightColor: "#FFD400",
  outlineColor: "#000000",
  outlinePx: 6,
  highlight: "word" as const,
  placement: { anchor: "top" as const, marginPct: 38 },
};
const defaults: CaptionTemplateDefaults = captionDefaultsFromRecipeCaptions(recipeCaptions);

describe("VE2E-93 caption style inheritance", () => {
  it("(1) a global style applies to every scene without an override", () => {
    const global = { fontSizePx: 90, fillColor: "#00FF00" };
    for (const scene of [null, undefined, {}]) {
      const style = resolveCaptionTextStyle({ engine: "lyonix", defaults, global, scene });
      expect(style.fontSizePx).toBe(90);
      expect(style.fillColor).toBe("#00FF00");
      expect(style.stroke).toEqual({ enabled: true, color: "#000000", widthPx: 6 }); // untouched fields stay the template's
    }
  });

  it("(2, 3) a scene override wins over the global style, field by field", () => {
    const style = resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { fontSizePx: 90, fillColor: "#00FF00" }, scene: { fillColor: "#FF0000" } });
    expect(style.fillColor).toBe("#FF0000");
    expect(style.fontSizePx).toBe(90); // inherited from global
    expect(style.animation).toBe("word_highlight"); // inherited from the template
  });

  it("(3) an edit stores only the fields that differ from what the scope inherits", () => {
    const inherited = resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { fontSizePx: 90 } });
    let patch = applyCaptionStyleEdit(null, "fillColor", "#FF0000", inherited);
    expect(patch).toEqual({ fillColor: "#FF0000" });
    patch = applyCaptionStyleEdit(patch, "fontSizePx", 90, inherited); // same as the global value -> not stored
    expect(patch).toEqual({ fillColor: "#FF0000" });
    patch = applyCaptionStyleEdit(patch, "strokeWidthPx", 9, inherited);
    expect(patch).toEqual({ fillColor: "#FF0000", strokeWidthPx: 9 });
    expect(applyCaptionStyleEdit(patch, "fillColor", "#ffffff", inherited)).toEqual({ strokeWidthPx: 9 }); // equal to the template, any case
  });

  it("(4) resetting a scene (or every field of it) falls back to the global style", () => {
    const inherited = resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { fontSizePx: 90 } });
    const patch = applyCaptionStyleEdit({ fontSizePx: 60 }, "fontSizePx", undefined, inherited);
    expect(patch).toBeNull();
    expect(resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { fontSizePx: 90 }, scene: patch }).fontSizePx).toBe(90);
  });

  it("(5) changing the global style never removes a scene override", () => {
    const scene = { fontSizePx: 60 };
    for (const global of [{ fontSizePx: 60 }, { fontSizePx: 100 }, {}]) {
      expect(resolveCaptionTextStyle({ engine: "lyonix", defaults, global, scene }).fontSizePx).toBe(60);
    }
  });

  it("falls back to the system default when the template has none", () => {
    const style = resolveCaptionTextStyle({ engine: "creatomate", defaults: null });
    expect(style.fontSizePx).toBe(SYSTEM_CAPTION_DEFAULTS.fontSizePx);
    expect(style.position).toEqual({ ...SYSTEM_CAPTION_DEFAULTS.position, preset: null });
  });
});

describe("VE2E-93 caption style fields", () => {
  it("(6) font: catalog id -> each engine's own family name; template/legacy names stay as they are", () => {
    expect(resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { fontId: "noto-sans-jp" } }).font).toEqual({ id: "noto-sans-jp", family: "Noto Sans CJK JP", source: "catalog", inCatalog: true });
    expect(resolveCaptionTextStyle({ engine: "creatomate", defaults, global: { fontId: "noto-sans-jp" } }).font.family).toBe("Noto Sans JP");
    expect(resolveCaptionTextStyle({ engine: "lyonix", defaults }).font).toEqual({ id: "noto-sans-jp", family: "Noto Sans CJK JP", source: "template", inCatalog: true });
    expect(resolveCaptionTextStyle({ engine: "lyonix", defaults, legacyFontFamily: "Inter Bold" }).font).toEqual({ id: null, family: "Inter Bold", source: "legacy", inCatalog: false });
    // a catalog choice beats the legacy name; an unknown id is ignored, never a silent substitute
    expect(resolveCaptionTextStyle({ engine: "lyonix", defaults, legacyFontFamily: "Inter Bold", scene: { fontId: "noto-sans-jp" } }).font.source).toBe("catalog");
    expect(resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { fontId: "no-such-font" } }).font.source).toBe("template");
  });

  it("(7) font size: canonical px, bounded, and the shrink floor never exceeds the chosen size", () => {
    expect(resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { fontSizePx: 40 } }).minFontSizePx).toBe(40);
    expect(resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { fontSizePx: 100 } }).minFontSizePx).toBe(48);
    expect(normalizeCaptionTextStylePatch({ fontSizePx: 20 })).toBeNull();
    expect(normalizeCaptionTextStylePatch({ fontSizePx: 200 })).toBeNull();
    expect(normalizeCaptionTextStylePatch({ fontSizePx: "64" })).toEqual({ fontSizePx: 64 });
  });

  it("(8) colour: #RGB/#RRGGBB normalised (case kept); alpha colours are not a fill colour", () => {
    expect(normalizeHexColor("#fA0")).toBe("#ffAA00");
    expect(normalizeHexColor("#00ff00")).toBe("#00ff00");
    expect(normalizeHexColor("#ff000080")).toBeNull();
    expect(normalizeHexColor("red")).toBeNull();
    expect(captionStyleFromOptionValues({ "dynamicStyle.captionFillColor": "#ff000080" })).toEqual({ patch: {}, legacyFontFamily: null, issues: [{ kind: "alpha_color", value: "#ff000080" }] });
  });

  it("(9) stroke: on/off, colour and width map to the ASS outline", () => {
    const off = resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { strokeEnabled: false } });
    expect(captionAssStyle(off).outlinePx).toBe(0);
    const custom = resolveCaptionTextStyle({ engine: "lyonix", defaults, global: { strokeColor: "#112233", strokeWidthPx: 12 } });
    expect(captionAssStyle(custom)).toMatchObject({ outlineColor: "#112233", outlinePx: 12 });
    // enabling a stroke over a template without one gets a usable width
    expect(captionDefaultsFromRecipeCaptions({ ...recipeCaptions, outlinePx: 0 }).stroke).toEqual({ enabled: false, color: "#000000", widthPx: 5 });
  });

  it("(10) top / middle / bottom presets and the template's own placement", () => {
    const anchorOf = (position?: "top" | "middle" | "bottom") => captionAssStyle(resolveCaptionTextStyle({ engine: "lyonix", defaults, global: position ? { position } : {} }));
    expect(anchorOf("top")).toMatchObject({ verticalAnchor: "top", marginVPercent: 10 });
    expect(anchorOf("middle")).toMatchObject({ verticalAnchor: "middle", marginVPercent: 50 });
    expect(anchorOf("bottom")).toMatchObject({ verticalAnchor: "bottom", marginVPercent: 20 });
    expect(anchorOf()).toMatchObject({ verticalAnchor: "top", marginVPercent: 38 }); // recipe placement kept
    const noPlacement = captionDefaultsFromRecipeCaptions({ ...recipeCaptions, placement: undefined });
    expect(captionStyleFieldValue(resolveCaptionTextStyle({ engine: "lyonix", defaults: noPlacement }), "position")).toBe("bottom");
    expect(CAPTION_POSITION_LAYOUT.middle).toEqual({ anchor: "center", percent: 50 });
  });

  it("(11) max lines is 1 or 2 only (V03-03)", () => {
    expect(normalizeCaptionTextStylePatch({ maxLines: 1 })).toEqual({ maxLines: 1 });
    expect(normalizeCaptionTextStylePatch({ maxLines: 3 })).toBeNull();
    expect(validateCaptionTextStylePatch({ maxLines: 3 })).toEqual({ ok: false, errors: ["giá trị không hợp lệ: maxLines"] });
    expect(captionDefaultsFromRecipeCaptions({ ...recipeCaptions, maxLines: 4 }).maxLines).toBe(2);
    expect(isValidCaptionStyleOptionValue("dynamicStyle.captionMaxLines", "3")).toBe(false);
  });

  it("(12) word highlight maps to the ASS karaoke highlight", () => {
    expect(captionAssStyle(resolveCaptionTextStyle({ engine: "lyonix", defaults })).highlight).toBe("word");
    expect(captionAssStyle(resolveCaptionTextStyle({ engine: "lyonix", defaults, scene: { animation: "none" } })).highlight).toBe("none");
  });
});

describe("VE2E-93 capability map", () => {
  it("(13) one source: LyOnix all, Creatomate no word highlight, Orshot read-only", () => {
    expect(CAPTION_STYLE_FIELDS.every((field) => captionStyleFieldReason("lyonix", field) === null)).toBe(true);
    expect(captionStyleFieldReason("creatomate", "animation")).toBe("no_word_highlight");
    expect(captionStyleFieldReason("creatomate", "fontSize")).toBeNull();
    expect(CAPTION_STYLE_FIELDS.every((field) => captionStyleFieldReason("orshot", field) === "provider_unsupported")).toBe(true);
    expect(CAPTION_STYLE_CAPABILITIES.creatomate.animations).toEqual(["none"]);
    expect(unsupportedCaptionPatchFields("creatomate", { animation: "word_highlight", fontSizePx: 60 })).toEqual(["animation"]);
    expect(unsupportedCaptionPatchFields("creatomate", { animation: "none" })).toEqual([]);
    expect(unsupportedCaptionPatchFields("orshot", { fontSizePx: 60 })).toEqual(["fontSizePx"]);
  });

  it("picks the Studio engine from the template and the render account", () => {
    expect(captionStyleEngineFor({ hasTemplate: false, templateEngine: "lyonix" })).toBeNull();
    expect(captionStyleEngineFor({ hasTemplate: true, templateEngine: "lyonix" })).toBe("lyonix");
    expect(captionStyleEngineFor({ hasTemplate: true, templateEngine: undefined })).toBe("creatomate");
    expect(captionStyleEngineFor({ hasTemplate: true, templateEngine: "creatomate", renderProvider: "orshot" })).toBe("orshot");
  });
});

describe("VE2E-93 storage and backward compatibility", () => {
  it("(16) a VE2E-26 timeline (legacy font + fill colour) keeps both values and reports the legacy font", () => {
    const values = { "dynamicStyle.captionFontFamily": "Inter Bold", "dynamicStyle.captionFillColor": "#facc15", "dynamicStyle.imageAnimation": "none" };
    const parsed = captionStyleFromOptionValues(values);
    expect(parsed).toEqual({ patch: { fillColor: "#facc15" }, legacyFontFamily: "Inter Bold", issues: [{ kind: "legacy_font", family: "Inter Bold" }] });
    expect(legacyCaptionFontFamily("lyonix", " Inter Bold ")).toBe("Inter Bold");
    expect(legacyCaptionFontFamily("creatomate", "Inter Bold")).toBe("Inter Bold");
    expect(legacyCaptionFontFamily("creatomate", "M PLUS Rounded 1c ")).toBe("M PLUS Rounded 1c ");
    expect(legacyCaptionFontFamily("lyonix", "Evil,Font;{\\b1}")).toBeNull();
    // the legacy rules still accept what VE2E-26 accepted, so an old timeline always re-saves
    expect(isValidCaptionStyleOptionValue("dynamicStyle.captionFontFamily", "Inter Bold")).toBe(true);
    expect(isValidCaptionStyleOptionValue("dynamicStyle.captionFillColor", "#ff000080")).toBe(true);
    expect(isValidCaptionStyleOptionValue("dynamicStyle.captionFontFamily", "Inter; DROP TABLE")).toBe(false);
  });

  it("(17) global edits touch only their own key; choosing a font retires the legacy name; reset clears all caption keys", () => {
    const values = { "dynamicStyle.captionFontFamily": "Inter Bold", "dynamicStyle.captionFillColor": "#ff000080", "dynamicStyle.imageAnimation": "none", "Badge.text": "x" };
    const sized = setCaptionStyleOptionValue(values, "fontSizePx", 80);
    expect(sized).toEqual({ ...values, "dynamicStyle.captionFontSizePx": "80" }); // legacy font and alpha colour untouched
    const fonted = setCaptionStyleOptionValue(sized, "fontId", "noto-sans-jp");
    expect(fonted["dynamicStyle.captionFontFamily"]).toBeUndefined();
    expect(fonted["dynamicStyle.captionFontId"]).toBe("noto-sans-jp");
    expect(setCaptionStyleOptionValue(fonted, "fontId", undefined)["dynamicStyle.captionFontId"]).toBeUndefined();
    expect(clearCaptionStyleOptionValues(fonted)).toEqual({ "dynamicStyle.imageAnimation": "none", "Badge.text": "x" });
    // round trip of a scene override through the flat per-scene params
    const patch = { fontId: "noto-sans-jp", fontSizePx: 80, strokeEnabled: false, position: "middle" as const, maxLines: 1 as const, animation: "none" as const };
    expect(captionStyleFromOptionValues(captionStylePatchToOptionValues(patch)).patch).toEqual(patch);
  });

  it("(20) invalid stored data never throws: unknown keys and bad values are dropped on read, rejected on save", () => {
    for (const raw of [null, undefined, "x", 42, [], { fontSizePx: "huge", maxLines: 9, position: "left", fillColor: "javascript:alert(1)", evil: true }]) {
      expect(() => normalizeCaptionTextStylePatch(raw)).not.toThrow();
      expect(normalizeCaptionTextStylePatch(raw)).toBeNull();
    }
    expect(validateCaptionTextStylePatch({ evil: 1 })).toEqual({ ok: false, errors: ["field không hỗ trợ: evil"] });
    expect(validateCaptionTextStylePatch(null)).toEqual({ ok: true, value: null });
    expect(validateCaptionTextStylePatch({ fillColor: "#ABC" })).toEqual({ ok: true, value: { fillColor: "#AABBCC" } });
    expect(() => captionStyleFromOptionValues({ "dynamicStyle.captionFontSizePx": "abc", "dynamicStyle.captionPosition": "nowhere" })).not.toThrow();
    expect(captionStyleFromOptionValues({ "dynamicStyle.captionFontSizePx": "abc" }).patch).toEqual({});
  });
});

describe("VE2E-93 per-scene ASS styles (LyOnix)", () => {
  const base = captionLayoutOptions(resolveCaptionTextStyle({ engine: "lyonix", defaults }), "lyonix");
  const sceneStyle = captionAssStyle(resolveCaptionTextStyle({ engine: "lyonix", defaults, scene: { fillColor: "#FF0000", position: "bottom", animation: "none", maxLines: 1 } }));

  it("(22) without per-cue styles the document has the single Sub style (unchanged output)", () => {
    const plain = buildCaptionAss([{ text: "一つ目", startMs: 0, endMs: 1000 }], base);
    expect(plain.ass.match(/^Style: /gm)).toHaveLength(1);
    expect(plain.ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.00,Sub,,");
  });

  it("(22) a scene style becomes its own ASS style used only by that scene's cues", () => {
    const { ass } = buildCaptionAss(
      [
        { text: "一つ目のテスト字幕です", startMs: 0, endMs: 1000 },
        { text: "二つ目のテスト字幕です", startMs: 1000, endMs: 2000, style: sceneStyle },
        { text: "三つ目", startMs: 2000, endMs: 3000, style: sceneStyle },
      ],
      base,
    );
    const styles = ass.split("\n").filter((line) => line.startsWith("Style: "));
    expect(styles.map((line) => line.split(",")[0])).toEqual(["Style: Sub", "Style: Sub2"]);
    const sub2 = styles[1]!.split(",");
    expect(sub2[3]).toBe("&H000000FF"); // red text (no highlight: primary = text colour)
    expect(sub2[18]).toBe("2"); // bottom
    expect(styles[0]!.split(",")[18]).toBe("8"); // the recipe's own top placement
    const events = ass.split("\n").filter((line) => line.startsWith("Dialogue: "));
    expect(events.map((line) => line.split(",")[3])).toEqual(["Sub", "Sub2", "Sub2"]);
    expect(events[1]).not.toContain("\\k"); // highlight off for that scene
    expect(events[0]).toContain("\\k");
  });

  it("(10, 11) middle anchors with ASS alignment 5 and one-line captions never wrap to a 2nd line", () => {
    const middle = captionAssStyle(resolveCaptionTextStyle({ engine: "lyonix", defaults, scene: { position: "middle", maxLines: 1 } }));
    const { ass, cues } = buildCaptionAss([{ text: "今日の注目ニュースをわかりやすく紹介します。背景と今後の動きを短くまとめました。", startMs: 0, endMs: 4000, style: middle }], base);
    expect(ass.split("\n").find((line) => line.startsWith("Style: Sub2"))!.split(",")[18]).toBe("5");
    expect(cues.every((cue) => cue.lines.length === 1)).toBe(true);
    const twoLines = buildCaptionAss([{ text: "今日の注目ニュースをわかりやすく紹介します。背景と今後の動きを短くまとめました。", startMs: 0, endMs: 4000 }], base);
    expect(twoLines.cues.every((cue) => cue.lines.length <= 2)).toBe(true);
  });

  it("Creatomate layout options never shrink and stay within 2 lines", () => {
    const options = captionLayoutOptions(resolveCaptionTextStyle({ engine: "creatomate", defaults, global: { fontSizePx: 80 } }), "creatomate");
    expect(options).toMatchObject({ fontSizePx: 80, minFontSizePx: 80, maxLines: 2, highlight: "none", widthSafety: 0.82 });
  });
});

describe("VE2E-93 font catalog", () => {
  it("lists only fonts with a name per engine, found by id or by any engine name", () => {
    expect(CAPTION_FONTS.map((font) => font.id)).toEqual(["noto-sans-jp"]);
    expect(captionFontById("noto-sans-jp")?.families).toEqual({ lyonix: "Noto Sans CJK JP", creatomate: "Noto Sans JP" });
    expect(captionFontByFamily("noto sans cjk jp")?.id).toBe("noto-sans-jp");
    expect(captionFontByFamily("Inter Bold")).toBeNull();
  });

  it("(6) flags scripts the font is not verified for (Korean, Vietnamese)", () => {
    expect([...detectCaptionScripts("今日はMessiの話 안녕하세요 Tiếng Việt")].sort()).toEqual(["ja", "ko", "latin", "vi"]);
    const font = captionFontById("noto-sans-jp")!;
    expect(unverifiedCaptionScripts(font, ["今日のニュース", "Breaking news"])).toEqual([]);
    expect(unverifiedCaptionScripts(font, ["안녕하세요", "Xin chào các bạn, hôm nay trời đẹp"]).sort()).toEqual(["ko", "vi"]);
  });
});

describe("VE2E-93 clone / split keep the scene style (18)", () => {
  const scene = (sceneId: string, extra: Partial<TimelineEditScene> = {}): TimelineEditScene => ({
    sceneId,
    mediaAssetVersionId: "m1",
    audioVersionId: "a1",
    subtitleVersionId: null,
    screenTextOverride: null,
    annotation: null,
    excluded: false,
    segmentId: null,
    sourceStartMs: null,
    sourceDurationMs: null,
    ...extra,
  });
  const state = (): TimelineEditState => ({ scenes: [scene("s1", { captionStyleOverride: { fillColor: "#FF0000" } }), scene("s2")], segments: [], addedScenes: [], removedSceneIds: [] });

  it("duplicates the override onto the copy", () => {
    const result = duplicateScene(state(), "s1", { narration: "一つ目。二つ目。", screenText: "", durationHintMs: 4000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.scenes.find((row) => row.sceneId === result.sceneId)!.captionStyleOverride).toEqual({ fillColor: "#FF0000" });
    expect(result.state.scenes.find((row) => row.sceneId === "s2")!.captionStyleOverride).toBeUndefined();
  });

  it("keeps the override on both halves of a split", () => {
    const result = splitScene(state(), { sceneId: "s1", sentenceBoundary: 1, source: { narration: "一つ目の文です。二つ目の文です。", screenText: "", durationHintMs: 4000 }, mediaKind: "image", mediaDurationMs: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const halves = result.state.scenes.filter((row) => row.sceneId !== "s2");
    expect(halves).toHaveLength(2);
    expect(halves.map((row) => row.captionStyleOverride)).toEqual([{ fillColor: "#FF0000" }, { fillColor: "#FF0000" }]);
  });
});
