import { RECIPE_SCHEMA_VERSION, type RenderRecipe } from "../schema.js";

/**
 * `sports-recap-player-focus-jp@1` (V04-01) - Japanese sports recap centred on the player: full-bleed picture that always pushes IN (no
 * alternating direction, clips get a light push too), a green "SPORTS" badge near the top, a dark lower third with a green accent bar
 * and the headline just above the captions, word-highlighted captions at the bottom, 0.4 s circle transition. Built only from features
 * the internal engine already renders. Immutable once released: change = new version file.
 */
export const SPORTS_RECAP_PLAYER_FOCUS_JP_V1: RenderRecipe = {
  schemaVersion: RECIPE_SCHEMA_VERSION,
  id: "sports-recap-player-focus-jp",
  version: 1,
  name: "Sports recap - player focus (JP)",
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  timing: { padStartMs: 300, padEndMs: 800 },
  transition: { kind: "circle", durationMs: 400 },
  background: {
    image: { motion: "zoom_in", intensity: 0.12, alternate: false },
    video: { motion: "zoom_in", intensity: 0.05 },
    tint: { color: "#000000", opacity: 0.1 },
  },
  layers: [
    { type: "box", id: "badge-box", x: 130, y: 214, w: 220, h: 56, color: "#00A651", opacity: 1, visibleIfSlot: "badge" },
    {
      type: "text",
      id: "badge-text",
      slot: "badge",
      x: 130,
      y: 214,
      w: 220,
      h: 56,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 34,
      minFontSizePx: 22,
      color: "#FFFFFF",
      bold: true,
      maxLines: 1,
      outlinePx: 0,
      outlineColor: "#000000",
      visibleIfSlot: "badge",
    },
    { type: "box", id: "lower-third", x: 0, y: 1140, w: 1080, h: 200, color: "#000000", opacity: 0.55, visibleIfSlot: "headline" },
    { type: "box", id: "lower-third-accent", x: 130, y: 1160, w: 12, h: 160, color: "slot:accent", opacity: 1, visibleIfSlot: "headline" },
    {
      type: "text",
      id: "headline-text",
      slot: "headline",
      x: 160,
      y: 1160,
      w: 790,
      h: 160,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 58,
      minFontSizePx: 36,
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
    fontSizePx: 64,
    minFontSizePx: 44,
    maxLines: 2,
    bold: true,
    textColor: "#FFFFFF",
    highlightColor: "#5CFF8F",
    outlineColor: "#000000",
    outlinePx: 5,
    highlight: "word",
  },
  audio: { musicBaseDb: -14, musicDuckDb: -26, duckRampMs: 250, loudnessLufs: -14, truePeakDb: -1.5 },
  slots: [
    { key: "headline", kind: "text", label: "Headline (lower third)", required: false, default: "" },
    { key: "badge", kind: "text", label: "Badge text", required: false, default: "SPORTS" },
    { key: "accent", kind: "color", label: "Lower-third accent colour", required: false, default: "#00A651" },
  ],
  fonts: ["Noto Sans CJK JP"],
};
