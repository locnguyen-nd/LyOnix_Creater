import { describe, expect, it } from "vitest";
import { CAPTION_PRESETS, captionPresetById, captionPresetOptionValues } from "@lyonix/domain/caption-presets";
import { captionDefaultsFromRecipeCaptions, CAPTION_PRESET_OPTION_KEY } from "@lyonix/domain/caption-style";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1 } from "@lyonix/render-recipes";
import {
  applySceneCaptionEdit,
  applyVideoCaptionPreset,
  applyVideoEdit,
  captionPresetEdit,
  captionPresetStatus,
  previewCaptionStyle,
  type StudioCaptionContext,
} from "./caption-style-model";

const defaults = captionDefaultsFromRecipeCaptions(NEWS_RECAP_BROADCAST_TELOP_JP_V1.captions);
const ctx = (optionValues: Record<string, string> = {}, engine: StudioCaptionContext["engine"] = "lyonix"): StudioCaptionContext => ({ engine, defaults, optionValues });
const sports = captionPresetById("sports-punch")!;

describe("VE2E-94 presets in Studio (whole video)", () => {
  it("(7) applying a preset replaces the whole-video style with the preset's values and keeps its id; other option values stay", () => {
    const before = { "Badge.text": "x", "dynamicStyle.imageAnimation": "none", "dynamicStyle.captionFontFamily": "Inter Bold", "dynamicStyle.captionStrokeColor": "#123456" };
    const after = applyVideoCaptionPreset(ctx(before), sports);
    expect(after).toMatchObject({ "Badge.text": "x", "dynamicStyle.imageAnimation": "none", [CAPTION_PRESET_OPTION_KEY]: "sports-punch", "dynamicStyle.captionFontSizePx": "96", "dynamicStyle.captionPosition": "middle", "dynamicStyle.captionMaxLines": "1" });
    expect(after).not.toHaveProperty("dynamicStyle.captionFontFamily"); // the preset's catalog font replaces a VE2E-26 font
    expect(after["dynamicStyle.captionStrokeColor"]).toBeUndefined(); // = the template's black: stored only when it differs
    const style = previewCaptionStyle(ctx(after), "s1", null, null);
    expect(style).toMatchObject({ fontSizePx: 96, fillColor: "#FFE600", maxLines: 1, animation: "none", stroke: { enabled: true, color: "#000000", widthPx: 10 }, position: { preset: "middle" } });
    // the preset's font is the recipe's own (Noto Sans JP): equal to the template default, so it is not stored - the font is still it
    expect(style.font).toMatchObject({ id: "noto-sans-jp", family: "Noto Sans CJK JP" });
  });

  it("(7) never touches scene overrides: a scene keeps its own fields over the new whole-video style", () => {
    const after = applyVideoEdit(ctx(), captionPresetEdit(sports));
    const scenePatch = applySceneCaptionEdit(ctx(), null, [{ field: "fillColor", value: "#00FF00" }]);
    expect(previewCaptionStyle(ctx(after), "s2", scenePatch, null)).toMatchObject({ fillColor: "#00FF00", fontSizePx: 96 });
  });

  it("(9) a manual edit after a preset keeps every value and turns the status into 'customised from'; restore brings the preset back", () => {
    const applied = applyVideoEdit(ctx(), captionPresetEdit(sports));
    expect(captionPresetStatus(ctx(applied))).toEqual({ kind: "preset", preset: sports });
    const edited = applyVideoEdit(ctx(applied), { scope: "video", sceneId: null, changes: [{ field: "fillColor", value: "#FF0000" }] });
    expect(edited).toMatchObject({ "dynamicStyle.captionFontSizePx": "96", "dynamicStyle.captionFillColor": "#FF0000", [CAPTION_PRESET_OPTION_KEY]: "sports-punch" });
    expect(captionPresetStatus(ctx(edited))).toEqual({ kind: "custom", basedOn: sports });
    expect(captionPresetStatus(ctx(applyVideoEdit(ctx(edited), captionPresetEdit(sports))))).toEqual({ kind: "preset", preset: sports });
  });

  it("(14, 16) hovering a preset previews it without changing the draft", () => {
    const committed = {};
    const hovered = previewCaptionStyle(ctx(committed), "s1", null, captionPresetEdit(captionPresetById("breaking-red")!));
    expect(hovered).toMatchObject({ fontSizePx: 80, stroke: { color: "#E00000", widthPx: 10 }, position: { preset: "top" } });
    expect(committed).toEqual({});
  });

  it("(10, 23) reload / legacy: a stored id is read back; a style without id is recognised only when identical to a supported preset", () => {
    for (const item of CAPTION_PRESETS) expect(captionPresetStatus(ctx(applyVideoCaptionPreset(ctx(), item))), item.id).toEqual({ kind: "preset", preset: item });
    expect(captionPresetStatus(ctx())).toEqual({ kind: "template" });
    const withoutId = { ...applyVideoCaptionPreset(ctx(), sports) };
    delete withoutId[CAPTION_PRESET_OPTION_KEY];
    expect(captionPresetStatus(ctx(withoutId))).toEqual({ kind: "preset", preset: sports }); // deterministic: same values for every field
    expect(captionPresetStatus(ctx({ "dynamicStyle.captionFontFamily": "Inter Bold" }))).toEqual({ kind: "custom", basedOn: null });
    expect(captionPresetStatus(ctx({ "dynamicStyle.captionFontSizePx": "90" }))).toEqual({ kind: "custom", basedOn: null });
    // an id later removed from the catalog: the stored values still render, the UI shows "customised"
    expect(captionPresetStatus(ctx({ ...captionPresetOptionValues(sports), [CAPTION_PRESET_OPTION_KEY]: "retired-preset" }))).toEqual({ kind: "preset", preset: sports });
  });

  it("(14) Creatomate never recognises the karaoke preset (it cannot draw it)", () => {
    const karaoke = captionPresetById("karaoke-highlight")!;
    const values = { ...applyVideoCaptionPreset(ctx({}, "creatomate"), karaoke) };
    delete values[CAPTION_PRESET_OPTION_KEY];
    expect(captionPresetStatus(ctx(values, "creatomate")).kind).not.toBe("preset");
  });
});
