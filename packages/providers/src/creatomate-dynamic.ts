/**
 * Dynamic (template-free-structure) Creatomate composition: builds a full `source` JSON
 * from an arbitrary number of scenes instead of filling a pre-authored template's fixed
 * `Image-N`/`Subtitles-N`/`Voiceover-N` slots. A pinned `TemplateSnapshot` still supplies
 * visual style (font, colors, stroke, image pan effect) via `extractDynamicStyleFromTemplate`,
 * but the *number* of scenes a render contains is no longer capped by how many of those
 * elements the template's own author happened to draw — every scene the script produced
 * gets its own composition, and each one's duration matches its own narration audio's real
 * length instead of a fixed per-scene duration baked into the template.
 *
 * This deliberately never copies a text element's `transcript_source`/`transcript_effect`/
 * `transcript_color`/`transcript_maximum_length` properties: those drive Creatomate's own
 * auto-transcription-from-audio captions feature, which silently ignores a static `.text`
 * modification and requires extra Creatomate-account configuration LyOnix does not control.
 * Captions here are always the plain narration/caption text the tool itself generated.
 * Likewise an audio element's `provider`/`dynamic` Creatomate-native-voiceover metadata is
 * never copied — the audio `source` is always LyOnix's own already-generated narration clip.
 *
 * VE2E-32: a scene's caption is no longer always one static text block for the whole scene.
 * When `captionSegments` is given (the scene's real ElevenLabs-alignment-derived
 * `SubtitleVersion.segments` - see `caption-segmentation.ts`), each segment becomes its own
 * timed text element (`time`/`duration` taken straight from that segment's real start/end),
 * so on-screen text actually tracks the spoken narration instead of sitting on screen for the
 * scene's entire duration. `text` remains the fallback static block, used whenever
 * `captionSegments` is omitted/empty (no alignment available yet, or the caller passed a
 * human-typed Studio override that has no per-word timing to draw from).
 *
 * V03-03: every caption block (timed segment or static block) is then split into consecutive pages of at most 2 lines
 * (`paginateCaptionBlocks`), so a long cue or a whole-scene block never shows 3-4 lines on screen at once.
 */
import {
  CAPTION_POSITION_LAYOUT,
  captionFontById,
  captionStyleFromOptionValues,
  DEFAULT_CAPTION_STROKE_WIDTH_PX,
  isCaptionStyleOptionKey,
  isValidCaptionStyleOptionValue,
  normalizeHexColor,
  type CaptionTemplateDefaults,
  type CaptionTextStylePatch,
} from "@lyonix/domain";
import { creatomateLengthPx, MAX_CAPTION_LINES, paginateCaptionBlocks } from "./caption-pages.js";

export type DynamicCaptionSegment = { text: string; startMs: number; endMs: number };

export type DynamicSceneInput = {
  sceneId: string;
  mediaUrl: string;
  mediaKind: "image" | "video";
  text: string;
  /** Real voice-timed caption segments for this scene, when available - see file header. Empty/omitted falls back to one static `text` block for the whole scene. */
  captionSegments?: readonly DynamicCaptionSegment[];
  audioUrl: string;
  audioDurationMs: number;
  /** Preview-only source range. Final renders use a prepared derivative instead. */
  sourceStartMs?: number | null;
  sourceDurationMs?: number | null;
  /** VE2E-93: this scene's caption style override (on top of the whole-video `DynamicSceneStyle.captionStyle`). */
  captionStyle?: CaptionTextStylePatch | null | undefined;
};

export type DynamicImageAnimation = { type: string; startScale: string; endScale: string; startX: string; endX: string; easing: string };

export type DynamicSceneStyle = {
  text: {
    fontFamily: string;
    fontSize: string;
    fillColor: string;
    fontWeight: string;
    xAlignment: string;
    yAlignment: string;
    strokeColor: string;
    strokeWidth: string;
    width: string;
    height: string;
    backgroundColor?: string | undefined;
    backgroundXPadding?: string | undefined;
    backgroundYPadding?: string | undefined;
    backgroundBorderRadius?: string | undefined;
  };
  image: {
    colorOverlay?: string | undefined;
    animation?: DynamicImageAnimation | undefined;
  };
  /**
   * VE2E-52: the pinned template's own scene layout (prototype Scene compositions + root-level
   * extras such as a badge/logo). Present only when the template has a repeatable Scene
   * composition; `buildDynamicComposition` then clones it to exactly N scenes instead of drawing
   * the generic style-only composition.
   */
  layout?: TemplateSceneLayout | undefined;
  /** VE2E-52: set when a template was supplied but has no repeatable Scene composition (generic style-only composition is used instead). */
  layoutFallbackReason?: "no_scene_composition" | undefined;
  /** VE2E-52: Studio overrides that must be applied on top of the cloned template layout. */
  layoutOverrides?: { captionFontFamily?: string; captionFillColor?: string; disablePan?: boolean } | undefined;
  /**
   * VE2E-93: whole-video caption style fields beyond the VE2E-26 font/fill overrides above (font from the catalog, size, stroke,
   * position, lines, animation). The fill colour stays on the VE2E-26 path; a scene's own `captionStyle` is applied on top.
   */
  captionStyle?: CaptionTextStylePatch | undefined;
};

export const DEFAULT_DYNAMIC_SCENE_STYLE: DynamicSceneStyle = {
  text: {
    fontFamily: "Montserrat",
    fontSize: "8 vmin",
    fillColor: "#ffffff",
    fontWeight: "700",
    xAlignment: "50%",
    yAlignment: "82%",
    strokeColor: "#000000",
    strokeWidth: "1 vmin",
    width: "86%",
    height: "22%",
  },
  image: {
    colorOverlay: "rgba(0,0,0,0.15)",
    animation: { type: "pan", startScale: "120%", endScale: "100%", startX: "50%", endX: "50%", easing: "linear" },
  },
};

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

type RawNode = Record<string, unknown>;

