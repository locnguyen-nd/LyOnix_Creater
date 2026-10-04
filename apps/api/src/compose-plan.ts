import { buildRenderPlan, charTimingsForSegments, type CharacterAlignment, type RenderPlan, type RenderPlanSceneInput } from "@lyonix/domain";
import type { ComposePlan, ComposeScene } from "@lyonix/media-jobs";
import { resolveRecipeParams, type RenderRecipe } from "@lyonix/render-recipes";
import type { SceneBindingForMapping } from "./timeline-render-mapping.js";

/**
 * VE2E-110: assembles the wire plan of one internal render from an approved timeline: scenes (already re-pointed at their prepared
 * derivatives) -> domain `RenderPlan` (timing on the 60 fps frame grid) -> `ComposePlan` (MEDIA_ROOT-relative paths + content hashes).
 * Pure: the service does the database/media reads and passes them in.
 */

export type PlanAsset = { relativePath: string; checksumSha256: string | null };
export type PlanCaptionSource = { segments: ReadonlyArray<{ text: string; startMs: number; endMs: number }>; alignment: CharacterAlignment | null };

export type BuildComposePlanInput = {
  scenes: readonly SceneBindingForMapping[];
  /** MediaAssetVersion id -> path/hash, for scene media, derivatives and voices. */
  assets: ReadonlyMap<string, PlanAsset>;
  /** Media ids that are already trimmed/reframed derivatives (clip.prepare). */
  preparedMediaIds: ReadonlySet<string>;
  /** AudioVersion id -> its voice-timed caption segments (+ the TTS alignment, for per-character highlight timing). */
  captions: ReadonlyMap<string, PlanCaptionSource>;
  optionValues: Record<string, string>;
  recipe: RenderRecipe;
  templateSnapshotId: string;
};

export type BuildComposePlanResult =
  | { ok: true; plan: ComposePlan; renderPlan: RenderPlan; skippedSceneIds: string[]; recipeParams: Record<string, string> }
  | { ok: false; code: "NO_RENDERABLE_SCENES" | "ASSET_MISSING"; message: string };

export function buildComposePlan(input: BuildComposePlanInput): BuildComposePlanResult {
  const { recipe } = input;
  const sceneInputs: RenderPlanSceneInput[] = input.scenes.map((scene) => {
    const caption = scene.audioVersionId ? input.captions.get(scene.audioVersionId) : undefined;
    const timings = caption?.alignment ? charTimingsForSegments(caption.alignment, caption.segments) : null;
    return {
      sceneId: scene.sceneId,
      orderIndex: scene.orderIndex,
      excluded: Boolean(scene.excluded),
      segmentId: scene.segmentId ?? null,
      mediaAssetVersionId: scene.mediaAssetVersionId ?? null,
      mediaKind: scene.mediaKind ?? null,
      sourceStartMs: scene.sourceStartMs ?? null,
      sourceDurationMs: scene.sourceDurationMs ?? null,
      mediaPrepared: scene.mediaAssetVersionId ? input.preparedMediaIds.has(scene.mediaAssetVersionId) : false,
      audioAssetVersionId: scene.audioMediaAssetVersionId ?? null,
      audioDurationMs: scene.audioDurationMs ?? null,
      screenTextOverride: scene.screenTextOverride ?? null,
      fallbackScreenText: scene.fallbackScreenText ?? null,
      captionSegments: caption
        ? caption.segments.map((segment, index) => ({ text: segment.text, startMs: segment.startMs, endMs: segment.endMs, ...(timings?.[index] ? { charTimings: timings[index]! } : {}) }))
        : null,
    };
  });

  const built = buildRenderPlan({
    scenes: sceneInputs,
    optionValues: input.optionValues,
    template: { templateSnapshotId: input.templateSnapshotId, engine: "lyonix", recipeId: recipe.id, recipeVersion: recipe.version },
    profile: { padStartMs: recipe.timing.padStartMs, padEndMs: recipe.timing.padEndMs, defaultTransition: { kind: recipe.transition.kind, durationMs: recipe.transition.durationMs } },
  });
  if (!built.ok) return { ok: false, code: "NO_RENDERABLE_SCENES", message: built.message };

  const rendered = built.plan;
  const scenes: ComposeScene[] = [];
  for (const scene of rendered.scenes) {
    const media = input.assets.get(scene.media.mediaAssetVersionId);
    const voice = input.assets.get(scene.voice.audioAssetVersionId);
    if (!media || !voice) return { ok: false, code: "ASSET_MISSING", message: `Cảnh ${scene.sceneId}: không tìm thấy file media/giọng đọc trong kho` };
    scenes.push({
      sceneId: scene.sceneId,
      startFrame: scene.startFrame,
      durationFrames: scene.durationFrames,
      media: {
        relativePath: media.relativePath,
        mediaAssetVersionId: scene.media.mediaAssetVersionId,
        sha256: media.checksumSha256,
        kind: scene.media.kind,
        sourceStartMs: scene.media.prepared ? null : scene.media.sourceStartMs,
        sourceDurationMs: scene.media.prepared ? null : scene.media.sourceDurationMs,
      },
      voice: { relativePath: voice.relativePath, mediaAssetVersionId: scene.voice.audioAssetVersionId, sha256: voice.checksumSha256, durationMs: scene.voice.durationMs },
      text: scene.text,
      captionCues: scene.captionCues.map((cue) => ({ text: cue.text, startMs: cue.startMs, endMs: cue.endMs, ...(cue.charTimings ? { charTimings: cue.charTimings } : {}) })),
      effectIn: scene.effectIn,
      effectOut: scene.effectOut,
      transitionIn: scene.transitionIn,
    });
  }
  const plan: ComposePlan = {
    canvas: rendered.canvas,
    fps: rendered.fps,
    padStartFrames: rendered.padStartFrames,
    padEndFrames: rendered.padEndFrames,
    totalFrames: rendered.totalFrames,
    scenes,
    music: null,
    params: rendered.params,
  };
  return { ok: true, plan, renderPlan: rendered, skippedSceneIds: built.skippedSceneIds, recipeParams: resolveRecipeParams(recipe, rendered.params) };
}
