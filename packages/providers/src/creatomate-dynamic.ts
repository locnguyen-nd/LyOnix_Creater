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
 */

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
export function extractDynamicStyleFromTemplate(rawTemplate: unknown): DynamicSceneStyle {
  let text = { ...DEFAULT_DYNAMIC_SCENE_STYLE.text };
  let image = { ...DEFAULT_DYNAMIC_SCENE_STYLE.image };
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

  return { text, image };
}

/**
 * Builds the full Creatomate `source` document: one top-level "composition" per scene,
 * stacked back to back on the same track via an explicitly computed cumulative `time` (never
 * relying on Creatomate's own implicit same-track auto-sequencing), each sized to exactly its
 * own scene's real narration audio duration. A scene with `audioDurationMs <= 0` is the
 * caller's responsibility to have already excluded — this function assumes every input scene
 * is renderable.
 */
export function buildDynamicComposition(
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

    const captionNode = (text: string, nodeTime: number, nodeDuration: number): RawNode => ({
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
    });

    // VE2E-32: real voice-timed segments (when given) become one text node each, clamped inside
    // this scene's own real audio duration (defends only against float/drift edge cases - both
    // come from the same underlying narration synthesis, so they should already agree); a scene
    // with no usable segments keeps the prior single-static-block behavior unchanged.
    const usableSegments = (scene.captionSegments ?? []).filter((s) => s.text.trim() && s.endMs > s.startMs);
    const captions: RawNode[] = usableSegments.length
      ? usableSegments.map((segment) => {
          const segStart = Math.min(durationSeconds, Math.max(0, segment.startMs / 1000));
          const segEnd = Math.min(durationSeconds, Math.max(segStart + 0.05, segment.endMs / 1000));
          return captionNode(segment.text, segStart, segEnd - segStart);
        })
      : [captionNode(scene.text, 0, durationSeconds)];

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

const OVERRIDE_FONT_RE = /^[A-Za-z0-9 _-]+$/;
const OVERRIDE_MAX_FONT_LENGTH = 60;
const OVERRIDE_HEX_COLOR_RE = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/;
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
 */
export const DYNAMIC_STYLE_OPTION_KEYS = {
  captionFontFamily: "dynamicStyle.captionFontFamily",
  captionFillColor: "dynamicStyle.captionFillColor",
  imageAnimation: "dynamicStyle.imageAnimation",
} as const;

const DYNAMIC_STYLE_OPTION_KEY_SET: ReadonlySet<string> = new Set(Object.values(DYNAMIC_STYLE_OPTION_KEYS));

export function isDynamicStyleOptionKey(key: string): boolean {
  return DYNAMIC_STYLE_OPTION_KEY_SET.has(key);
}

/**
 * Server-side validation for one dynamic-style override value — the same rule both save-time
 * (`TimelineVersionsService`) and apply-time (`applyDynamicStyleOverrides`) trust, so an
 * invalid value can never be persisted in the first place. An empty string is always valid
 * for any of these keys — it is Studio's explicit "use the template's own default" choice
 * (see the Inspector's "use template default" option), not a malformed value; `applyDynamicStyleOverrides`
 * already treats it as absent.
 */
export function isValidDynamicStyleOptionValue(key: string, value: string): boolean {
  if (value === "") return isDynamicStyleOptionKey(key);
  if (key === DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily) return value.trim().length > 0 && value.length <= OVERRIDE_MAX_FONT_LENGTH && OVERRIDE_FONT_RE.test(value);
  if (key === DYNAMIC_STYLE_OPTION_KEYS.captionFillColor) return OVERRIDE_HEX_COLOR_RE.test(value);
  if (key === DYNAMIC_STYLE_OPTION_KEYS.imageAnimation) return IMAGE_ANIMATION_OPTION_VALUES.has(value);
  return false;
}

/**
 * Applies whitelisted Studio overrides on top of a template-derived base style. Any field the
 * user did not explicitly (and validly) override keeps the template's own default — spec:
 * "Preserve template defaults for any field the user doesn't explicitly override". An
 * already-invalid stored value (should not happen given save-time validation, but defense in
 * depth) is treated the same as absent rather than applied.
 */
export function applyDynamicStyleOverrides(base: DynamicSceneStyle, optionValues: Record<string, string>): DynamicSceneStyle {
  const fontFamily = optionValues[DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily];
  const fillColor = optionValues[DYNAMIC_STYLE_OPTION_KEYS.captionFillColor];
  const imageAnimation = optionValues[DYNAMIC_STYLE_OPTION_KEYS.imageAnimation];
  return {
    text: {
      ...base.text,
      ...(fontFamily && isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily, fontFamily) ? { fontFamily } : {}),
      ...(fillColor && isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFillColor, fillColor) ? { fillColor } : {}),
    },
    image: {
      ...base.image,
      ...(imageAnimation === "none" ? { animation: undefined } : {}),
    },
  };
}
