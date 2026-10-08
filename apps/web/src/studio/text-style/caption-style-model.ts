/**
 * VE2E-93: Studio side of the caption style - pure helpers the text style panel, the previews and StudioProPage share. Every rule
 * (inheritance, value ranges, what an engine applies) comes from `@lyonix/domain`; nothing here decides support on its own.
 */
import { captionFontById, unverifiedCaptionScripts, type CaptionFontScript } from "@lyonix/domain/caption-fonts";
import { captionStyleEngineFor, type CaptionStyleEngine } from "@lyonix/domain/caption-style-capabilities";
import { CAPTION_PRESETS, captionPresetById, captionPresetChanges, captionPresetSupport, type CaptionPreset } from "@lyonix/domain/caption-presets";
import {
  applyCaptionStyleEdit,
  CAPTION_PATCH_FIELDS,
  CAPTION_PRESET_OPTION_KEY,
  captionPresetIdFromOptionValues,
  captionStyleFieldValue,
  captionStyleFromOptionValues,
  clearCaptionStyleOptionValues,
  legacyCaptionFontFamily,
  LEGACY_CAPTION_FONT_FAMILY_KEY,
  resolveCaptionTextStyle,
  setCaptionStyleOptionValue,
  type CaptionPatchField,
  type CaptionTemplateDefaults,
  type CaptionTextStyle,
  type CaptionTextStylePatch,
} from "@lyonix/domain/caption-style";

export type CaptionStyleScope = "video" | "scene";

/** One field change. `value: undefined` = back to what the scope inherits. */
export type CaptionStyleChange = { field: CaptionPatchField; value: CaptionTextStylePatch[CaptionPatchField] | undefined };

/** One user action (a field, or a group like the stroke reset) - written as ONE draft change (one undo entry). */
export type CaptionStyleEdit = {
  scope: CaptionStyleScope;
  /** The scene for a `scene` edit. */
  sceneId: string | null;
  changes: readonly CaptionStyleChange[];
  /** VE2E-94 (whole video only): this edit applies that caption preset - the whole-video style becomes the preset's and its id is kept. */
  presetId?: string;
};

export type StudioCaptionContext = {
  /** Null while no template is pinned (the caption style needs one: option values and the engine come with it). */
  engine: CaptionStyleEngine | null;
  defaults: CaptionTemplateDefaults | null;
  optionValues: Readonly<Record<string, string>>;
};

/** Engine whose capabilities apply in Studio (see `captionStyleEngineFor`). */
export const studioCaptionEngine = (template: { engine?: string | undefined } | null, renderProvider: string | null | undefined): CaptionStyleEngine | null =>
  captionStyleEngineFor({ hasTemplate: Boolean(template), templateEngine: template?.engine, renderProvider });

const engineOf = (ctx: StudioCaptionContext): CaptionStyleEngine => ctx.engine ?? "lyonix";

/** `#RGBA` / `#RRGGBBAA` -> its colour without the alpha (`#RRGGBB`). */
const withoutAlpha = (value: string): string => {
  const hex = value.trim().slice(1);
  return hex.length === 4 ? `#${[...hex.slice(0, 3)].map((ch) => ch + ch).join("")}` : `#${hex.slice(0, 6)}`;
};

const resolveWith = (ctx: StudioCaptionContext, optionValues: Readonly<Record<string, string>>, scene: CaptionTextStylePatch | null | undefined): CaptionTextStyle => {
  const engine = engineOf(ctx);
  const parsed = captionStyleFromOptionValues(optionValues);
  const style = resolveCaptionTextStyle({ engine, defaults: ctx.defaults, global: parsed.patch, legacyFontFamily: legacyCaptionFontFamily(engine, parsed.legacyFontFamily), scene });
  // A VE2E-26 fill colour with alpha is still applied by Creatomate (never by LyOnix): the Creatomate preview shows it too.
  const alpha = engine === "creatomate" && !style.fillColorFromUser ? parsed.issues.find((issue) => issue.kind === "alpha_color") : undefined;
  return alpha && alpha.kind === "alpha_color" ? { ...style, fillColor: withoutAlpha(alpha.value), fillColorFromUser: true } : style;
};

/** What a scope inherits: the whole video inherits the template; a scene inherits the whole-video style. */
export function inheritedCaptionStyle(ctx: StudioCaptionContext, scope: CaptionStyleScope): CaptionTextStyle {
  return scope === "video" ? resolveCaptionTextStyle({ engine: engineOf(ctx), defaults: ctx.defaults }) : resolveWith(ctx, ctx.optionValues, null);
}

/** `optionValues` after a whole-video edit (only the changed fields' keys change; a value equal to the template default removes the key). */
export function applyVideoCaptionEdit(ctx: StudioCaptionContext, changes: readonly CaptionStyleChange[]): Record<string, string> {
  const inherited = inheritedCaptionStyle(ctx, "video");
  let values: Record<string, string> = { ...ctx.optionValues };
  for (const { field, value } of changes) {
    const next = applyCaptionStyleEdit(captionStyleFromOptionValues(values).patch, field, value, inherited);
    values = setCaptionStyleOptionValue(values, field, next?.[field]);
  }
  return values;
}

