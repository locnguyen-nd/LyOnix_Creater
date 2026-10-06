import { RECIPE_SCHEMA_VERSION, type RenderRecipe } from "../schema.js";

/**
 * `breaking-news-urgent-headline-jp@1` (V04-01) - Japanese breaking news, "urgent headline" look: the picture sits in a 46 %-tall band in
 * the lower part of a near-black canvas, leaving the top for a red "速報" badge, a LARGE headline (up to 3 lines) and a red rule; captions
 * at the bottom (over the picture band) alternate white/yellow per scene, photos zoom in with alternating direction, clips push in
 * lightly, 0.4 s circle transition inside the band. Built only from features the internal engine already renders. Immutable once
 * released: change = new version file.
 */
export const BREAKING_NEWS_URGENT_HEADLINE_JP_V1: RenderRecipe = {
  schemaVersion: RECIPE_SCHEMA_VERSION,
  id: "breaking-news-urgent-headline-jp",
  version: 1,
  name: "Breaking news - urgent headline (JP)",
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  timing: { padStartMs: 300, padEndMs: 800 },
  transition: { kind: "circle", durationMs: 400 },
  background: {
    image: { motion: "zoom_in", intensity: 0.05, alternate: true },
    video: { motion: "zoom_in", intensity: 0.03 },
    tint: { color: "#000000", opacity: 0.1 },
    frame: { mode: "band", heightPct: 46, centerYPct: 60, canvasColor: "#121212" },
  },
  layers: [
    { type: "box", id: "badge-box", x: 130, y: 230, w: 200, h: 70, color: "#E00000", opacity: 1, visibleIfSlot: "badge" },
    {
      type: "text",
      id: "badge-text",
      slot: "badge",
      x: 130,
      y: 230,
      w: 200,
      h: 70,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 44,
      minFontSizePx: 28,
      color: "#FFFFFF",
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
      y: 330,
      w: 820,
      h: 330,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 80,
      minFontSizePx: 48,
      color: "#FFFFFF",
      bold: true,
      maxLines: 3,
      outlinePx: 0,
      outlineColor: "#000000",
      visibleIfSlot: "headline",
    },
    { type: "box", id: "headline-rule", x: 130, y: 676, w: 820, h: 6, color: "#E00000", opacity: 1, visibleIfSlot: "headline" },
  ],
  captions: {
    enabled: true,
    fontFamily: "Noto Sans CJK JP",
    fontSizePx: 62,
    minFontSizePx: 44,
    maxLines: 2,
    bold: true,
    textColor: "#FFFFFF",
    highlightColor: "#FFFFFF",
    outlineColor: "#000000",
    outlinePx: 6,
    highlight: "none",
    colorCycle: ["#FFFFFF", "#FFE600"],
  },
  audio: { musicBaseDb: -14, musicDuckDb: -26, duckRampMs: 250, loudnessLufs: -14, truePeakDb: -1.5 },
  slots: [
    { key: "headline", kind: "text", label: "Headline (large, top)", required: false, default: "" },
    { key: "badge", kind: "text", label: "Badge text", required: false, default: "速報" },
  ],
  fonts: ["Noto Sans CJK JP"],
};
