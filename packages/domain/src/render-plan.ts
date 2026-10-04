/**
 * VE2E-102: RenderPlan - the engine-neutral intermediate representation of one video render.
 *
 * A approved `TimelineVersion` (+ its resolved media/audio/subtitle references) is turned into a
 * RenderPlan exactly once; the Render Router and every engine (internal FFmpeg `lyonix`, Creatomate,
 * Orshot) then read the same plan instead of each re-deriving scene timing from the database.
 *
 * Pure, no I/O, no framework, browser-safe (subpath `@lyonix/domain/render-plan`). References are
 * opaque ids (asset-version ids); resolving them to `MEDIA_ROOT`-relative paths or delivery URLs is
 * the caller's job (see `packages/media-jobs` compose contract).
 *
 * Timing is expressed in whole frames at the plan fps so a constant-frame-rate encode never drifts:
 * `startFrame`/`durationFrames` are the source of truth, `*Ms` fields are derived views. A scene's
 * length is its own voice length (voice drives duration - same rule as the Creatomate dynamic path),
 * so total duration = sum of voice durations + the template's head/tail padding (error <= 1 frame per
 * scene from rounding, well inside the 100 ms acceptance bound).
 */

export const RENDER_PLAN_VERSION = 1;
export const RENDER_PLAN_DEFAULT_FPS = 60;
export const RENDER_PLAN_DEFAULT_CANVAS = { width: 1080, height: 1920 } as const;
/** Hard bound on scenes in one plan - guards garbage input, not a product limit. */
export const RENDER_PLAN_MAX_SCENES = 200;

export type RenderPlanMediaKind = "image" | "video";

export type RenderPlanTransitionKind = "none" | "fade" | "wipe" | "slide" | "circle";

export type RenderPlanTransition = { kind: RenderPlanTransitionKind; durationMs: number };

/** Entrance/exit effect of a scene's visual. Anything not representable here is a provider-only template feature. */
export type RenderPlanSceneEffect = { kind: "none" | "zoom_in" | "zoom_out" | "pan"; intensity?: number };

/** Per-character timing (one entry per code point of the cue text), relative to the scene start - from the real TTS alignment. */
export type RenderPlanCharTiming = { startMs: number; endMs: number };

export type RenderPlanCaptionCue = {
  text: string;
  /** Relative to the scene start, clamped into [0, scene duration]. */
  startMs: number;
  endMs: number;
  /** Present only when the real alignment could be mapped onto this cue's text; caption-ass falls back to estimated timing otherwise. */
  charTimings?: RenderPlanCharTiming[];
};

export type RenderPlanMediaRef = {
  kind: RenderPlanMediaKind;
  mediaAssetVersionId: string;
  /** Source range (video only). Preview-only unless `prepared` is false and the engine trims itself. */
  sourceStartMs: number | null;
  sourceDurationMs: number | null;
  /** True when `mediaAssetVersionId` already points at a trimmed/reframed derivative (clip.prepare). */
  prepared: boolean;
};

export type RenderPlanScene = {
  sceneId: string;
  index: number;
  segmentId: string | null;
  startFrame: number;
  durationFrames: number;
  startMs: number;
  durationMs: number;
  media: RenderPlanMediaRef;
  voice: { audioAssetVersionId: string; durationMs: number };
  /** Text shown on screen for the scene (Studio override, else the script text). May be empty. */
  text: string;
  captionCues: RenderPlanCaptionCue[];
  effectIn: RenderPlanSceneEffect;
  effectOut: RenderPlanSceneEffect;
  transitionIn: RenderPlanTransition;
};

export type RenderPlanMusic = { audioAssetVersionId: string; volume: number };

export type RenderPlanTemplateRef = {
  templateSnapshotId: string | null;
  engine: string | null;
  recipeId: string | null;
  recipeVersion: number | null;
};

export type RenderPlan = {
  version: typeof RENDER_PLAN_VERSION;
  canvas: { width: number; height: number };
  fps: number;
  padStartFrames: number;
  padEndFrames: number;
  totalFrames: number;
  totalDurationMs: number;
  scenes: RenderPlanScene[];
  music: RenderPlanMusic | null;
  /** Template-level option values (secondary text/color/font/volume), copied verbatim from the timeline. */
  params: Record<string, string>;
  template: RenderPlanTemplateRef;
};