/**
 * A template's real pan/zoom (Ken Burns) animation entry always carries these four scale/
 * position fields — an entry that merely has *some* `type` string but lacks this shape is a
 * different animation kind entirely (e.g. a fade/wipe/spin effect with no scale/position
 * concept at all). VE2E-26 root cause #1: the previous version accepted the first entry with
 * any `type` string, regardless of shape, and paired that foreign `type` with our own
 * default-filled scale/position fields — a hybrid animation object Creatomate never actually
 * authored, producing a visibly wrong (or provider-rejected) result. Only accept an entry
 * that actually has the fields this code goes on to read.
 */
const looksLikePanZoomAnimation = (node: RawNode): boolean =>
  typeof node.type === "string" && asString(node.start_scale) !== undefined && asString(node.end_scale) !== undefined && asString(node.start_x) !== undefined && asString(node.end_x) !== undefined;

/**
 * VE2E-26 root cause #2: a template's element tree can contain other text/image/video nodes
 * that are not the actual per-scene subtitle/media element the Auto/Studio pipeline cares
 * about (logo, watermark, title card, background layer, decorative shape...). A plain
 * depth-first "first element of this type found" walk can silently lift style from the wrong
 * one if such a node appears earlier in the tree. LyOnix's own template-authoring convention
 * already names the real elements predictably (`deriveTemplateModifications` in creatomate.ts
 * assumes `Text-N`/`Subtitles-N`/`Image-N`/`Video-N`/`Scene-N`-style names, and real accounts
 * observed in this project include e.g. "News-Image") — so prefer a conventionally-named
 * element when one exists, and only fall back to "first found of this type" (the prior
 * behavior, still correct for a template with no matching name) when none does.
 */
const TEXT_NAME_HINT = /subtitle|caption|text/i;
const IMAGE_NAME_HINT = /image|video|photo|scene|background/i;

/**
 * Best-effort style lift from a pinned template's raw element tree: the first `text`
 * element found supplies caption styling, the first `image`/`video` element found supplies
 * the background pan/zoom + overlay — preferring a conventionally-named element over an
 * arbitrary first match (see `TEXT_NAME_HINT`/`IMAGE_NAME_HINT` above). Falls back to
 * `DEFAULT_DYNAMIC_SCENE_STYLE` for whichever half is missing (or when no template was
 * pinned at all).
 */
function findStyleSources(rawTemplate: unknown): { textSource: RawNode | undefined; imageSource: RawNode | undefined } {
  let textSource: RawNode | undefined;
  let textNamedMatch = false;
  let imageSource: RawNode | undefined;
  let imageNamedMatch = false;

  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const el = node as RawNode;
    const type = typeof el.type === "string" ? el.type.toLowerCase() : "";
    const name = asString(el.name) ?? "";
    const named = (hint: RegExp) => hint.test(name);

    if (type === "text" && (!textSource || (!textNamedMatch && named(TEXT_NAME_HINT)))) {
      textSource = el;
      textNamedMatch = named(TEXT_NAME_HINT);
    }
    if ((type === "image" || type === "video") && (!imageSource || (!imageNamedMatch && named(IMAGE_NAME_HINT)))) {
      imageSource = el;
      imageNamedMatch = named(IMAGE_NAME_HINT);
    }

    for (const value of Object.values(el)) walk(value);
  };
  walk(rawTemplate);
  return { textSource, imageSource };
}

/** VE2E-93: the template element its caption style is lifted from (same choice as `extractDynamicStyleFromTemplate`), if any. */
export const findTemplateCaptionNode = (rawTemplate: unknown): RawNode | undefined => findStyleSources(rawTemplate).textSource;

export function extractDynamicStyleFromTemplate(rawTemplate: unknown): DynamicSceneStyle {
  let text = { ...DEFAULT_DYNAMIC_SCENE_STYLE.text };
  let image = { ...DEFAULT_DYNAMIC_SCENE_STYLE.image };
  const { textSource, imageSource } = findStyleSources(rawTemplate);

  if (textSource) {
    const el = textSource;
    text = {
      fontFamily: asString(el.font_family) ?? text.fontFamily,
      fontSize: asString(el.font_size) ?? text.fontSize,
      fillColor: asString(el.fill_color) ?? text.fillColor,
      fontWeight: asString(el.font_weight) ?? text.fontWeight,
      xAlignment: asString(el.x_alignment) ?? text.xAlignment,
      yAlignment: asString(el.y_alignment) ?? text.yAlignment,
      strokeColor: asString(el.stroke_color) ?? text.strokeColor,
      strokeWidth: asString(el.stroke_width) ?? text.strokeWidth,
      width: asString(el.width) ?? text.width,
      height: asString(el.height) ?? text.height,
      backgroundColor: asString(el.background_color),
      backgroundXPadding: asString(el.background_x_padding),
      backgroundYPadding: asString(el.background_y_padding),
      backgroundBorderRadius: asString(el.background_border_radius),
    };
  }

  if (imageSource) {
    const el = imageSource;
    const animations = Array.isArray(el.animations) ? (el.animations as RawNode[]) : [];
    const pan = animations.find(looksLikePanZoomAnimation);
    image = {
      colorOverlay: asString(el.color_overlay) ?? image.colorOverlay,
      animation: pan
        ? {
            type: asString(pan.type)!,
            startScale: asString(pan.start_scale)!,
            endScale: asString(pan.end_scale)!,
            startX: asString(pan.start_x)!,
            endX: asString(pan.end_x)!,
            easing: asString(pan.easing) ?? DEFAULT_DYNAMIC_SCENE_STYLE.image.animation!.easing,
          }
        : image.animation,
    };
  }

  const layoutResult = extractTemplateSceneLayout(rawTemplate);
  return {
    text,
    image,
    ...(layoutResult.layout ? { layout: layoutResult.layout } : {}),
    ...(layoutResult.fallbackReason ? { layoutFallbackReason: layoutResult.fallbackReason } : {}),
  };
}

