import { applyDynamicStyleOverrides, buildDynamicCompositionWithWarnings, extractDynamicStyleFromTemplate, type DynamicSceneInput } from "./creatomate-dynamic.js";
import { newsRecapJpTemplate, top5CountdownTemplate } from "./fixtures/creatomate-templates.js";

/**
 * VE2E-93: regression cases for the Creatomate dynamic composition. `fixtures/creatomate-dynamic-baseline.json` holds the output of
 * these cases captured BEFORE VE2E-93 changed the caption mapping; a timeline without any VE2E-93 style key must keep producing exactly
 * that `source`. Test-only (never imported by runtime code).
 */

const scenes: DynamicSceneInput[] = [
  { sceneId: "s1", mediaUrl: "https://lyonix.test/media/1", mediaKind: "video", text: "今日の注目ニュースをわかりやすく紹介します。背景と今後の動きを短くまとめました。", audioUrl: "https://lyonix.test/audio/1", audioDurationMs: 4200 },
  {
    sceneId: "s2",
    mediaUrl: "https://lyonix.test/media/2",
    mediaKind: "image",
    text: "Messi is a football player who plays for Inter Miami now.",
    captionSegments: [{ text: "Messi is a football player", startMs: 0, endMs: 1500 }, { text: "who plays for Inter Miami now.", startMs: 1500, endMs: 3400 }],
    audioUrl: "https://lyonix.test/audio/2",
    audioDurationMs: 3600,
  },
  { sceneId: "s3", mediaUrl: "https://lyonix.test/media/3", mediaKind: "video", text: "続きは動画の最後までご覧ください", audioUrl: "https://lyonix.test/audio/3", audioDurationMs: 2500, sourceStartMs: 1000, sourceDurationMs: 2500 },
];

const flatTemplate = {
  width: 1080,
  height: 1920,
  elements: [
    { type: "image", name: "Image-1", dynamic: true },
    { type: "text", name: "Subtitles-1", dynamic: true, font_family: "Montserrat", font_size: "6 vmin", fill_color: "#ffee00", stroke_color: "#111111", stroke_width: "0.8 vmin", y_alignment: "90%", background_color: "rgba(0,0,0,0.5)", background_x_padding: "20%" },
  ],
};

const TEMPLATES: Record<string, unknown> = { newsRecap: newsRecapJpTemplate(), top5: top5CountdownTemplate(), flat: flatTemplate, none: {} };

const OPTION_SETS: Record<string, Record<string, string>> = {
  none: {},
  legacyFontColor: { "dynamicStyle.captionFontFamily": "Noto Sans", "dynamicStyle.captionFillColor": "#facc15" },
  legacyShortColorNoPan: { "dynamicStyle.captionFillColor": "#ff000080", "dynamicStyle.imageAnimation": "none" },
  emptyValues: { "dynamicStyle.captionFontFamily": "", "dynamicStyle.captionFillColor": "", "dynamicStyle.imageAnimation": "" },
};

export type CreatomateBaselineCase = { name: string; source: Record<string, unknown>; warnings: string[] };

export function creatomateBaselineCases(): CreatomateBaselineCase[] {
  const cases: CreatomateBaselineCase[] = [];
  for (const [templateName, raw] of Object.entries(TEMPLATES)) {
    for (const [optionName, optionValues] of Object.entries(OPTION_SETS)) {
      const style = applyDynamicStyleOverrides(extractDynamicStyleFromTemplate(raw), optionValues);
      const result = buildDynamicCompositionWithWarnings(scenes, style, { width: 1080, height: 1920 });
      cases.push({ name: `${templateName}/${optionName}`, source: result.source, warnings: [...result.warnings] });
    }
  }
  return cases;
}
