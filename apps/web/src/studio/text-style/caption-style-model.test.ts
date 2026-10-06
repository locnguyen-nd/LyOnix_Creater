import { describe, expect, it, vi } from "vitest";
import { captionDefaultsFromRecipeCaptions } from "@lyonix/domain/caption-style";
import { NEWS_RECAP_WHITE_TOP_CAPTION_JP_V1, NEWS_RECAP_BROADCAST_TELOP_JP_V1 } from "@lyonix/render-recipes";
import { buildPreviewPlan, layoutSceneCaption } from "../full-preview-plan";
import { buildFullPreviewSequence, type FullPreviewSceneInput } from "../full-preview";
import { buildTimelineSaveScenes } from "../timeline-save";
import { duplicateSelectedScene, splitSelectedScene, type EditableDraft, type EditableScene } from "../timeline-edit-actions";
import {
  applySceneCaptionEdit,
  applyVideoCaptionEdit,
  CaptionStyleEditSession,
  captionStyleNotices,
  inheritedCaptionStyle,
  isFieldCustomized,
  previewCaptionStyle,
  resetVideoCaptionStyle,
  studioCaptionEngine,
  type StudioCaptionContext,
} from "./caption-style-model";
import { captionBlockTop, captionTextColor, layoutCaptionPage } from "./CaptionPreview";
import { captionLayoutOptions } from "@lyonix/domain/caption-style";

const lyonixDefaults = captionDefaultsFromRecipeCaptions(NEWS_RECAP_BROADCAST_TELOP_JP_V1.captions);
const ctx = (optionValues: Record<string, string> = {}, engine: StudioCaptionContext["engine"] = "lyonix", defaults = lyonixDefaults): StudioCaptionContext => ({ engine, defaults, optionValues });
const change = (field: Parameters<typeof applyVideoCaptionEdit>[1][number]["field"], value: unknown) => [{ field, value: value as never }];