// --- VE2E-52: template-driven scalable composition ---------------------------------------

/**
 * A pinned template's own repeatable structure. `scenes` are the template's Scene compositions in
 * order (the prototypes); scene i of an N-scene render clones `scenes[i % scenes.length]`, so the
 * template's own alternating variants (subtitle colors, transitions, overlays) cycle naturally.
 * `rootProps` are non-element root properties (fill_color, frame_rate, fonts ...). `rootBefore` /
 * `rootAfter` are non-scene root elements (badge, logo ...) kept around the scenes.
 */
export type TemplateSceneLayout = {
  width: number | null;
  height: number | null;
  rootProps: RawNode;
  rootBefore: RawNode[];
  rootAfter: RawNode[];
  scenes: RawNode[];
  /** Sum of the prototype scenes' own durations in seconds, when they are all numeric (null otherwise). */
  templateSeconds: number | null;
  /** Static (non-dynamic) text elements whose text differs between the template's scenes (e.g. Top 5 rank badges). */
  staticTextSeries: Record<string, "desc" | "asc" | "varying">;
};

/** `caption_highlight_unsupported` (VE2E-93): the caption style asks for the word highlight, which this pipeline never draws on Creatomate. */
export type TemplateScaleWarning = "template_layout_fallback" | "rank_badges_renumbered" | "static_text_not_scalable" | "no_caption_element" | "caption_highlight_unsupported";

// --- VE2E-93: caption style -> Creatomate text element properties -------------------------------------------------------

/** Canonical pixels are on the 1080-wide reference canvas; `vmin` keeps the same proportion on any 9:16 template resolution. */
const pxToVmin = (px: number): string => `${Math.round((px * 100_000) / 1080) / 1000} vmin`;

/** Where each position preset puts the caption box (`y` = anchor point, `y_anchor` = which edge, `y_alignment` = text inside the box). */
const CREATOMATE_POSITION: Record<NonNullable<CaptionTextStylePatch["position"]>, { y: string; y_anchor: string; y_alignment: string }> = {
  top: { y: `${CAPTION_POSITION_LAYOUT.top.percent}%`, y_anchor: "0%", y_alignment: "0%" },
  middle: { y: `${CAPTION_POSITION_LAYOUT.middle.percent}%`, y_anchor: "50%", y_alignment: "50%" },
  bottom: { y: `${100 - CAPTION_POSITION_LAYOUT.bottom.percent}%`, y_anchor: "100%", y_alignment: "100%" },
};

/** Effective caption patch of one scene: whole video, then the scene's own fields. */
const scenePatch = (style: DynamicSceneStyle, scene: DynamicSceneInput): CaptionTextStylePatch => ({ ...(style.captionStyle ?? {}), ...(scene.captionStyle ?? {}) });

/** Font size the page layout must use: the style's (if set) else the element's own. */
const captionFontSize = (patch: CaptionTextStylePatch, fallback: string): string => (patch.fontSizePx !== undefined ? pxToVmin(patch.fontSizePx) : fallback);
const captionMaxLines = (patch: CaptionTextStylePatch): 1 | 2 => (patch.maxLines === 1 ? 1 : MAX_CAPTION_LINES);

/**
 * Writes a caption style patch onto one caption text node (after the VE2E-26 font/fill overrides). Fields the patch does not set keep the
 * template's own values. Stroke widths are doubled: a Creatomate stroke is centred on the glyph outline, the canonical width (ASS outline)
 * is what shows outside the glyph.
 */
function applyCaptionPatch(node: RawNode, patch: CaptionTextStylePatch): void {
  const font = captionFontById(patch.fontId);
  if (font) node.font_family = font.families.creatomate;
  if (patch.fontSizePx !== undefined) node.font_size = pxToVmin(patch.fontSizePx);
  if (patch.fillColor !== undefined) node.fill_color = patch.fillColor;
  if (patch.strokeEnabled === false) {
    delete node.stroke_color;
    delete node.stroke_width;
  } else {
    if (patch.strokeColor !== undefined) node.stroke_color = patch.strokeColor;
    if (patch.strokeWidthPx !== undefined) node.stroke_width = pxToVmin(patch.strokeWidthPx * 2);
    if (patch.strokeEnabled === true) {
      if (node.stroke_color === undefined) node.stroke_color = "#000000";
      if (node.stroke_width === undefined) node.stroke_width = pxToVmin(DEFAULT_CAPTION_STROKE_WIDTH_PX * 2);
    }
  }
  if (patch.position !== undefined) Object.assign(node, CREATOMATE_POSITION[patch.position]);
}

const asksForHighlight = (patch: CaptionTextStylePatch): boolean => patch.animation === "word_highlight";

const isNode = (value: unknown): value is RawNode => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const typeOf = (el: RawNode): string => (typeof el.type === "string" ? el.type.toLowerCase() : "");
const nameOf = (el: RawNode): string => (typeof el.name === "string" ? el.name.trim() : "");
const isDynamicFlag = (el: RawNode): boolean => el.dynamic === true || (Array.isArray(el.dynamic) && el.dynamic.length > 0);
const kidsOf = (el: RawNode): RawNode[] => (Array.isArray(el.elements) ? el.elements.filter(isNode) : []);
const isMediaType = (el: RawNode): boolean => typeOf(el) === "video" || typeOf(el) === "image";

/** Creatomate lengths may be numbers or strings like "3 s" / "3"; anything else (percent, "media") is not a plain second count. */
const toSeconds = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*s?\s*$/i.exec(value);
    if (match) return Number(match[1]);
  }
  return null;
};

const clone = <T>(value: T): T => structuredClone(value);

/** Removes everything that would make Creatomate re-derive content itself: dynamic flags, auto-transcription, template TTS provider. */
function sanitizeNode(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) sanitizeNode(item);
    return;
  }
  if (!isNode(node)) return;
  delete node.dynamic;
  for (const key of Object.keys(node)) if (key.startsWith("transcript_")) delete node[key];
  if (typeOf(node) === "audio") delete node.provider;
  for (const value of Object.values(node)) sanitizeNode(value);
}

