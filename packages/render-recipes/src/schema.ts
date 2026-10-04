/**
 * VE2E-105/107: declarative recipe for the internal `lyonix` render engine - the equivalent of a Creatomate/Orshot template,
 * but versioned in the repo. A recipe describes the look (background motion, transition, overlay boxes/text, caption style,
 * audio policy) and the option slots a user may change; the media-worker turns recipe + RenderPlan into one FFmpeg run.
 *
 * Pure data + a validator, no I/O, browser-safe. Recipes are immutable once released: a change is a new `version`.
 */

export const RECIPE_SCHEMA_VERSION = 1 as const;

export type RecipeTransitionKind = "none" | "fade" | "wipe" | "slide" | "circle";
export type RecipeMotion = "none" | "zoom_in" | "zoom_out";

export type RecipeSlotKind = "text" | "color" | "font" | "volume";

/** Same shape as `TemplateModificationSlot` (packages/providers) so internal templates list their options like provider templates. */
export type RecipeSlot = {
  key: string;
  kind: RecipeSlotKind;
  label: string;
  required: boolean;
  /** Used when the timeline carries no value for the key. */
  default?: string;
};

type LayerBase = {
  id: string;
  /** When set the layer is drawn only if this slot resolves to a non-empty value. */
  visibleIfSlot?: string;
};

export type RecipeBoxLayer = LayerBase & {
  type: "box";
  x: number;
  y: number;
  w: number;
  h: number;
  /** `#RRGGBB`, or `slot:<key>` to read the colour from a `color` slot. */
  color: string;
  opacity: number;
};

export type RecipeTextLayer = LayerBase & {
  type: "text";
  /** The text comes from this `text` slot (e.g. a headline). */
  slot: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontFamily: string;
  fontSizePx: number;
  minFontSizePx: number;
  color: string;
  bold: boolean;
  maxLines: number;
  outlinePx: number;
  outlineColor: string;
};

export type RecipeLayer = RecipeBoxLayer | RecipeTextLayer;

export type RecipeCaptions = {
  enabled: boolean;
  fontFamily: string;
  fontSizePx: number;
  minFontSizePx: number;
  maxLines: number;
  bold: boolean;
  /** Not-yet-spoken colour. */
  textColor: string;
  /** Already-spoken colour (word highlight). */
  highlightColor: string;
  outlineColor: string;
  outlinePx: number;
  highlight: "word" | "none";
};

export type RenderRecipe = {
  schemaVersion: typeof RECIPE_SCHEMA_VERSION;
  id: string;
  version: number;
  name: string;
  canvas: { width: 1080; height: 1920 };
  fps: 60;
  /** Hold before the first and after the last scene. */
  timing: { padStartMs: number; padEndMs: number };
  /** Default scene transition; the plan may override per scene. */
  transition: { kind: RecipeTransitionKind; durationMs: number };
  background: {
    image: { motion: RecipeMotion; /** 0..0.2 extra scale reached at the end of the scene. */ intensity: number; alternate: boolean };
    video: { motion: RecipeMotion; intensity: number };
    tint: { color: string; opacity: number } | null;
  };
  layers: RecipeLayer[];
  captions: RecipeCaptions;
  audio: {
    /** Music level while nobody speaks (dB, <= 0). */
    musicBaseDb: number;
    /** Music level while a voice plays (dB, <= musicBaseDb). The plan says ~12 dB below. */
    musicDuckDb: number;
    duckRampMs: number;
    loudnessLufs: number;
    truePeakDb: number;
  };
  slots: RecipeSlot[];
  /** Font families the recipe needs on the render host (installed via the image / RENDER_FONTS_DIR). */
  fonts: string[];
};

