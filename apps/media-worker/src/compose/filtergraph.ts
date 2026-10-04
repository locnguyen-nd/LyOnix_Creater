import type { ComposePlan, ComposeScene } from "@lyonix/media-jobs";
import type { RenderRecipe, RecipeBoxLayer } from "@lyonix/render-recipes";

/**
 * VE2E-105: pure builders for the video filtergraph of one render. No I/O, no process: the processor writes the graph to a file and
 * runs FFmpeg; this module only decides the graph, so timing/transition maths is unit-testable without FFmpeg.
 *
 * Timeline model (frames @ 60 fps, frame numbers are the source of truth):
 * - scene i is "visible" from V_i to E_i: the first scene starts at frame 0 (it also covers the head pad), every other scene starts at its
 *   own `startFrame`; a scene that is followed by a transition is extended by that transition (+1 frame of slack) so the next scene can fade
 *   in over it, the last scene is extended to `totalFrames` (tail pad);
 * - the transition into scene i+1 starts exactly at scene i+1's `startFrame` (the new picture appears as its voice starts), so the encoded
 *   length is exactly `totalFrames` and no scene drifts, whatever the number of scenes;
 * - a "cut" (no transition) joins clips with `concat`, a transition with `xfade`.
 */

export const FPS = 60;
export const AUDIO_SAMPLE_RATE = 48_000;
/** Samples per video frame at 48 kHz / 60 fps - an integer, so audio and video stay sample-exact. */
export const SAMPLES_PER_FRAME = AUDIO_SAMPLE_RATE / FPS;
export const MAX_SCENE_ZOOM = 0.2;

const XFADE_NAME = { fade: "fade", wipe: "wipeleft", slide: "slideleft", circle: "circleopen" } as const;

/** Seconds for a frame count, rounded DOWN to the microsecond: FFmpeg compares timestamps in microseconds, rounding up would start a transition one frame late. */
export const framesToSeconds = (frames: number): string => (Math.floor((frames * 1_000_000) / FPS) / 1_000_000).toFixed(6);

export type SceneTimeline = {
  index: number;
  /** First visible frame / one past the last visible frame of the clip, and its length. */
  visibleFrom: number;
  visibleTo: number;
  clipFrames: number;
  /** Transition INTO this scene (0 frames = cut). */
  transition: { kind: keyof typeof XFADE_NAME | "none"; frames: number };
};

const hexToFfmpeg = (hex: string): string => `0x${hex.replace("#", "").toUpperCase()}`;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Computes visible ranges and effective transitions. Pure; exported for tests. */
export function planSceneTimeline(plan: ComposePlan): SceneTimeline[] {
  const scenes = plan.scenes;
  const transitions = scenes.map((scene, index) => {
    if (index === 0 || scene.transitionIn.kind === "none") return { kind: "none" as const, frames: 0 };
    const wanted = Math.round((scene.transitionIn.durationMs * FPS) / 1000);
    // never longer than half of either neighbouring scene, so a transition can never swallow a scene
    const cap = Math.floor(Math.min(scenes[index - 1]!.durationFrames, scene.durationFrames) / 2);
    const frames = Math.max(0, Math.min(wanted, cap));
    return frames > 0 ? { kind: scene.transitionIn.kind as keyof typeof XFADE_NAME, frames } : { kind: "none" as const, frames: 0 };
  });
  return scenes.map((scene, index) => {
    const isLast = index === scenes.length - 1;
    const next = isLast ? null : transitions[index + 1]!;
    const visibleFrom = index === 0 ? 0 : scene.startFrame;
    const visibleTo = isLast ? plan.totalFrames : scenes[index + 1]!.startFrame + next!.frames + (next!.frames > 0 ? 1 : 0);
    return { index, visibleFrom, visibleTo, clipFrames: visibleTo - visibleFrom, transition: transitions[index]! };
  });
}

export type VideoGraphOverlays = {
  /** layer id -> ASS file name (relative to the FFmpeg working directory) for each visible text layer. */
  layerAss: Record<string, string>;
  captionsAss: string | null;
};

export type VideoGraphInput = {
  plan: ComposePlan;
  recipe: RenderRecipe;
  /** Effective slot values (timeline value > slot default). */
  params: Record<string, string>;
  /** Absolute path of each scene's media, same order as `plan.scenes`. */
  mediaPaths: string[];
  overlays: VideoGraphOverlays;
  /** Absolute fonts directory for libass, or null. */
  fontsDir: string | null;
};

export type VideoGraph = {
  /** Input options + `-i` for every scene, in scene order. */
  inputArgs: string[];
  filterComplex: string;
  timeline: SceneTimeline[];
  warnings: string[];
};

/** Escapes a value placed inside single quotes in a filtergraph (`'` cannot be represented: such a path is rejected earlier). */
export const quoteFilterPath = (path: string): string => `'${path.replaceAll("\\", "/").replaceAll(":", "\\:")}'`;

export const motionFor = (kind: "image" | "video", index: number, recipe: RenderRecipe, params: Record<string, string>): { direction: "in" | "out"; intensity: number } | null => {
  const config = kind === "image" ? recipe.background.image : recipe.background.video;
  if (config.motion === "none" || config.intensity <= 0) return null;
  if (kind === "image" && params["dynamicStyle.imageAnimation"] === "none") return null;
  let direction: "in" | "out" = config.motion === "zoom_in" ? "in" : "out";
  if (kind === "image" && recipe.background.image.alternate && index % 2 === 1) direction = direction === "in" ? "out" : "in";
  return { direction, intensity: Math.min(config.intensity, MAX_SCENE_ZOOM) };
};