/** Which direct children of a Scene composition play which role. Indexes into `kidsOf(scene)`, -1 when absent. */
function classifySceneChildren(scene: RawNode): { kids: RawNode[]; media: number; caption: number; voice: number } {
  const kids = kidsOf(scene);
  const find = (predicate: (kid: RawNode) => boolean) => kids.findIndex(predicate);
  let media = find((kid) => isMediaType(kid) && isDynamicFlag(kid));
  if (media < 0) media = find((kid) => isMediaType(kid) && /^(video|image|clip|photo|media)/i.test(nameOf(kid)));
  if (media < 0) media = find(isMediaType);
  let caption = find((kid) => typeOf(kid) === "text" && /subtitle|caption/i.test(nameOf(kid)));
  if (caption < 0) caption = find((kid) => typeOf(kid) === "text" && isDynamicFlag(kid));
  if (caption < 0) caption = find((kid) => typeOf(kid) === "text" && /text/i.test(nameOf(kid)));
  let voice = find((kid) => typeOf(kid) === "audio" && /voice|narrat|speech/i.test(nameOf(kid)));
  if (voice < 0) voice = find((kid) => typeOf(kid) === "audio" && isDynamicFlag(kid));
  if (voice < 0) voice = find((kid) => typeOf(kid) === "audio");
  return { kids, media, caption, voice };
}

/** Same element across the template's scenes: name without its trailing scene number (`RankBadge-3` -> `rankbadge`), or its position when unnamed. */
const staticKey = (name: string, index: number): string => (name ? name.replace(/[\s_-]*\d+$/, "").toLowerCase() || name.toLowerCase() : `#${index}`);

function detectStaticTextSeries(scenes: RawNode[]): TemplateSceneLayout["staticTextSeries"] {
  const series: TemplateSceneLayout["staticTextSeries"] = {};
  if (scenes.length < 2) return series;
  const perScene = scenes.map((scene) => {
    const { kids, media, caption, voice } = classifySceneChildren(scene);
    const found = new Map<string, string>();
    kids.forEach((kid, index) => {
      if (index === media || index === caption || index === voice || typeOf(kid) !== "text" || typeof kid.text !== "string") return;
      const key = staticKey(nameOf(kid), index);
      if (!found.has(key)) found.set(key, kid.text);
    });
    return found;
  });
  for (const key of perScene[0]!.keys()) {
    if (!perScene.every((found) => found.has(key))) continue;
    const texts = perScene.map((found) => found.get(key)!);
    if (texts.every((text) => text === texts[0])) continue;
    const ints = texts.map((text) => /\d+/.exec(text)?.[0]).map((digits) => (digits === undefined ? NaN : Number(digits)));
    const strictlyDesc = ints.every((value, i) => Number.isFinite(value) && (i === 0 || value < ints[i - 1]!));
    const strictlyAsc = ints.every((value, i) => Number.isFinite(value) && (i === 0 || value > ints[i - 1]!));
    series[key] = strictlyDesc ? "desc" : strictlyAsc ? "asc" : "varying";
  }
  return series;
}

/**
 * Finds the template's repeatable scene structure. Scenes are the root-level compositions named
 * like `Scene-N`; a template with no such name but two or more root compositions that each
 * hold a media + text element is treated the same way. Anything else (flat templates, a single
 * unnamed composition) has no repeatable structure and gets `fallbackReason`.
 */
export function extractTemplateSceneLayout(rawTemplate: unknown): { layout?: TemplateSceneLayout; fallbackReason?: "no_scene_composition" } {
  const root: { props: RawNode; elements: unknown[] } | null = Array.isArray(rawTemplate)
    ? { props: {}, elements: rawTemplate }
    : isNode(rawTemplate) && Array.isArray(rawTemplate.elements)
      ? { props: rawTemplate, elements: rawTemplate.elements }
      : null;
  if (!root) return {};
  const elements = root.elements.filter(isNode);
  const compositions = elements.filter((el) => typeOf(el) === "composition");
  let scenes = compositions.filter((el) => /scene/i.test(nameOf(el)));
  if (scenes.length === 0 && compositions.length >= 2) {
    const shaped = compositions.filter((el) => kidsOf(el).some(isMediaType) && kidsOf(el).some((kid) => typeOf(kid) === "text"));
    if (shaped.length === compositions.length) scenes = compositions;
  }
  if (scenes.length === 0) return elements.length > 0 ? { fallbackReason: "no_scene_composition" } : {};

  const firstSceneIndex = elements.indexOf(scenes[0]!);
  const others = elements.filter((el) => !scenes.includes(el));
  const rootBefore = others.filter((el) => elements.indexOf(el) < firstSceneIndex).map(clone);
  const rootAfter = others.filter((el) => elements.indexOf(el) > firstSceneIndex).map(clone);
  const rootProps = clone(root.props);
  for (const key of ["elements", "duration", "output_format", "width", "height", "dynamic"]) delete rootProps[key];
  sanitizeNode(rootProps);

  const sceneSeconds = scenes.map((scene) => toSeconds(scene.duration));
  const templateSeconds = sceneSeconds.every((value) => value !== null) ? sceneSeconds.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const width = toSeconds(root.props.width);
  const height = toSeconds(root.props.height);
  return {
    layout: {
      width: width !== null && width > 0 ? width : null,
      height: height !== null && height > 0 ? height : null,
      rootProps,
      rootBefore,
      rootAfter,
      scenes: scenes.map(clone),
      templateSeconds,
      staticTextSeries: detectStaticTextSeries(scenes),
    },
  };
}

/** Template scene slots a fixed-slot (modification) render has: 0 when the template has no repeatable Scene structure. */
export const countTemplateSceneSlots = (rawTemplate: unknown): number => extractTemplateSceneLayout(rawTemplate).layout?.scenes.length ?? 0;