export type RecipeValidation = { ok: true; value: RenderRecipe } | { ok: false; errors: string[] };

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const KEY_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const TRANSITIONS = ["none", "fade", "wipe", "slide", "circle"];
const MOTIONS = ["none", "zoom_in", "zoom_out"];
const SLOT_KINDS = ["text", "color", "font", "volume"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isNum = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const isInt = (value: unknown, min: number, max: number): value is number => isNum(value, min, max) && Number.isInteger(value);

export function validateRecipe(input: unknown): RecipeValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["recipe must be an object"] };
  if (input.schemaVersion !== RECIPE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${RECIPE_SCHEMA_VERSION}`);
  if (typeof input.id !== "string" || !ID_RE.test(input.id)) errors.push("id must match [a-z0-9][a-z0-9._-]{0,79}");
  if (!isInt(input.version, 1, 10_000)) errors.push("version must be an integer >= 1");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) errors.push("name must be a short non-empty string");
  if (!isRecord(input.canvas) || input.canvas.width !== 1080 || input.canvas.height !== 1920) errors.push("canvas must be 1080x1920");
  if (input.fps !== 60) errors.push("fps must be 60 (hard requirement)");
  const timing = input.timing;
  if (!isRecord(timing) || !isNum(timing.padStartMs, 0, 10_000) || !isNum(timing.padEndMs, 0, 10_000)) errors.push("timing.padStartMs/padEndMs must be in [0, 10000]");
  const transition = input.transition;
  if (!isRecord(transition) || typeof transition.kind !== "string" || !TRANSITIONS.includes(transition.kind) || !isNum(transition.durationMs, 0, 2000)) errors.push("transition must be {kind, durationMs 0..2000}");

  const background = input.background;
  if (!isRecord(background)) {
    errors.push("background must be an object");
  } else {
    for (const kind of ["image", "video"] as const) {
      const motion = background[kind];
      if (!isRecord(motion) || typeof motion.motion !== "string" || !MOTIONS.includes(motion.motion) || !isNum(motion.intensity, 0, 0.2)) errors.push(`background.${kind} must be {motion, intensity 0..0.2}`);
    }
    if (isRecord(background.image) && typeof background.image.alternate !== "boolean") errors.push("background.image.alternate must be a boolean");
    const tint = background.tint;
    if (tint !== null && (!isRecord(tint) || typeof tint.color !== "string" || !HEX_RE.test(tint.color) || !isNum(tint.opacity, 0, 1))) errors.push("background.tint must be null or {color #RRGGBB, opacity 0..1}");
  }

  const slotKeys = new Map<string, RecipeSlot>();
  if (!Array.isArray(input.slots)) errors.push("slots must be an array");
  else {
    input.slots.forEach((slot, index) => {
      if (!isRecord(slot) || typeof slot.key !== "string" || !KEY_RE.test(slot.key) || typeof slot.kind !== "string" || !SLOT_KINDS.includes(slot.kind) || typeof slot.label !== "string" || typeof slot.required !== "boolean") {
        errors.push(`slots[${index}] must be {key, kind, label, required}`);
        return;
      }
      if (slotKeys.has(slot.key)) errors.push(`slots[${index}].key duplicated: ${slot.key}`);
      if (slot.default !== undefined && typeof slot.default !== "string") errors.push(`slots[${index}].default must be a string`);
      slotKeys.set(slot.key, slot as unknown as RecipeSlot);
    });
  }

  const layerIds = new Set<string>();
  if (!Array.isArray(input.layers)) errors.push("layers must be an array");
  else {
    input.layers.forEach((layer, index) => {
      const label = `layers[${index}]`;
      if (!isRecord(layer) || typeof layer.id !== "string" || !KEY_RE.test(layer.id)) {
        errors.push(`${label} must have an id`);
        return;
      }
      if (layerIds.has(layer.id)) errors.push(`${label}.id duplicated: ${layer.id}`);
      layerIds.add(layer.id);
      if (layer.visibleIfSlot !== undefined && (typeof layer.visibleIfSlot !== "string" || !slotKeys.has(layer.visibleIfSlot))) errors.push(`${label}.visibleIfSlot must name a slot`);
      for (const key of ["x", "y", "w", "h"] as const) if (!isInt(layer[key], 0, 4000)) errors.push(`${label}.${key} must be an integer in [0, 4000]`);
      if (isInt(layer.x, 0, 4000) && isInt(layer.w, 0, 4000) && layer.x + layer.w > 1080) errors.push(`${label} extends past the canvas width`);
      if (isInt(layer.y, 0, 4000) && isInt(layer.h, 0, 4000) && layer.y + layer.h > 1920) errors.push(`${label} extends past the canvas height`);
      if (layer.type === "box") {
        const colorSlot = typeof layer.color === "string" && layer.color.startsWith("slot:") ? slotKeys.get(layer.color.slice(5)) : null;
        if (typeof layer.color !== "string" || !(HEX_RE.test(layer.color) || colorSlot?.kind === "color")) errors.push(`${label}.color must be #RRGGBB or slot:<color slot>`);
        if (!isNum(layer.opacity, 0, 1)) errors.push(`${label}.opacity must be in [0, 1]`);
      } else if (layer.type === "text") {
        const slot = typeof layer.slot === "string" ? slotKeys.get(layer.slot) : undefined;
        if (!slot || slot.kind !== "text") errors.push(`${label}.slot must name a text slot`);
        if (typeof layer.fontFamily !== "string" || !layer.fontFamily.trim()) errors.push(`${label}.fontFamily is required`);
        if (!isInt(layer.fontSizePx, 8, 400) || !isInt(layer.minFontSizePx, 8, 400) || (layer.minFontSizePx as number) > (layer.fontSizePx as number)) errors.push(`${label} font sizes must satisfy 8 <= min <= size <= 400`);
        if (typeof layer.color !== "string" || !HEX_RE.test(layer.color) || typeof layer.outlineColor !== "string" || !HEX_RE.test(layer.outlineColor)) errors.push(`${label}.color/outlineColor must be #RRGGBB`);
        if (typeof layer.bold !== "boolean" || !isInt(layer.maxLines, 1, 4) || !isNum(layer.outlinePx, 0, 20)) errors.push(`${label} needs bold, maxLines 1..4, outlinePx 0..20`);
      } else {
        errors.push(`${label}.type must be box|text`);
      }
    });
  }

  const captions = input.captions;
  if (!isRecord(captions)) errors.push("captions must be an object");
  else {
    if (typeof captions.enabled !== "boolean" || typeof captions.bold !== "boolean") errors.push("captions.enabled/bold must be booleans");
    if (typeof captions.fontFamily !== "string" || !captions.fontFamily.trim()) errors.push("captions.fontFamily is required");
    if (!isInt(captions.fontSizePx, 16, 200) || !isInt(captions.minFontSizePx, 16, 200) || (captions.minFontSizePx as number) > (captions.fontSizePx as number)) errors.push("captions font sizes must satisfy 16 <= min <= size <= 200");
    if (!isInt(captions.maxLines, 1, 3)) errors.push("captions.maxLines must be 1..3");
    for (const key of ["textColor", "highlightColor", "outlineColor"] as const) if (typeof captions[key] !== "string" || !HEX_RE.test(captions[key] as string)) errors.push(`captions.${key} must be #RRGGBB`);
    if (!isNum(captions.outlinePx, 0, 20)) errors.push("captions.outlinePx must be 0..20");
    if (captions.highlight !== "word" && captions.highlight !== "none") errors.push("captions.highlight must be word|none");
  }

  const audio = input.audio;
  if (!isRecord(audio) || !isNum(audio.musicBaseDb, -60, 0) || !isNum(audio.musicDuckDb, -60, 0) || !isNum(audio.duckRampMs, 0, 2000) || !isNum(audio.loudnessLufs, -30, -5) || !isNum(audio.truePeakDb, -6, 0)) {
    errors.push("audio needs musicBaseDb/musicDuckDb (-60..0), duckRampMs (0..2000), loudnessLufs (-30..-5), truePeakDb (-6..0)");
  } else if ((audio.musicDuckDb as number) > (audio.musicBaseDb as number)) errors.push("audio.musicDuckDb must be <= musicBaseDb");

  if (!Array.isArray(input.fonts) || input.fonts.some((f) => typeof f !== "string" || !f.trim())) errors.push("fonts must be a list of family names");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as RenderRecipe };
}

/** Resolves the effective value of every slot: timeline value, else slot default, else empty. */
export function resolveRecipeParams(recipe: RenderRecipe, params: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const slot of recipe.slots) resolved[slot.key] = (params[slot.key] ?? "").trim() !== "" ? params[slot.key]!.trim() : slot.default ?? "";
  return resolved;
}

/** The recipe's option slots in the `TemplateModificationSlot` shape used by TemplateSnapshot.modifications. */
export const recipeToModificationSlots = (recipe: RenderRecipe): Array<{ key: string; kind: RecipeSlotKind; label: string; required: boolean }> =>
  recipe.slots.map((slot) => ({ key: slot.key, kind: slot.kind, label: slot.label, required: slot.required }));