/**
 * VE2E-94: `optionValues` after applying a caption preset to the whole video: the previous whole-video caption style (incl. a VE2E-26
 * font) is replaced by the preset's values - stored as values, a field equal to the template default is not stored - plus the preset id.
 * Scene overrides are untouched.
 */
export function applyVideoCaptionPreset(ctx: StudioCaptionContext, item: CaptionPreset): Record<string, string> {
  const cleared = clearCaptionStyleOptionValues(ctx.optionValues);
  return { ...applyVideoCaptionEdit({ ...ctx, optionValues: cleared }, captionPresetChanges(item)), [CAPTION_PRESET_OPTION_KEY]: item.id };
}

/** The edit "apply this preset to the whole video" (preview while hovered, one undoable change when chosen). */
export const captionPresetEdit = (item: CaptionPreset): CaptionStyleEdit => ({ scope: "video", sceneId: null, changes: captionPresetChanges(item), presetId: item.id });

/** `optionValues` after a committed whole-video edit (a preset edit replaces the style, a field edit changes only its fields). */
export function applyVideoEdit(ctx: StudioCaptionContext, edit: CaptionStyleEdit): Record<string, string> {
  const item = captionPresetById(edit.presetId);
  return item ? applyVideoCaptionPreset(ctx, item) : applyVideoCaptionEdit(ctx, edit.changes);
}

export type CaptionPresetStatus = { kind: "preset"; preset: CaptionPreset } | { kind: "custom"; basedOn: CaptionPreset | null } | { kind: "template" };

const sameFieldValue = (field: CaptionPatchField, a: unknown, b: unknown): boolean =>
  (field === "fillColor" || field === "strokeColor") && typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Whether the whole-video style currently looks exactly like `item` would make it (every field, as the engine resolves it). */
export function wholeVideoMatchesPreset(ctx: StudioCaptionContext, item: CaptionPreset): boolean {
  const current = resolveWith(ctx, ctx.optionValues, null);
  const applied = resolveWith(ctx, applyVideoCaptionPreset(ctx, item), null);
  return CAPTION_PATCH_FIELDS.every((field) => sameFieldValue(field, captionStyleFieldValue(current, field), captionStyleFieldValue(applied, field)));
}

/**
 * VE2E-94: what the whole-video style is, for the preset UI. The stored preset id says which preset it came from: still identical ->
 * that preset, edited since -> "customised from" it (nothing is reset). Without an id (a timeline made before VE2E-94) a style identical
 * to a supported preset is recognised (deterministic: same values for every field); any other stored style is "customised", none at all is
 * the template default.
 */
export function captionPresetStatus(ctx: StudioCaptionContext): CaptionPresetStatus {
  const stored = captionPresetById(captionPresetIdFromOptionValues(ctx.optionValues));
  if (stored) return wholeVideoMatchesPreset(ctx, stored) ? { kind: "preset", preset: stored } : { kind: "custom", basedOn: stored };
  const parsed = captionStyleFromOptionValues(ctx.optionValues);
  const hasStyle = Object.keys(parsed.patch).length > 0 || Boolean(parsed.legacyFontFamily);
  if (!hasStyle) return { kind: "template" };
  const detected = CAPTION_PRESETS.find((item) => captionPresetSupport(engineOf(ctx), item).ok && wholeVideoMatchesPreset(ctx, item));
  return detected ? { kind: "preset", preset: detected } : { kind: "custom", basedOn: null };
}

/** A scene's override after an edit (null = the scene inherits everything). */
export function applySceneCaptionEdit(ctx: StudioCaptionContext, scenePatch: CaptionTextStylePatch | null | undefined, changes: readonly CaptionStyleChange[]): CaptionTextStylePatch | null {
  const inherited = inheritedCaptionStyle(ctx, "scene");
  let patch = scenePatch ?? null;
  for (const { field, value } of changes) patch = applyCaptionStyleEdit(patch, field, value, inherited);
  return patch;
}

/** "Reset the whole video to the template default". */
export const resetVideoCaptionStyle = (optionValues: Readonly<Record<string, string>>): Record<string, string> => clearCaptionStyleOptionValues(optionValues);

/**
 * Effective style of one scene as the preview shows it: the committed style plus the edit the user is dragging right now (not in the
 * draft yet - it is written once, on release).
 */
export function previewCaptionStyle(ctx: StudioCaptionContext, sceneId: string | null, scenePatch: CaptionTextStylePatch | null | undefined, pending: CaptionStyleEdit | null): CaptionTextStyle {
  // Orshot applies no caption style at all: the preview shows what it renders (template/system default), not the saved values.
  if (ctx.engine === "orshot") return resolveCaptionTextStyle({ engine: "orshot", defaults: ctx.defaults });
  let optionValues = ctx.optionValues;
  let patch = scenePatch ?? null;
  if (pending?.scope === "video") optionValues = applyVideoEdit(ctx, pending);
  if (pending?.scope === "scene" && sceneId !== null && pending.sceneId === sceneId) patch = applySceneCaptionEdit(ctx, patch, pending.changes);
  return resolveWith({ ...ctx, optionValues }, optionValues, patch);
}