/** Template resolution in pixels (root `width`/`height`), null when the template does not state it. */
export function templateResolution(rawTemplate: unknown): { width: number; height: number } | null {
  if (!isNode(rawTemplate)) return null;
  const width = toSeconds(rawTemplate.width);
  const height = toSeconds(rawTemplate.height);
  return width && height ? { width, height } : null;
}

/** Real voice-timed caption blocks for a scene (VE2E-32); one static block for the whole scene when none are usable. */
function captionBlocks(scene: DynamicSceneInput, durationSeconds: number): Array<{ text: string; time: number; duration: number }> {
  const usable = (scene.captionSegments ?? []).filter((s) => s.text.trim() && s.endMs > s.startMs);
  if (usable.length === 0) return [{ text: scene.text, time: 0, duration: durationSeconds }];
  return usable.map((segment) => {
    const start = Math.min(durationSeconds, Math.max(0, segment.startMs / 1000));
    const end = Math.min(durationSeconds, Math.max(start + 0.05, segment.endMs / 1000));
    return { text: segment.text, time: start, duration: end - start };
  });
}

const sceneSeconds = (scene: DynamicSceneInput): number => Math.max(0.1, scene.audioDurationMs / 1000);

/** `Video-1` -> `Video-<n>`; a name without a trailing number gets `-<n>` appended so names stay unique per scene. */
const renameForScene = (name: string, n: number, fallback: string): string => {
  if (!name) return `${fallback}-${n}`;
  return /\d+$/.test(name) ? name.replace(/\d+$/, String(n)) : `${name}-${n}`;
};

/** Sets time/duration of a decorative child relative to the new scene length: a full-length child stays full-length, a shorter one keeps its own length (capped). */
function fitChildTiming(child: RawNode, protoSceneSeconds: number | null, durationSeconds: number): void {
  const time = toSeconds(child.time) ?? 0;
  const original = toSeconds(child.duration);
  if (time >= durationSeconds) {
    child.time = 0;
  }
  if (original === null) return;
  const start = toSeconds(child.time) ?? 0;
  const remaining = Math.max(0.1, durationSeconds - start);
  const fullLength = protoSceneSeconds === null || original >= protoSceneSeconds * 0.9;
  child.duration = fullLength ? remaining : Math.min(original, remaining);
}

export type DynamicCompositionResult = { source: Record<string, unknown>; warnings: TemplateScaleWarning[] };

/**
 * VE2E-52 template-driven scalable composition. Emits exactly `scenes.length` Scene compositions,
 * scene i cloned from the template's prototype `layout.scenes[i % S]` (layout, fonts, stroke,
 * animations, transition, decorative elements all inherited), with names Scene-i/Video-i/Subtitles-i/
 * Voiceover-i. Audio drives duration. Root-level extras (badge/logo) and root properties are kept.
 */