/** One timeline scene after the API resolved its bindings (shape mirrors `SceneBindingForMapping`, structurally). */
export type RenderPlanSceneInput = {
  sceneId: string;
  orderIndex: number;
  excluded?: boolean;
  segmentId?: string | null;
  mediaAssetVersionId?: string | null;
  mediaKind?: RenderPlanMediaKind | null;
  sourceStartMs?: number | null;
  sourceDurationMs?: number | null;
  /** True when the media id is a clip.prepare / reframe derivative. */
  mediaPrepared?: boolean;
  audioAssetVersionId?: string | null;
  audioDurationMs?: number | null;
  screenTextOverride?: string | null;
  fallbackScreenText?: string | null;
  /** Voice-timed caption segments (SubtitleVersion.segments), relative to the scene start. */
  captionSegments?: readonly { text: string; startMs: number; endMs: number; charTimings?: readonly RenderPlanCharTiming[] | undefined }[] | null;
  effectIn?: RenderPlanSceneEffect | undefined;
  effectOut?: RenderPlanSceneEffect | undefined;
  transitionIn?: RenderPlanTransition | undefined;
};

export type RenderPlanProfile = {
  canvas?: { width: number; height: number } | undefined;
  fps?: number | undefined;
  /** Silence/hold before the first and after the last scene (template-defined). */
  padStartMs?: number | undefined;
  padEndMs?: number | undefined;
  /** Default transition for scenes that do not carry their own. */
  defaultTransition?: RenderPlanTransition | undefined;
};

export type BuildRenderPlanInput = {
  scenes: readonly RenderPlanSceneInput[];
  optionValues?: Record<string, string> | null | undefined;
  template?: Partial<RenderPlanTemplateRef> | undefined;
  music?: RenderPlanMusic | null | undefined;
  profile?: RenderPlanProfile | undefined;
};

export type RenderPlanErrorCode = "NO_RENDERABLE_SCENES" | "TOO_MANY_SCENES" | "INVALID_PROFILE";

export type BuildRenderPlanResult = { ok: true; plan: RenderPlan; skippedSceneIds: string[] } | { ok: false; code: RenderPlanErrorCode; message: string };

const NO_EFFECT: RenderPlanSceneEffect = { kind: "none" };
const NO_TRANSITION: RenderPlanTransition = { kind: "none", durationMs: 0 };

export const msToFrames = (ms: number, fps: number): number => Math.round((ms * fps) / 1000);
export const framesToMs = (frames: number, fps: number): number => Math.round((frames * 1000) / fps);

const isPositiveFinite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function clampCue(cue: { text: string; startMs: number; endMs: number; charTimings?: readonly RenderPlanCharTiming[] | undefined }, durationMs: number): RenderPlanCaptionCue | null {
  if (typeof cue.text !== "string" || !cue.text.trim()) return null;
  if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)) return null;
  const clamp = (value: number) => Math.min(Math.max(0, value), durationMs);
  const startMs = clamp(cue.startMs);
  const endMs = clamp(cue.endMs);
  if (endMs <= startMs) return null;
  // Per-character timings are indexed by the untrimmed text, so the text is only trimmed when there are none (caption-ass normalizes whitespace itself).
  const timingsUsable = cue.charTimings && cue.charTimings.length === Array.from(cue.text).length && cue.charTimings.every((t) => Number.isFinite(t.startMs) && Number.isFinite(t.endMs));
  return {
    text: timingsUsable ? cue.text : cue.text.trim(),
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    ...(timingsUsable ? { charTimings: cue.charTimings!.map((t) => ({ startMs: Math.round(clamp(t.startMs)), endMs: Math.round(clamp(t.endMs)) })) } : {}),
  };
}

/**
 * A scene is renderable when it is not excluded and has media + voice with a positive duration.
 * Everything else is skipped (reported in `skippedSceneIds`) - same filter the Creatomate dynamic
 * path applies, so a plan never contains a scene the other engines would drop.
 */
const isRenderable = (scene: RenderPlanSceneInput): boolean =>
  !scene.excluded &&
  Boolean(scene.mediaAssetVersionId) &&
  (scene.mediaKind === "image" || scene.mediaKind === "video") &&
  Boolean(scene.audioAssetVersionId) &&
  isPositiveFinite(scene.audioDurationMs);