/** Whether the scope itself sets a field (badge "customised" vs "inherited"). */
export function isFieldCustomized(ctx: StudioCaptionContext, scope: CaptionStyleScope, scenePatch: CaptionTextStylePatch | null | undefined, fields: readonly CaptionPatchField[]): boolean {
  if (scope === "scene") return fields.some((field) => scenePatch?.[field] !== undefined);
  const parsed = captionStyleFromOptionValues(ctx.optionValues);
  return fields.some((field) => parsed.patch[field] !== undefined) || (fields.includes("fontId") && Boolean(ctx.optionValues[LEGACY_CAPTION_FONT_FAMILY_KEY]?.trim()));
}

export const countCustomizedFields = (patch: CaptionTextStylePatch | null | undefined): number => CAPTION_PATCH_FIELDS.filter((field) => patch?.[field] !== undefined).length;

export type CaptionStyleNotice =
  | { kind: "legacy_font"; font: string }
  | { kind: "unknown_font" }
  | { kind: "alpha_color"; color: string }
  | { kind: "unverified_scripts"; font: string; scripts: CaptionFontScript[] }
  | { kind: "preview_font"; font: string }
  | { kind: "stored_ignored" }
  | { kind: "highlight_unsupported" }
  | { kind: "color_cycle" }
  | { kind: "highlight_fallback" };

/**
 * Everything the user must be told about the shown style - never a silent fallback: a legacy or unknown font, a colour the engine cannot
 * draw, a font not verified for the scripts of the captions, a font the browser does not have, stored values the engine ignores.
 */
export function captionStyleNotices(input: {
  ctx: StudioCaptionContext;
  style: CaptionTextStyle;
  scenePatch: CaptionTextStylePatch | null | undefined;
  /** Caption texts the style applies to (the scene's, or every scene's for the whole video). */
  texts: readonly string[];
  /** Any scene of the timeline has its own override. */
  anySceneOverride: boolean;
  /** The pinned LyOnix template may fall back to a provider template (Router). */
  hasFallback: boolean;
}): CaptionStyleNotice[] {
  const { ctx, style } = input;
  const engine = ctx.engine;
  const parsed = captionStyleFromOptionValues(ctx.optionValues);
  const notices: CaptionStyleNotice[] = [];
  for (const issue of parsed.issues) {
    if (issue.kind === "legacy_font" && style.font.source === "legacy") notices.push({ kind: "legacy_font", font: issue.family });
    if (issue.kind === "unknown_font") notices.push({ kind: "unknown_font" });
    if (issue.kind === "alpha_color" && engine === "lyonix") notices.push({ kind: "alpha_color", color: issue.value });
  }
  const font = captionFontById(style.font.id);
  if (font) {
    const scripts = unverifiedCaptionScripts(font, input.texts);
    if (scripts.length > 0) notices.push({ kind: "unverified_scripts", font: font.label, scripts });
  } else {
    notices.push({ kind: "preview_font", font: style.font.family });
  }
  if (engine === "orshot" && (Object.keys(parsed.patch).length > 0 || parsed.legacyFontFamily || input.anySceneOverride)) notices.push({ kind: "stored_ignored" });
  if (engine === "creatomate" && (parsed.patch.animation === "word_highlight" || input.scenePatch?.animation === "word_highlight")) notices.push({ kind: "highlight_unsupported" });
  if (engine === "lyonix" && ctx.defaults?.colorCycle?.length) notices.push({ kind: "color_cycle" });
  if (engine === "lyonix" && input.hasFallback && style.animation === "word_highlight") notices.push({ kind: "highlight_fallback" });
  return notices;
}

/**
 * VE2E-93 autosave rule: while a slider or colour picker moves, `preview` only updates the preview; the draft (undo stack + debounced
 * autosave) receives ONE write per gesture, on release (`commit`). A commit without a pending value is a no-op.
 */
export class CaptionStyleEditSession {
  private pending: CaptionStyleEdit | null = null;

  constructor(
    private readonly onPreview: (edit: CaptionStyleEdit | null) => void,
    private readonly onCommit: (edit: CaptionStyleEdit) => void,
  ) {}

  preview(edit: CaptionStyleEdit): void {
    this.pending = edit;
    this.onPreview(edit);
  }

  /** Writes `edit` (or the pending one) once and clears the preview. */
  commit(edit?: CaptionStyleEdit): void {
    const value = edit ?? this.pending;
    this.pending = null;
    this.onPreview(null);
    if (value) this.onCommit(value);
  }

  cancel(): void {
    this.pending = null;
    this.onPreview(null);
  }
}