function buildTemplateScaledComposition(
  scenes: DynamicSceneInput[],
  style: DynamicSceneStyle,
  layout: TemplateSceneLayout,
  options: { width: number; height: number; outputFormat?: "mp4" | "mov" | "gif" | undefined },
): DynamicCompositionResult {
  const warnings = new Set<TemplateScaleWarning>();
  const overrides = style.layoutOverrides ?? {};
  const canvas = { width: layout.width ?? options.width, height: layout.height ?? options.height };
  const total = scenes.length;
  const sceneTrack = toSeconds(layout.scenes[0]!.track) ?? 1;
  let cursor = 0;

  const sceneNodes = scenes.map((scene, index) => {
    const n = index + 1;
    const protoScene = layout.scenes[index % layout.scenes.length]!;
    const durationSeconds = sceneSeconds(scene);
    const protoSeconds = toSeconds(protoScene.duration);
    const time = cursor;
    cursor += durationSeconds;
    const { kids, media, caption, voice } = classifySceneChildren(protoScene);
    const children: RawNode[] = [];
    let usedTrackMax = 0;
    const noteTrack = (node: RawNode) => { usedTrackMax = Math.max(usedTrackMax, toSeconds(node.track) ?? 0); };

    kids.forEach((rawKid, kidIndex) => {
      const kid = clone(rawKid);
      sanitizeNode(kid);
      if (kidIndex === media) {
        kid.type = scene.mediaKind;
        kid.name = renameForScene(nameOf(rawKid), n, scene.mediaKind === "video" ? "Video" : "Image");
        kid.source = scene.mediaUrl;
        kid.time = 0;
        kid.duration = durationSeconds;
        delete kid.trim_start;
        delete kid.trim_duration;
        if (scene.mediaKind === "video") {
          kid.volume = "0%";
          if (scene.sourceStartMs != null && scene.sourceDurationMs != null) {
            kid.trim_start = scene.sourceStartMs / 1000;
            kid.trim_duration = scene.sourceDurationMs / 1000;
          }
        } else {
          delete kid.volume;
        }
        if (kid.fit === undefined) kid.fit = "cover";
        if (overrides.disablePan && Array.isArray(kid.animations)) {
          const kept = (kid.animations as RawNode[]).filter((animation) => !looksLikePanZoomAnimation(animation));
          if (kept.length) kid.animations = kept; else delete kid.animations;
        }
        children.push(kid);
      } else if (kidIndex === caption) {
        // V03-03: at most 2 lines on screen - pages sized to THIS element's own font size and box width (VE2E-93: or the style's).
        const patch = scenePatch(style, scene);
        if (asksForHighlight(patch)) warnings.add("caption_highlight_unsupported");
        const box = { fontSize: captionFontSize(patch, asString(kid.font_size) ?? style.text.fontSize), width: asString(kid.width) ?? style.text.width, maxLines: captionMaxLines(patch) };
        paginateCaptionBlocks(captionBlocks(scene, durationSeconds), box, canvas).forEach((block, blockIndex) => {
          if (!block.text.trim()) return;
          const node = clone(kid);
          const base = renameForScene(nameOf(rawKid), n, "Subtitles");
          node.name = blockIndex === 0 ? base : `${base}-${blockIndex + 1}`;
          node.text = block.text;
          node.time = block.time;
          node.duration = block.duration;
          if (overrides.captionFontFamily) node.font_family = overrides.captionFontFamily;
          if (overrides.captionFillColor) node.fill_color = overrides.captionFillColor;
          applyCaptionPatch(node, patch);
          children.push(node);
        });
      } else if (kidIndex === voice) {
        kid.name = renameForScene(nameOf(rawKid), n, "Voiceover");
        kid.source = scene.audioUrl;
        kid.time = 0;
        kid.duration = durationSeconds;
        children.push(kid);
      } else if (typeOf(kid) === "audio") {
        // A second audio element: keep fixed background audio, never one that would call a TTS provider (sanitize removed `provider`, so use the raw flag).
        if (typeof rawKid.provider === "string" && rawKid.provider.trim()) return;
        kid.name = renameForScene(nameOf(rawKid), n, "Audio");
        fitChildTiming(kid, protoSeconds, durationSeconds);
        children.push(kid);
      } else {
        if (typeOf(kid) === "text" && typeof kid.text === "string") {
          const key = staticKey(nameOf(rawKid), kidIndex);
          const direction = layout.staticTextSeries[key];
          if (direction === "desc" || direction === "asc") {
            if (/\d+/.test(kid.text)) {
              kid.text = kid.text.replace(/\d+/, String(direction === "desc" ? total - index : index + 1));
              warnings.add("rank_badges_renumbered");
            }
          } else if (direction === "varying" && index >= layout.scenes.length) {
            warnings.add("static_text_not_scalable");
            return;
          }
        }
        kid.name = renameForScene(nameOf(rawKid), n, "Element");
        fitChildTiming(kid, protoSeconds, durationSeconds);
        children.push(kid);
      }
      noteTrack(kid);
    });

    // Never drop narration / media / captions because a prototype lacks the element for it.
    if (voice < 0) {
      children.push({ name: `Voiceover-${n}`, type: "audio", track: usedTrackMax + 1, time: 0, duration: durationSeconds, source: scene.audioUrl });
      usedTrackMax += 1;
    }
    if (media < 0) {
      children.unshift({ name: `Video-${n}`, type: scene.mediaKind, track: 1, time: 0, duration: durationSeconds, source: scene.mediaUrl, fit: "cover", ...(scene.mediaKind === "video" ? { volume: "0%" } : {}) });
    }
    if (caption < 0) {
      warnings.add("no_caption_element");
      const patch = scenePatch(style, scene);
      if (asksForHighlight(patch)) warnings.add("caption_highlight_unsupported");
      const box = { fontSize: captionFontSize(patch, style.text.fontSize), width: style.text.width, maxLines: captionMaxLines(patch) };
      paginateCaptionBlocks(captionBlocks(scene, durationSeconds), box, canvas).forEach((block, blockIndex) => {
        if (!block.text.trim()) return;
        const node: RawNode = {
          name: blockIndex === 0 ? `Subtitles-${n}` : `Subtitles-${n}-${blockIndex + 1}`, type: "text", track: usedTrackMax + 1, time: block.time, duration: block.duration, text: block.text,
          font_family: overrides.captionFontFamily ?? style.text.fontFamily, font_size: style.text.fontSize, font_weight: style.text.fontWeight,
          fill_color: overrides.captionFillColor ?? style.text.fillColor, stroke_color: style.text.strokeColor, stroke_width: style.text.strokeWidth,
          x_alignment: style.text.xAlignment, y_alignment: style.text.yAlignment, width: style.text.width, height: style.text.height,
        };
        applyCaptionPatch(node, patch);
        children.push(node);
      });
    }

    const node = clone(protoScene);
    sanitizeNode(node);
    delete node.dynamic;
    return {
      ...node,
      name: `Scene-${n}`,
      type: "composition",
      track: sceneTrack,
      time,
      duration: durationSeconds,
      elements: children,
    };
  });

  const extras = (list: RawNode[]) =>
    list.map((el) => {
      const copy = clone(el);
      sanitizeNode(copy);
      const original = toSeconds(el.duration);
      // A root extra that spanned the template's whole timeline must span the (re-sized) whole timeline too.
      if (original !== null && layout.templateSeconds !== null && original >= layout.templateSeconds * 0.9) delete copy.duration;
      return copy;
    });

  return {
    source: {
      ...layout.rootProps,
      output_format: options.outputFormat ?? "mp4",
      width: layout.width ?? options.width,
      height: layout.height ?? options.height,
      elements: [...extras(layout.rootBefore), ...sceneNodes, ...extras(layout.rootAfter)],
    },
    warnings: [...warnings],
  };
}

/**
 * Single entry point for every Creatomate composition LyOnix generates from a timeline (Auto,
 * Studio final render, Studio preview): template-scaled when the pinned template has a repeatable
 * Scene structure, the generic style-only composition otherwise (with `template_layout_fallback`).
 */
export function buildDynamicCompositionWithWarnings(
  scenes: DynamicSceneInput[],
  style: DynamicSceneStyle,
  options: { width: number; height: number; outputFormat?: "mp4" | "mov" | "gif" | undefined },
): DynamicCompositionResult {
  if (style.layout) return buildTemplateScaledComposition(scenes, style, style.layout, options);
  const warnings: TemplateScaleWarning[] = style.layoutFallbackReason ? ["template_layout_fallback"] : [];
  if (scenes.some((scene) => asksForHighlight(scenePatch(style, scene)))) warnings.push("caption_highlight_unsupported");
  return { source: buildStyleOnlyComposition(scenes, style, options), warnings };
}