export function buildRenderPlan(input: BuildRenderPlanInput): BuildRenderPlanResult {
  const profile = input.profile ?? {};
  const fps = profile.fps ?? RENDER_PLAN_DEFAULT_FPS;
  const canvas = profile.canvas ?? { ...RENDER_PLAN_DEFAULT_CANVAS };
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) return { ok: false, code: "INVALID_PROFILE", message: "fps phải là số nguyên 1..120" };
  if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || canvas.width < 2 || canvas.height < 2 || canvas.width % 2 || canvas.height % 2) {
    return { ok: false, code: "INVALID_PROFILE", message: "canvas phải là số nguyên chẵn (yuv420p)" };
  }
  const padStartMs = profile.padStartMs ?? 0;
  const padEndMs = profile.padEndMs ?? 0;
  if (!Number.isFinite(padStartMs) || !Number.isFinite(padEndMs) || padStartMs < 0 || padEndMs < 0) return { ok: false, code: "INVALID_PROFILE", message: "padStartMs/padEndMs phải >= 0" };

  const ordered = [...input.scenes].sort((a, b) => a.orderIndex - b.orderIndex);
  const renderable = ordered.filter(isRenderable);
  const skippedSceneIds = ordered.filter((scene) => !isRenderable(scene)).map((scene) => scene.sceneId);
  if (renderable.length === 0) return { ok: false, code: "NO_RENDERABLE_SCENES", message: "Chưa có cảnh nào đủ media + giọng đọc để render" };
  if (renderable.length > RENDER_PLAN_MAX_SCENES) return { ok: false, code: "TOO_MANY_SCENES", message: `Tối đa ${RENDER_PLAN_MAX_SCENES} cảnh mỗi video` };

  const padStartFrames = msToFrames(padStartMs, fps);
  const padEndFrames = msToFrames(padEndMs, fps);
  const defaultTransition = profile.defaultTransition ?? NO_TRANSITION;

  let cursorFrame = padStartFrames;
  const scenes: RenderPlanScene[] = renderable.map((scene, index) => {
    const durationMs = scene.audioDurationMs!;
    // Never below one frame, otherwise a very short voice clip would vanish from the CFR timeline.
    const durationFrames = Math.max(1, msToFrames(durationMs, fps));
    const startFrame = cursorFrame;
    cursorFrame += durationFrames;
    const kind = scene.mediaKind!;
    const hasRange = kind === "video" && isPositiveFinite(scene.sourceDurationMs) && typeof scene.sourceStartMs === "number" && scene.sourceStartMs >= 0;
    const text = (scene.screenTextOverride ?? scene.fallbackScreenText ?? "").trim();
    const cues = scene.screenTextOverride
      ? []
      : (scene.captionSegments ?? []).map((cue) => clampCue(cue, framesToMs(durationFrames, fps))).filter((cue): cue is RenderPlanCaptionCue => cue !== null);
    return {
      sceneId: scene.sceneId,
      index,
      segmentId: scene.segmentId?.trim() || null,
      startFrame,
      durationFrames,
      startMs: framesToMs(startFrame, fps),
      durationMs: framesToMs(durationFrames, fps),
      media: {
        kind,
        mediaAssetVersionId: scene.mediaAssetVersionId!,
        sourceStartMs: hasRange ? scene.sourceStartMs! : null,
        sourceDurationMs: hasRange ? scene.sourceDurationMs! : null,
        prepared: scene.mediaPrepared === true,
      },
      voice: { audioAssetVersionId: scene.audioAssetVersionId!, durationMs },
      text,
      captionCues: cues,
      effectIn: scene.effectIn ?? NO_EFFECT,
      effectOut: scene.effectOut ?? NO_EFFECT,
      // The first scene has nothing to transition from.
      transitionIn: index === 0 ? NO_TRANSITION : scene.transitionIn ?? defaultTransition,
    };
  });

  const totalFrames = cursorFrame + padEndFrames;
  return {
    ok: true,
    skippedSceneIds,
    plan: {
      version: RENDER_PLAN_VERSION,
      canvas: { width: canvas.width, height: canvas.height },
      fps,
      padStartFrames,
      padEndFrames,
      totalFrames,
      totalDurationMs: framesToMs(totalFrames, fps),
      scenes,
      music: input.music ?? null,
      params: { ...(input.optionValues ?? {}) },
      template: {
        templateSnapshotId: input.template?.templateSnapshotId ?? null,
        engine: input.template?.engine ?? null,
        recipeId: input.template?.recipeId ?? null,
        recipeVersion: input.template?.recipeVersion ?? null,
      },
    },
  };
}

/** Sum of every renderable scene's voice length plus padding - what QC compares the encoded duration against. */
export const expectedRenderDurationMs = (plan: RenderPlan): number => plan.totalDurationMs;
