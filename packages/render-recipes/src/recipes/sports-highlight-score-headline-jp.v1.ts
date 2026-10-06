import { RECIPE_SCHEMA_VERSION, type RenderRecipe } from "../schema.js";

/**
 * `sports-highlight-score-headline-jp@1` (V04-01) - Japanese sports highlight: full-bleed picture with a strong zoom (direction alternates
 * per scene), a navy headline band near the top (below the TikTok top safe zone) with a yellow "HIGHLIGHT" badge and a yellow rule under
 * it, word-highlighted captions at the bottom, 0.3 s slide between scenes. The score / match goes in the headline (Auto fills `headline`
 * from the script title): there is deliberately no score slot, Auto has no score data and a default score would show in every video.
 * Built only from features the internal engine already renders. Immutable once released: change = new version file.
 */
export const SPORTS_HIGHLIGHT_SCORE_HEADLINE_JP_V1: RenderRecipe = {
  schemaVersion: RECIPE_SCHEMA_VERSION,
  id: "sports-highlight-score-headline-jp",
  version: 1,
  name: "Sports highlight - score headline (JP)",
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  timing: { padStartMs: 300, padEndMs: 800 },
  transition: { kind: "slide", durationMs: 300 },
  background: {
    image: { motion: "zoom_in", intensity: 0.1, alternate: true },
    video: { motion: "zoom_in", intensity: 0.04 },
    tint: { color: "#000000", opacity: 0.15 },
  },
  layers: [
    { type: "box", id: "headline-band", x: 0, y: 200, w: 1080, h: 230, color: "slot:accent", opacity: 0.92, visibleIfSlot: "headline" },
    { type: "box", id: "headline-rule", x: 0, y: 430, w: 1080, h: 10, color: "#FFD400", opacity: 1, visibleIfSlot: "headline" },
    { type: "box", id: "badge-box", x: 130, y: 214, w: 260, h: 58, color: "#FFD400", opacity: 1, visibleIfSlot: "badge" },
    {
      type: "text",
      id: "badge-text",
      slot: "badge",
      x: 130,
      y: 214,
      w: 260,
      h: 58,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 36,
      minFontSizePx: 24,
      color: "#0B1F4D",
      bold: true,
      maxLines: 1,
      outlinePx: 0,
      outlineColor: "#000000",
      visibleIfSlot: "badge",
    },
    {
      type: "text",
      id: "headline-text",
      slot: "headline",
      x: 130,
      y: 284,
      w: 820,
      h: 132,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 64,
      minFontSizePx: 38,
      color: "#FFFFFF",
      bold: true,
      maxLines: 2,
      outlinePx: 0,
      outlineColor: "#000000",
      visibleIfSlot: "headline",
    },
  ],
  captions: {
    enabled: true,
    fontFamily: "Noto Sans CJK JP",
    fontSizePx: 66,
    minFontSizePx: 44,
    maxLines: 2,
    bold: true,
    textColor: "#FFFFFF",
    highlightColor: "#FFD400",
    outlineColor: "#000000",
    outlinePx: 6,
    highlight: "word",
  },
  audio: { musicBaseDb: -14, musicDuckDb: -26, duckRampMs: 250, loudnessLufs: -14, truePeakDb: -1.5 },
  slots: [
    { key: "headline", kind: "text", label: "Headline (score / match)", required: false, default: "" },
    { key: "badge", kind: "text", label: "Badge text", required: false, default: "HIGHLIGHT" },
    { key: "accent", kind: "color", label: "Headline band colour", required: false, default: "#0B1F4D" },
  ],
  fonts: ["Noto Sans CJK JP"],
};