export function buildDynamicComposition(
  scenes: DynamicSceneInput[],
  style: DynamicSceneStyle,
  options: { width: number; height: number; outputFormat?: "mp4" | "mov" | "gif" | undefined },
): Record<string, unknown> {
  return buildDynamicCompositionWithWarnings(scenes, style, options).source;
}

/**
 * Builds the full Creatomate `source` document: one top-level "composition" per scene,
 * stacked back to back on the same track via an explicitly computed cumulative `time` (never
 * relying on Creatomate's own implicit same-track auto-sequencing), each sized to exactly its
 * own scene's real narration audio duration. A scene with `audioDurationMs <= 0` is the
 * caller's responsibility to have already excluded — this function assumes every input scene
 * is renderable.
 */
function buildStyleOnlyComposition(
  scenes: DynamicSceneInput[],
  style: DynamicSceneStyle,
  options: { width: number; height: number; outputFormat?: "mp4" | "mov" | "gif" | undefined },
): Record<string, unknown> {
  let cursorSeconds = 0;
  const elements = scenes.map((scene, index) => {
    const durationSeconds = Math.max(0.1, scene.audioDurationMs / 1000);
    const time = cursorSeconds;
    cursorSeconds += durationSeconds;

    const visual: RawNode = {
      type: scene.mediaKind,
      track: 1,
      time: 0,
      duration: durationSeconds,
      source: scene.mediaUrl,
      fit: "cover",
      ...(scene.mediaKind === "video" && scene.sourceStartMs != null && scene.sourceDurationMs != null
        ? { trim_start: scene.sourceStartMs / 1000, trim_duration: scene.sourceDurationMs / 1000 }
        : {}),
      ...(style.image.colorOverlay ? { color_overlay: style.image.colorOverlay } : {}),
      ...(style.image.animation
        ? {
            animations: [
              {
                type: style.image.animation.type,
                scope: "element",
                track: 0,
                easing: style.image.animation.easing,
                start_x: style.image.animation.startX,
                end_x: style.image.animation.endX,
                start_scale: style.image.animation.startScale,
                end_scale: style.image.animation.endScale,
              },
            ],
          }
        : {}),
    };

    const patch = scenePatch(style, scene);
    const captionNode = (text: string, nodeTime: number, nodeDuration: number): RawNode => {
      const node: RawNode = {
      type: "text",
      track: 2,
      time: nodeTime,
      duration: nodeDuration,
      text,
      font_family: style.text.fontFamily,
      font_size: style.text.fontSize,
      font_weight: style.text.fontWeight,
      fill_color: style.text.fillColor,
      stroke_color: style.text.strokeColor,
      stroke_width: style.text.strokeWidth,
      x_alignment: style.text.xAlignment,
      y_alignment: style.text.yAlignment,
      width: style.text.width,
      height: style.text.height,
      ...(style.text.backgroundColor ? { background_color: style.text.backgroundColor } : {}),
      ...(style.text.backgroundXPadding ? { background_x_padding: style.text.backgroundXPadding } : {}),
      ...(style.text.backgroundYPadding ? { background_y_padding: style.text.backgroundYPadding } : {}),
      ...(style.text.backgroundBorderRadius ? { background_border_radius: style.text.backgroundBorderRadius } : {}),
      };
      applyCaptionPatch(node, patch);
      return node;
    };

    // VE2E-32: real voice-timed segments (when given) become one text node each, clamped inside
    // this scene's own real audio duration (defends only against float/drift edge cases - both
    // come from the same underlying narration synthesis, so they should already agree); a scene
    // with no usable segments keeps the prior single-static-block behavior unchanged.
    // V03-03: every block is then split into pages of at most 2 lines (never 3-4 lines on screen at once).
    const box = { fontSize: captionFontSize(patch, style.text.fontSize), width: style.text.width, maxLines: captionMaxLines(patch) };
    const captions: RawNode[] = paginateCaptionBlocks(captionBlocks(scene, durationSeconds), box, { width: options.width, height: options.height })
      .map((block) => captionNode(block.text, block.time, block.duration));

    const audio: RawNode = {
      type: "audio",
      track: 3,
      time: 0,
      duration: durationSeconds,
      source: scene.audioUrl,
    };

    return {
      name: `Scene-${index + 1}`,
      type: "composition",
      track: 1,
      time,
      duration: durationSeconds,
      elements: [visual, ...captions, audio],
    };
  });

  return {
    output_format: options.outputFormat ?? "mp4",
    width: options.width,
    height: options.height,
    elements,
  };
}

// --- VE2E-26: schema-backed, server-validated Studio overrides on top of the template-derived style ---

const IMAGE_ANIMATION_OPTION_VALUES = new Set(["pan", "none"]);

/**
 * Fixed, whitelisted set of dynamic-composition style fields Studio may explicitly
 * override on top of the pinned template's own derived style (`extractDynamicStyleFromTemplate`)
 * — never a free-form modification string, matching the same server-owned-mapping principle
 * `render-jobs.service.ts` already enforces for template-slot modifications. Persisted in the
 * same `TimelineVersion.optionValues` JSON bag the legacy template-slot path already uses
 * (see `timeline-versions.service.ts`), under a `dynamicStyle.` prefix that can never collide
 * with a real Creatomate modification key (those always look like `<ElementName>.<property>`,
 * never literally start with `dynamicStyle`) — so the override inherits that same
 * version/`supersedesId` audit trail for free, no new persistence needed.
 *
 * VE2E-93: the caption keys (`dynamicStyle.caption*`, incl. the two below) are owned by `@lyonix/domain/caption-style`; this map keeps
 * the original three names for existing callers.
 */
export const DYNAMIC_STYLE_OPTION_KEYS = {
  captionFontFamily: "dynamicStyle.captionFontFamily",
  captionFillColor: "dynamicStyle.captionFillColor",
  imageAnimation: "dynamicStyle.imageAnimation",
} as const;

export function isDynamicStyleOptionKey(key: string): boolean {
  return key === DYNAMIC_STYLE_OPTION_KEYS.imageAnimation || isCaptionStyleOptionKey(key);
}

