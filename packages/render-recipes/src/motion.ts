import type { RecipeLayer } from "./schema.js";

/**
 * VE2E-157: the ONE motion preset of the internal engine's text and graphic overlays, shared by every released recipe. The media-worker turns it
 * into libass tags (`\fad`, `\move`, `\t(\fscx \fscy)` - rendered by FFmpeg into the MP4), and the template preview evaluates the very same
 * numbers with `layerMotionAt` / `captionMotionAt`, so the preview shows what the render does. Pure data + pure functions, browser-safe.
 *
 * It is not part of a recipe (released recipes are immutable): it belongs to the engine output profile (`compose.v2`). Every recipe gets the
 * same timing, entrance order and exit, so the library looks consistent; colours / layout stay the recipe's.
 *
 *  - panel     large boxes (bands, plates, lower thirds): revealed from the left edge while fading in;
 *  - badge     the badge box + text ("速報", "BREAKING NEWS", ...): pop from 80 % to 100 % with a fade;
 *  - headline  the headline text (and a non-panel box tied to it): fade in while rising 28 px into place;
 *  - rule      thin lines / accents: grow from their start edge (left for a horizontal line, top for a vertical one).
 * Entrances are staggered (panel -> badge -> headline -> rule) and settle within 0.85 s; every layer fades out over the last 0.3 s of the video.
 * Linear interpolation everywhere (libass `\move` and `\t` without acceleration), so the preview's maths is exact.
 *
 * Captions: each phrase (cue) appears with a short fade and a slight pop (92 % -> 100 %), so the phrase being read is emphasised the moment its
 * voice starts; no fade-out between cues (consecutive cues never blink), a cue ends with its voice.
 */

export const TEXT_MOTION_PROFILE = "motion.v1" as const;

export type LayerMotionRole = "panel" | "badge" | "headline" | "rule";

export type LayerMotion = {
  role: LayerMotionRole;
  /** Entrance start after the video start. */
  delayMs: number;
  /** Fade from transparent over this time. */
  fadeInMs: number;
  /** Rise into place (text and boxes move together), px on the 1080x1920 canvas. */
  risePx: number;
  /** Uniform scale at the start of the entrance (100 = none), reached after `scaleMs`. */
  popFromPct: number;
  /** Grow along one axis from its start edge: `x` from the left, `y` from the top (0 % -> 100 % over `scaleMs`). */
  grow: "x" | "y" | null;
  scaleMs: number;
};

export const LAYER_MOTION: Readonly<Record<LayerMotionRole, Omit<LayerMotion, "grow"> & { grow: "x" | null }>> = {
  panel: { role: "panel", delayMs: 0, fadeInMs: 300, risePx: 0, popFromPct: 100, grow: "x", scaleMs: 350 },
  badge: { role: "badge", delayMs: 150, fadeInMs: 250, risePx: 0, popFromPct: 80, grow: null, scaleMs: 280 },
  headline: { role: "headline", delayMs: 250, fadeInMs: 450, risePx: 28, popFromPct: 100, grow: null, scaleMs: 0 },
  rule: { role: "rule", delayMs: 400, fadeInMs: 150, risePx: 0, popFromPct: 100, grow: "x", scaleMs: 450 },
};

/** Every overlay layer fades out over the last part of the video (inside the recipe's tail pad). */
export const LAYER_EXIT_FADE_MS = 300;

export const CAPTION_MOTION = { fadeInMs: 90, popFromPct: 92, popMs: 150 } as const;
export type CaptionMotion = typeof CAPTION_MOTION;

/** A box at least this wide (or tall) is a panel; at most this thin it is a rule. */
const PANEL_MIN_WIDTH = 900;
const PANEL_MIN_HEIGHT = 150;
const RULE_MAX_THICKNESS = 16;

/** Motion of one recipe layer: its role from its geometry and slot, then the shared timing of that role. */
export function layerMotionFor(layer: RecipeLayer): LayerMotion {
  if (layer.type === "box") {
    if (layer.h <= RULE_MAX_THICKNESS) return { ...LAYER_MOTION.rule, grow: "x" };
    if (layer.w <= RULE_MAX_THICKNESS) return { ...LAYER_MOTION.rule, grow: "y" };
    if (layer.w >= PANEL_MIN_WIDTH || layer.h >= PANEL_MIN_HEIGHT) return { ...LAYER_MOTION.panel };
    return layer.visibleIfSlot === "headline" ? { ...LAYER_MOTION.headline } : { ...LAYER_MOTION.badge };
  }
  return layer.slot === "headline" ? { ...LAYER_MOTION.headline } : { ...LAYER_MOTION.badge };
}

export type MotionState = {
  /** 0..1 multiplier of the layer's own opacity. */
  opacity: number;
  /** Vertical offset from the final position (px, positive = lower). */
  dy: number;
  /** Uniform scale around the layer centre. */
  scale: number;
  /** Scale along the grow axis from its start edge (1 = full). */
  growScale: number;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const ramp = (tMs: number, startMs: number, lengthMs: number): number => (lengthMs <= 0 ? (tMs >= startMs ? 1 : 0) : clamp01((tMs - startMs) / lengthMs));

/**
 * State of a layer at `tMs` of a video lasting `totalMs` - exactly what the engine's ASS tags produce: before its delay the layer is not drawn
 * (opacity 0), then fades / rises / pops / grows linearly, then holds, then fades out over the last `LAYER_EXIT_FADE_MS`.
 */
export function layerMotionAt(motion: LayerMotion, tMs: number, totalMs: number): MotionState {
  if (tMs < motion.delayMs) return { opacity: 0, dy: motion.risePx, scale: motion.popFromPct / 100, growScale: motion.grow ? 0 : 1 };
  const fadeIn = ramp(tMs, motion.delayMs, motion.fadeInMs);
  const exitMs = Math.min(LAYER_EXIT_FADE_MS, Math.max(0, totalMs - motion.delayMs - motion.fadeInMs));
  const fadeOut = exitMs > 0 ? 1 - ramp(tMs, totalMs - exitMs, exitMs) : 1;
  const scaleProgress = ramp(tMs, motion.delayMs, motion.scaleMs);
  const from = motion.popFromPct / 100;
  return {
    opacity: Math.min(fadeIn, fadeOut),
    dy: motion.risePx * (1 - ramp(tMs, motion.delayMs, motion.fadeInMs)),
    scale: from + (1 - from) * scaleProgress,
    growScale: motion.grow ? scaleProgress : 1,
  };
}

/** A caption cue `sinceCueStartMs` after it appeared (the voice reached it): fade + pop, then steady. */
export function captionMotionAt(sinceCueStartMs: number, motion: CaptionMotion = CAPTION_MOTION): { opacity: number; scale: number } {
  if (sinceCueStartMs < 0) return { opacity: 0, scale: motion.popFromPct / 100 };
  const from = motion.popFromPct / 100;
  return { opacity: ramp(sinceCueStartMs, 0, motion.fadeInMs), scale: from + (1 - from) * ramp(sinceCueStartMs, 0, motion.popMs) };
}