const sceneChain = (scene: ComposeScene, timeline: SceneTimeline, input: number, recipe: RenderRecipe, params: Record<string, string>): string => {
  const length = timeline.clipFrames;
  const seconds = length / FPS;
  const steps: string[] = [`fps=${FPS}`];
  // a ranged (preview) video that is too short holds its last frame; an unranged one is looped at the input (`-stream_loop`), see buildVideoGraph
  const ranged = scene.media.sourceStartMs != null && scene.media.sourceDurationMs != null;
  if (scene.media.kind === "video" && ranged) steps.push(`tpad=stop_mode=clone:stop_duration=${framesToSeconds(length)}`);
  steps.push(`trim=end_frame=${length}`, "setpts=PTS-STARTPTS");
  // cover fit to the 9:16 canvas + BT.709 limited range (the output tags say so; untagged/BT.601/full-range sources are converted here)
  steps.push("scale=1080:1920:force_original_aspect_ratio=increase:flags=bicubic:out_color_matrix=bt709:out_range=tv", "crop=1080:1920", "setsar=1");
  const motion = motionFor(scene.media.kind, timeline.index, recipe, params);
  if (motion) {
    const progress = `t/${seconds.toFixed(6)}`;
    const zoom = motion.direction === "in" ? `1+${motion.intensity}*${progress}` : `1+${motion.intensity}*(1-${progress})`;
    steps.push(`scale=w='trunc(1080*(${zoom})/2)*2':h='trunc(1920*(${zoom})/2)*2':eval=frame:flags=bicubic`, "crop=1080:1920");
  }
  steps.push("format=yuv420p");
  return `[${input}:v]${steps.join(",")}[s${timeline.index}]`;
};

const resolveBoxColor = (layer: RecipeBoxLayer, recipe: RenderRecipe, params: Record<string, string>): string => {
  if (HEX_RE.test(layer.color)) return layer.color;
  const key = layer.color.replace(/^slot:/, "");
  const value = params[key] ?? "";
  if (HEX_RE.test(value)) return value;
  const fallback = recipe.slots.find((slot) => slot.key === key)?.default ?? "";
  return HEX_RE.test(fallback) ? fallback : "#000000";
};

export function buildVideoGraph(input: VideoGraphInput): VideoGraph {
  const { plan, recipe, params } = input;
  const warnings: string[] = [];
  const timeline = planSceneTimeline(plan);
  const inputArgs: string[] = [];
  const parts: string[] = [];

  plan.scenes.forEach((scene, index) => {
    const tl = timeline[index]!;
    const path = input.mediaPaths[index]!;
    if (scene.media.kind === "image") {
      inputArgs.push("-loop", "1", "-framerate", String(FPS), "-t", ((tl.clipFrames + 6) / FPS).toFixed(3), "-i", path);
    } else if (scene.media.sourceStartMs != null && scene.media.sourceDurationMs != null) {
      inputArgs.push("-ss", (scene.media.sourceStartMs / 1000).toFixed(3), "-t", (scene.media.sourceDurationMs / 1000).toFixed(3), "-i", path);
    } else {
      // a source shorter than its scene loops (a frozen frame for >1 s is a QC defect); the trim in the chain ends the loop
      inputArgs.push("-stream_loop", "-1", "-i", path);
    }
    parts.push(sceneChain(scene, tl, index, recipe, params));
  });

  let acc = "s0";
  for (let i = 1; i < plan.scenes.length; i += 1) {
    const tl = timeline[i]!;
    const out = `x${i}`;
    if (tl.transition.frames > 0) {
      const name = XFADE_NAME[tl.transition.kind as keyof typeof XFADE_NAME];
      parts.push(`[${acc}][s${i}]xfade=transition=${name}:duration=${framesToSeconds(tl.transition.frames)}:offset=${framesToSeconds(plan.scenes[i]!.startFrame)}[${out}]`);
    } else {
      parts.push(`[${acc}][s${i}]concat=n=2:v=1:a=0[${out}]`);
    }
    acc = out;
  }

  const post: string[] = [];
  const tint = recipe.background.tint;
  if (tint && tint.opacity > 0) post.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${hexToFfmpeg(tint.color)}@${tint.opacity}:t=fill`);
  const fontsOption = input.fontsDir ? `:fontsdir=${quoteFilterPath(input.fontsDir)}` : "";
  for (const layer of recipe.layers) {
    if (layer.visibleIfSlot && !(params[layer.visibleIfSlot] ?? "").trim()) continue;
    if (layer.type === "box") {
      post.push(`drawbox=x=${layer.x}:y=${layer.y}:w=${layer.w}:h=${layer.h}:color=${hexToFfmpeg(resolveBoxColor(layer, recipe, params))}@${layer.opacity}:t=fill`);
    } else {
      const file = input.overlays.layerAss[layer.id];
      if (file) post.push(`ass=filename=${file}${fontsOption}`);
      else warnings.push(`text layer ${layer.id} has no overlay file and was skipped`);
    }
  }
  if (input.overlays.captionsAss) post.push(`ass=filename=${input.overlays.captionsAss}${fontsOption}`);
  post.push("format=yuv420p", "setsar=1");
  parts.push(`[${acc}]${post.join(",")}[v]`);

  return { inputArgs, filterComplex: parts.join(";\n"), timeline, warnings };
}

/** `-filter_complex_script` was deprecated in FFmpeg 7 in favour of `-/filter_complex`; a graph file keeps big plans off the command line. */
export function filterComplexFileArgs(path: string, ffmpegVersion: string): string[] {
  const match = /(?:version\s+n?|\bn)(\d+)\./i.exec(ffmpegVersion);
  const major = match ? Number(match[1]) : null;
  const modern = major === null ? /git|N-\d+/i.test(ffmpegVersion) : major >= 7;
  return modern ? ["-/filter_complex", path] : ["-filter_complex_script", path];
}