/**
 * Server-side validation for one dynamic-style override value — the same rule both save-time
 * (`TimelineVersionsService`) and apply-time (`applyDynamicStyleOverrides`) trust, so an
 * invalid value can never be persisted in the first place. An empty string is always valid
 * for any of these keys — it is Studio's explicit "use the template's own default" choice
 * (see the Inspector's "use template default" option), not a malformed value; `applyDynamicStyleOverrides`
 * already treats it as absent. The VE2E-26 font/fill rules are unchanged (domain `isValidCaptionStyleOptionValue`).
 */
export function isValidDynamicStyleOptionValue(key: string, value: string): boolean {
  if (key === DYNAMIC_STYLE_OPTION_KEYS.imageAnimation) return value === "" || IMAGE_ANIMATION_OPTION_VALUES.has(value);
  return isCaptionStyleOptionKey(key) && isValidCaptionStyleOptionValue(key, value);
}

/**
 * Applies whitelisted Studio overrides on top of a template-derived base style. Any field the
 * user did not explicitly (and validly) override keeps the template's own default — spec:
 * "Preserve template defaults for any field the user doesn't explicitly override". An
 * already-invalid stored value (should not happen given save-time validation, but defense in
 * depth) is treated the same as absent rather than applied.
 *
 * VE2E-93: the other caption style keys become `captionStyle`, written onto every caption element (a scene's own `captionStyle` on
 * top); the fill colour keeps the VE2E-26 path so a stored colour behaves exactly as before.
 */
export function applyDynamicStyleOverrides(base: DynamicSceneStyle, optionValues: Record<string, string>): DynamicSceneStyle {
  const fontFamily = optionValues[DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily];
  const fillColor = optionValues[DYNAMIC_STYLE_OPTION_KEYS.captionFillColor];
  const imageAnimation = optionValues[DYNAMIC_STYLE_OPTION_KEYS.imageAnimation];
  const validFont = Boolean(fontFamily) && isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily, fontFamily!);
  const validFill = Boolean(fillColor) && isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFillColor, fillColor!);
  const layoutOverrides: NonNullable<DynamicSceneStyle["layoutOverrides"]> = {
    ...(validFont ? { captionFontFamily: fontFamily! } : {}),
    ...(validFill ? { captionFillColor: fillColor! } : {}),
    ...(imageAnimation === "none" ? { disablePan: true } : {}),
  };
  const { fillColor: _fill, ...captionStyle } = captionStyleFromOptionValues(optionValues).patch;
  return {
    ...(base.layout ? { layout: base.layout } : {}),
    ...(base.layoutFallbackReason ? { layoutFallbackReason: base.layoutFallbackReason } : {}),
    ...(Object.keys(layoutOverrides).length ? { layoutOverrides } : {}),
    ...(Object.keys(captionStyle).length ? { captionStyle } : {}),
    text: {
      ...base.text,
      ...(validFont ? { fontFamily: fontFamily! } : {}),
      ...(validFill ? { fillColor: fillColor! } : {}),
    },
    image: {
      ...base.image,
      ...(imageAnimation === "none" ? { animation: undefined } : {}),
    },
  };
}

// --- VE2E-93: the template's own caption style, in canonical units (Studio panel + preview) ----------------------------

const parsePercent = (value: string | undefined): number | null => {
  const match = value?.trim().match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  return match ? Number(match[1]) : null;
};

/**
 * Caption defaults of a Creatomate template for Studio: the same caption element `extractDynamicStyleFromTemplate` lifts its style from,
 * converted to pixels on the 1080-wide reference canvas. Approximate where Creatomate has no equivalent (colours that are not plain hex
 * fall back to white/black; the vertical position is the element's centre line) - the Creatomate Preview SDK stays the exact view.
 */
export function captionDefaultsFromCreatomateTemplate(rawTemplate: unknown): CaptionTemplateDefaults {
  const style = extractDynamicStyleFromTemplate(rawTemplate);
  const canvas = templateResolution(rawTemplate) ?? { width: 1080, height: 1920 };
  const scale = 1080 / Math.min(canvas.width, canvas.height);
  const px = (value: string | undefined): number | null => {
    const measured = creatomateLengthPx(value, canvas, null);
    return measured === null ? null : measured * scale;
  };
  const fontSizePx = Math.round(px(style.text.fontSize) ?? 86);
  // A template-scaled render clones the caption element as it is (an absent property = Creatomate's default, e.g. no stroke, no y);
  // the style-only render draws a new element from the lifted style (no y = the composition's centre).
  const node = style.layout ? findTemplateCaptionNode(rawTemplate) : undefined;
  const strokeOutside = Math.round((px(style.layout ? asString(node?.stroke_width) : style.text.strokeWidth) ?? 0) / 2);
  const centre = parsePercent(asString(node?.y)) ?? 50;
  const alignment = parsePercent(style.layout ? asString(node?.y_alignment) : style.text.yAlignment);
  const height = parsePercent(style.layout ? asString(node?.height) : style.text.height);
  const centreLine = alignment !== null && height !== null ? centre + ((alignment - 50) / 100) * height : centre;
  return {
    fontFamily: style.text.fontFamily,
    fontSizePx,
    minFontSizePx: fontSizePx,
    bold: Number(style.text.fontWeight) >= 600,
    fillColor: normalizeHexColor(style.text.fillColor) ?? "#FFFFFF",
    highlightColor: null,
    stroke: { enabled: strokeOutside > 0, color: normalizeHexColor(style.text.strokeColor) ?? "#000000", widthPx: strokeOutside > 0 ? strokeOutside : DEFAULT_CAPTION_STROKE_WIDTH_PX },
    position: { anchor: "center", percent: Math.min(100, Math.max(0, Math.round(centreLine * 10) / 10)) },
    maxLines: MAX_CAPTION_LINES,
    animation: "none",
    colorCycle: null,
  };
}