describe("VE2E-93 Studio caption style model", () => {
  it("picks the engine from the pinned template and the render account (Orshot wins)", () => {
    expect(studioCaptionEngine(null, "creatomate")).toBeNull();
    expect(studioCaptionEngine({ engine: "lyonix" }, "creatomate")).toBe("lyonix");
    expect(studioCaptionEngine({}, "creatomate")).toBe("creatomate");
    expect(studioCaptionEngine({ engine: "creatomate" }, "orshot")).toBe("orshot");
  });

  it("(1, 3) a whole-video edit writes only its own key and only when it differs from the template", () => {
    const base = { "Badge.text": "x", "dynamicStyle.imageAnimation": "none" };
    const sized = applyVideoCaptionEdit(ctx(base), change("fontSizePx", 90));
    expect(sized).toEqual({ ...base, "dynamicStyle.captionFontSizePx": "90" });
    const same = applyVideoCaptionEdit(ctx(sized), change("fontSizePx", lyonixDefaults.fontSizePx));
    expect(same).toEqual(base); // equal to the template default -> not stored
    const many = applyVideoCaptionEdit(ctx(base), [{ field: "strokeColor", value: "#112233" }, { field: "strokeWidthPx", value: 9 }]);
    expect(many).toMatchObject({ "dynamicStyle.captionStrokeColor": "#112233", "dynamicStyle.captionStrokeWidthPx": "9" });
  });

  it("(2, 3, 4, 5) scene overrides store differences from the whole video, reset to it, and survive global changes", () => {
    const global = ctx({ "dynamicStyle.captionFontSizePx": "90" });
    const patch = applySceneCaptionEdit(global, null, change("fillColor", "#FF0000"));
    expect(patch).toEqual({ fillColor: "#FF0000" });
    expect(applySceneCaptionEdit(global, patch, change("fontSizePx", 90))).toEqual({ fillColor: "#FF0000" }); // same as global
    expect(applySceneCaptionEdit(global, patch, change("fillColor", undefined))).toBeNull(); // reset
    const changedGlobal = ctx({ "dynamicStyle.captionFontSizePx": "60", "dynamicStyle.captionFillColor": "#00FF00" });
    expect(previewCaptionStyle(changedGlobal, "s1", patch, null).fillColor).toBe("#FF0000");
    expect(previewCaptionStyle(changedGlobal, "s1", patch, null).fontSizePx).toBe(60);
    expect(previewCaptionStyle(changedGlobal, "s2", null, null).fillColor).toBe("#00FF00");
  });

  it("(14) the preview shows the edit being dragged, for the right scope and scene only", () => {
    const pendingScene = { scope: "scene" as const, sceneId: "s1", changes: change("fontSizePx", 100) };
    expect(previewCaptionStyle(ctx(), "s1", null, pendingScene).fontSizePx).toBe(100);
    expect(previewCaptionStyle(ctx(), "s2", null, pendingScene).fontSizePx).toBe(lyonixDefaults.fontSizePx);
    const pendingVideo = { scope: "video" as const, sceneId: null, changes: change("fontSizePx", 40) };
    expect(previewCaptionStyle(ctx(), "s2", null, pendingVideo).fontSizePx).toBe(40);
    expect(previewCaptionStyle(ctx(), "s1", { fontSizePx: 70 }, pendingVideo).fontSizePx).toBe(70); // the scene override still wins
  });

  it("badges: customised per scope (the legacy font counts as a whole-video font)", () => {
    const legacy = ctx({ "dynamicStyle.captionFontFamily": "Inter Bold" });
    expect(isFieldCustomized(legacy, "video", null, ["fontId"])).toBe(true);
    expect(isFieldCustomized(legacy, "scene", null, ["fontId"])).toBe(false);
    expect(isFieldCustomized(legacy, "scene", { strokeColor: "#000000" }, ["strokeEnabled", "strokeColor"])).toBe(true);
    expect(resetVideoCaptionStyle({ "dynamicStyle.captionFontFamily": "Inter Bold", "dynamicStyle.captionFontSizePx": "90", other: "1" })).toEqual({ other: "1" });
  });

  it("(6, 13, 16) tells the user about legacy fonts, alpha colours, unverified scripts and what an engine ignores - never silently", () => {
    const style = (c: StudioCaptionContext, scene: Parameters<typeof previewCaptionStyle>[2] = null) => previewCaptionStyle(c, "s1", scene, null);
    const legacy = ctx({ "dynamicStyle.captionFontFamily": "Inter Bold", "dynamicStyle.captionFillColor": "#ff000080" });
    expect(captionStyleNotices({ ctx: legacy, style: style(legacy), scenePatch: null, texts: ["ニュース"], anySceneOverride: false, hasFallback: false }).map((n) => n.kind)).toEqual(["legacy_font", "alpha_color", "preview_font"]);
    const korean = ctx({ "dynamicStyle.captionFontId": "noto-sans-jp" });
    expect(captionStyleNotices({ ctx: korean, style: style(korean), scenePatch: null, texts: ["안녕하세요", "Xin chào Việt Nam"], anySceneOverride: false, hasFallback: false })).toEqual([{ kind: "unverified_scripts", font: "Noto Sans JP", scripts: ["ko", "vi"] }]);
    const orshot = ctx({ "dynamicStyle.captionFontSizePx": "80" }, "orshot");
    expect(captionStyleNotices({ ctx: orshot, style: style(orshot), scenePatch: null, texts: [], anySceneOverride: false, hasFallback: false }).map((n) => n.kind)).toContain("stored_ignored");
    const creatomate = ctx({}, "creatomate");
    expect(captionStyleNotices({ ctx: creatomate, style: style(creatomate, { animation: "word_highlight" }), scenePatch: { animation: "word_highlight" }, texts: [], anySceneOverride: true, hasFallback: false }).map((n) => n.kind)).toContain("highlight_unsupported");
    const cycling = ctx({}, "lyonix", captionDefaultsFromRecipeCaptions(NEWS_RECAP_WHITE_TOP_CAPTION_JP_V1.captions));
    expect(captionStyleNotices({ ctx: cycling, style: style(cycling), scenePatch: null, texts: [], anySceneOverride: false, hasFallback: false }).map((n) => n.kind)).toContain("color_cycle");
    expect(captionStyleNotices({ ctx: ctx(), style: style(ctx()), scenePatch: null, texts: [], anySceneOverride: false, hasFallback: true }).map((n) => n.kind)).toContain("highlight_fallback");
  });

  it("(15) a slider/colour drag previews every move but writes the draft ONCE, on release", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const session = new CaptionStyleEditSession(onPreview, onCommit);
    for (let size = 40; size <= 100; size += 2) session.preview({ scope: "video", sceneId: null, changes: change("fontSizePx", size) });
    expect(onCommit).not.toHaveBeenCalled();
    session.commit();
    session.commit(); // a second release without a new move is a no-op
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ scope: "video", sceneId: null, changes: change("fontSizePx", 100) });
    expect(onPreview).toHaveBeenLastCalledWith(null);
    session.preview({ scope: "video", sceneId: null, changes: change("fontSizePx", 50) });
    session.cancel();
    session.commit();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("VE2E-93 preview = render semantics (14)", () => {
  const text = "今日の注目ニュースをわかりやすく紹介します。背景と今後の動きを短くまとめました。";

  it("lays the caption out with the effective style: size, lines and the template's own placement", () => {
    const one = previewCaptionStyle(ctx(), "s1", { maxLines: 1 }, null);
    expect(layoutCaptionPage(text, one, "lyonix")!.lines).toHaveLength(1);
    const two = previewCaptionStyle(ctx(), "s1", null, null);
    expect(layoutCaptionPage(text, two, "lyonix")!.lines.length).toBeLessThanOrEqual(2);
    expect(layoutSceneCaption(text, 8000, undefined, captionLayoutOptions(one, "lyonix")).every((page) => page.lines.length === 1)).toBe(true);
    expect(captionBlockTop(previewCaptionStyle(ctx(), "s1", { position: "top" }, null), 2, 64)).toBeCloseTo(192, 0);
    expect(captionBlockTop(previewCaptionStyle(ctx(), "s1", { position: "bottom" }, null), 1, 100)).toBeCloseTo(1920 * 0.8 - 128, 0);
  });

  it("uses the recipe colour cycle only while the user has not set a colour (D3)", () => {
    const cycling = ctx({}, "lyonix", captionDefaultsFromRecipeCaptions(NEWS_RECAP_WHITE_TOP_CAPTION_JP_V1.captions));
    expect(captionTextColor(previewCaptionStyle(cycling, "s2", null, null), "lyonix", 1)).toBe("#FFE600");
    expect(captionTextColor(previewCaptionStyle(cycling, "s2", { fillColor: "#00FF00" }, null), "lyonix", 1)).toBe("#00FF00");
  });

  it("the full preview plan lays out each scene with its own style", () => {
    const scenes: FullPreviewSceneInput[] = ["s1", "s2"].map((sceneId) => ({ sceneId, excluded: false, narration: text, durationHintMs: 8000, mediaKind: null, mediaUrl: null, sourceStartMs: null, sourceDurationMs: null, audioUrl: null, audioDurationMs: null }));
    const styles = new Map([["s1", previewCaptionStyle(ctx(), "s1", { maxLines: 1 }, null)], ["s2", previewCaptionStyle(ctx(), "s2", null, null)]]);
    const plan = buildPreviewPlan(buildFullPreviewSequence(scenes).segments, undefined, (sceneId) => captionLayoutOptions(styles.get(sceneId)!, "lyonix"));
    expect(plan.captionPages.get("s1")!.every((page) => page.lines.length === 1)).toBe(true);
    expect(plan.captionPages.get("s2")!.some((page) => page.lines.length === 2)).toBe(true);
  });

  it("matches what each engine really draws for stored values it treats differently", () => {
    const alpha = { "dynamicStyle.captionFillColor": "#ff000080" };
    expect(previewCaptionStyle(ctx(alpha, "creatomate"), "s1", null, null).fillColor).toBe("#ff0000"); // Creatomate applies it
    expect(previewCaptionStyle(ctx(alpha, "lyonix"), "s1", null, null).fillColor).toBe(lyonixDefaults.fillColor); // LyOnix does not
    // Orshot applies no caption style: the preview shows the default, not the saved values
    expect(previewCaptionStyle(ctx({ "dynamicStyle.captionFontSizePx": "100" }, "orshot", null as never), "s1", { fillColor: "#FF0000" }, null)).toMatchObject({ fontSizePx: 64, fillColor: "#FFFFFF" });
  });

  it("whole-video inheritance for a scene = the global style", () => {
    expect(inheritedCaptionStyle(ctx({ "dynamicStyle.captionFontSizePx": "90" }), "scene").fontSizePx).toBe(90);
    expect(inheritedCaptionStyle(ctx({ "dynamicStyle.captionFontSizePx": "90" }), "video").fontSizePx).toBe(lyonixDefaults.fontSizePx);
  });
});

describe("VE2E-93 save / clone / split keep the scene override (17, 18)", () => {
  const scene = (sceneId: string, over: Partial<EditableScene> = {}): EditableScene => ({
    sceneId, mediaAssetVersionId: "m", mediaLabel: null, audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false, segmentId: null, sourceStartMs: null, sourceDurationMs: null, ...over,
  });
  const ctxScenes = [{ id: "row-s1", sceneId: "s1", orderIndex: 0, narration: "一つ目の文です。二つ目の文です。", screenText: "", visualQuery: "", durationHintMs: 6000 }] as never;

  it("sends the override only for scenes that have one", () => {
    const saved = buildTimelineSaveScenes([scene("s1", { captionStyleOverride: { fillColor: "#FF0000" } }), scene("s2"), scene("s3", { captionStyleOverride: null })], []);
    expect(saved.scenes[0]).toMatchObject({ captionStyleOverride: { fillColor: "#FF0000" } });
    expect(saved.scenes[1]).not.toHaveProperty("captionStyleOverride");
    expect(saved.scenes[2]).not.toHaveProperty("captionStyleOverride");
  });

  it("a duplicated scene and both halves of a split keep the original's style", () => {
    const draft: EditableDraft = { scenes: [scene("s1", { captionStyleOverride: { position: "top" } })], segments: [], addedScenes: [], removedSceneIds: [] };
    const duplicated = duplicateSelectedScene(draft, "s1", ctxScenes);
    if (!duplicated.ok) throw new Error(duplicated.message);
    expect(duplicated.draft.scenes.map((row) => row.captionStyleOverride)).toEqual([{ position: "top" }, { position: "top" }]);
    const split = splitSelectedScene(draft, "s1", 1, ctxScenes, { kind: "image", durationMs: null });
    if (!split.ok) throw new Error(split.message);
    expect(split.draft.scenes.map((row) => row.captionStyleOverride)).toEqual([{ position: "top" }, { position: "top" }]);
  });
});
