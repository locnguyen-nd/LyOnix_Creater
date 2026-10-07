/**
 * VE2E-93: Studio side of the caption style - pure helpers the text style panel, the previews and StudioProPage share. Every rule
 * (inheritance, value ranges, what an engine applies) comes from `@lyonix/domain`; nothing here decides support on its own.
 */
import { captionFontById, unverifiedCaptionScripts, type CaptionFontScript } from "@lyonix/domain/caption-fonts";
import { captionStyleEngineFor, type CaptionStyleEngine } from "@lyonix/domain/caption-style-capabilities";
import {
  applyCaptionStyleEdit,
  CAPTION_PATCH_FIELDS,
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
  if (pending?.scope === "video") optionValues = applyVideoCaptionEdit(ctx, pending.changes);
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
