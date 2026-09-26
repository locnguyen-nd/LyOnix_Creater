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
 */

export type DynamicSceneInput = {
  sceneId: string;
  mediaUrl: string;
  mediaKind: "image" | "video";
  text: string;
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
 * Best-effort style lift from a pinned template's raw element tree: the first `text`
 * element found supplies caption styling, the first `image`/`video` element found supplies
 * the background pan/zoom + overlay. Falls back to `DEFAULT_DYNAMIC_SCENE_STYLE` for
 * whichever half is missing (or when no template was pinned at all).
 */
export function extractDynamicStyleFromTemplate(rawTemplate: unknown): DynamicSceneStyle {
  let text = { ...DEFAULT_DYNAMIC_SCENE_STYLE.text };
  let image = { ...DEFAULT_DYNAMIC_SCENE_STYLE.image };
  let foundText = false;
  let foundImage = false;

  const walk = (node: unknown) => {
    if (foundText && foundImage) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const el = node as RawNode;
    const type = typeof el.type === "string" ? el.type.toLowerCase() : "";

    if (!foundText && type === "text") {
      foundText = true;
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

    if (!foundImage && (type === "image" || type === "video")) {
      foundImage = true;
      const animations = Array.isArray(el.animations) ? (el.animations as RawNode[]) : [];
      const pan = animations.find((a) => asString(a.type));
      image = {
        colorOverlay: asString(el.color_overlay) ?? image.colorOverlay,
        animation: pan
          ? {
              type: asString(pan.type)!,
              startScale: asString(pan.start_scale) ?? DEFAULT_DYNAMIC_SCENE_STYLE.image.animation!.startScale,
              endScale: asString(pan.end_scale) ?? DEFAULT_DYNAMIC_SCENE_STYLE.image.animation!.endScale,
              startX: asString(pan.start_x) ?? DEFAULT_DYNAMIC_SCENE_STYLE.image.animation!.startX,
              endX: asString(pan.end_x) ?? DEFAULT_DYNAMIC_SCENE_STYLE.image.animation!.endX,
              easing: asString(pan.easing) ?? DEFAULT_DYNAMIC_SCENE_STYLE.image.animation!.easing,
            }
          : image.animation,
      };
    }

    for (const value of Object.values(el)) walk(value);
  };
  walk(rawTemplate);
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

    const caption: RawNode = {
      type: "text",
      track: 2,
      time: 0,
      duration: durationSeconds,
      text: scene.text,
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
      elements: [visual, caption, audio],
    };
  });

  return {
    output_format: options.outputFormat ?? "mp4",
    width: options.width,
    height: options.height,
    elements,
  };
}
