import { RECIPE_SCHEMA_VERSION, type RenderRecipe } from "../schema.js";

/**
 * `breaking-news-red-alert-jp@1` (V04-01) - Japanese breaking news, "red alert" look: full-bleed picture under a red tint, a solid red
 * "BREAKING NEWS" band near the top, a white headline box with black text and a red rule under it, captions at the bottom whose colour
 * alternates white/yellow per scene, photos zoom in, 0.3 s wipe between scenes. All static (no ticker / pulse: the internal engine does
 * not animate layers). Built only from features the engine already renders. Immutable once released: change = new version file.
 */
export const BREAKING_NEWS_RED_ALERT_JP_V1: RenderRecipe = {
  schemaVersion: RECIPE_SCHEMA_VERSION,
  id: "breaking-news-red-alert-jp",
  version: 1,
  name: "Breaking news - red alert (JP)",
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  timing: { padStartMs: 300, padEndMs: 800 },
  transition: { kind: "wipe", durationMs: 300 },
  background: {
    image: { motion: "zoom_in", intensity: 0.06, alternate: false },
    video: { motion: "none", intensity: 0 },
    tint: { color: "#7A0000", opacity: 0.22 },
  },
  layers: [
    { type: "box", id: "alert-band", x: 0, y: 200, w: 1080, h: 96, color: "#D00000", opacity: 1, visibleIfSlot: "badge" },
    {
      type: "text",
      id: "alert-text",
      slot: "badge",
      x: 130,
      y: 200,
      w: 820,
      h: 96,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 56,
      minFontSizePx: 36,
      color: "#FFFFFF",
      bold: true,
      maxLines: 1,
      outlinePx: 0,
      outlineColor: "#000000",
      visibleIfSlot: "badge",
    },
    { type: "box", id: "headline-box", x: 0, y: 296, w: 1080, h: 200, color: "#FFFFFF", opacity: 0.96, visibleIfSlot: "headline" },
    {
      type: "text",
      id: "headline-text",
      slot: "headline",
      x: 130,
      y: 310,
      w: 820,
      h: 172,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 62,
      minFontSizePx: 38,
      color: "#111111",
      bold: true,
      maxLines: 2,
      outlinePx: 0,
      outlineColor: "#000000",
      visibleIfSlot: "headline",
    },
    { type: "box", id: "headline-rule", x: 0, y: 496, w: 1080, h: 8, color: "#D00000", opacity: 1, visibleIfSlot: "headline" },
  ],
  captions: {
    enabled: true,
    fontFamily: "Noto Sans CJK JP",
    fontSizePx: 64,
    minFontSizePx: 44,
    maxLines: 2,
    bold: true,
    textColor: "#FFFFFF",
    highlightColor: "#FFFFFF",
    outlineColor: "#000000",
    outlinePx: 6,
    highlight: "none",
    colorCycle: ["#FFFFFF", "#FFD400"],
  },
  audio: { musicBaseDb: -14, musicDuckDb: -26, duckRampMs: 250, loudnessLufs: -14, truePeakDb: -1.5 },
  slots: [
    { key: "headline", kind: "text", label: "Headline (white box)", required: false, default: "" },
    { key: "badge", kind: "text", label: "Alert band text", required: false, default: "BREAKING NEWS" },
  ],
  fonts: ["Noto Sans CJK JP"],
};
