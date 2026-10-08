/**
 * VE2E-134b: wiring helper between the Auto runner and `ClipDerivativesService.prepareEarly`.
 *
 * Right after a segment has a source (early pass, planned with `durationHintMs`; and again after the post-TTS reconcile) the runner
 * asks for the derivative of every video scene BEFORE the render step, using the exact ranges `MediaPlanService.buildBindings` would
 * produce for that script (same `computeWindowRangesWithLoopFallback` path, never a second implementation). `prepareEarly` reuses
 * the result at render time when start AND duration drift <= `CLIP_RANGE_TOLERANCE_MS`; a bigger drift is simply cut again.
 *
 * Fire-and-forget: nothing here is awaited by the pipeline and nothing here can throw into it. A scene that already has a launched
 * cut within the tolerance (same parent) is never requested again, so the second pass only cuts what actually changed.
 */
import { CLIP_RANGE_TOLERANCE_MS, type ClipDerivativeRequest } from "./clip-derivatives.service.js";

/** Rollback switch: `EARLY_CLIP_CUT=0|false|off|no` disables early cutting (default ON). */
export function earlyClipCutEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.EARLY_CLIP_CUT?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

export type EarlyCutScene = { sceneId: string; mediaAssetVersionId: string | null; mediaKind: "video" | "image" | null; sourceStartMs: number | null; sourceDurationMs: number | null };
export type EarlyCutTarget = { prepareEarly: (projectId: string, userId: string, requests: readonly ClipDerivativeRequest[]) => Promise<unknown> };

export class EarlyClipCutter {
  private readonly launched = new Map<string, { parentId: string; startMs: number; durationMs: number }>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly target: EarlyCutTarget | undefined,
    private readonly projectId: string,
    private readonly userId: string,
    private readonly enabled: boolean = earlyClipCutEnabled(),
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /**
   * `scenes` = `buildBindings(...).scenes`; `placeholderSceneIds` = scenes bound to a brand-background placeholder (never cut early).
   * Returns the number of scenes requested (0 when disabled / nothing new).
   */
  launch(scenes: readonly EarlyCutScene[], placeholderSceneIds: ReadonlySet<string> = new Set()): number {
    if (!this.enabled || !this.target) return 0;
    const requests: ClipDerivativeRequest[] = [];
    for (const scene of scenes) {
      if (scene.mediaKind !== "video" || !scene.mediaAssetVersionId || placeholderSceneIds.has(scene.sceneId)) continue;
      if (typeof scene.sourceStartMs !== "number" || typeof scene.sourceDurationMs !== "number" || scene.sourceDurationMs <= 0) continue;
      const previous = this.launched.get(scene.sceneId);
      if (
        previous &&
        previous.parentId === scene.mediaAssetVersionId &&
        Math.abs(previous.startMs - scene.sourceStartMs) <= CLIP_RANGE_TOLERANCE_MS &&
        Math.abs(previous.durationMs - scene.sourceDurationMs) <= CLIP_RANGE_TOLERANCE_MS
      ) continue;
      this.launched.set(scene.sceneId, { parentId: scene.mediaAssetVersionId, startMs: scene.sourceStartMs, durationMs: scene.sourceDurationMs });
      // The render step strips B-roll audio for template/dynamic renders (see RenderJobsService), so the early cut does too.
      requests.push({ sceneId: scene.sceneId, parentMediaAssetVersionId: scene.mediaAssetVersionId, startMs: scene.sourceStartMs, durationMs: scene.sourceDurationMs, stripAudio: true });
    }
    if (requests.length === 0) return 0;
    let call: Promise<unknown>;
    try {
      call = Promise.resolve(this.target.prepareEarly(this.projectId, this.userId, requests));
    } catch (error) {
      this.log(`[early-clip-cut] prepareEarly threw synchronously: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
    const tracked: Promise<void> = call.then(
      () => undefined,
      (error) => this.log(`[early-clip-cut] prepareEarly rejected: ${error instanceof Error ? error.message : String(error)}`),
    ).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
    return requests.length;
  }

  /** Cuts still running (for tests / diagnostics). Never rejects. */
  settled(): Promise<void> {
    return Promise.allSettled([...this.inflight]).then(() => undefined);
  }
}
