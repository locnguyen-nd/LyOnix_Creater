import {
  computeSocialWindowRanges,
  type MediaPlanScene,
  type PlannedSegment,
  type SceneSourceRange,
  type SocialWindowOptions,
} from "./media-plan.js";

/**
 * Template-aware media planning (pure). A pinned template can mix IMAGE and VIDEO scene slots (e.g. a photo title card,
 * a video body, a photo outro). The slots are filled positionally by kind, so every scene must be sourced with the kind
 * its slot expects: images from an image source (Pinterest), videos from a video source (TikTok), never the other way
 * round. A template with only video slots keeps every scene video (no image is ever required).
 */

export type VisualKind = "video" | "image";

/**
 * Expected visual kind per scene, from the template's ordered visual slots (`video` / `image`, in element order).
 * With `N` scenes and `K` visual slots, scene `i` takes slot `i mod K`: the template's own pattern repeats when the script has
 * more scenes than slots, and is cut short when it has fewer. Returns `null` when the template exposes no visual slot
 * (caller keeps the legacy behaviour).
 */
export function deriveSceneVisualKinds(slotKinds: readonly string[], sceneIds: readonly string[]): Map<string, VisualKind> | null {
  const kinds = slotKinds.filter((kind): kind is VisualKind => kind === "video" || kind === "image");
  if (kinds.length === 0 || sceneIds.length === 0) return null;
  return new Map(sceneIds.map((sceneId, index) => [sceneId, kinds[index % kinds.length]!] as const));
}

/**
 * Splits every planned segment where the expected kind changes, so one segment (= one background source) never mixes an
 * image scene with a video scene. Each resulting segment carries its `visualKind`. The first part keeps the original
 * segment id; later parts get `-k2`, `-k3`, ... Durations are recomputed from the scenes.
 */
export function splitSegmentsByVisualKind(
  segments: readonly PlannedSegment[],
  kindByScene: ReadonlyMap<string, VisualKind>,
  durationByScene: ReadonlyMap<string, number>,
): PlannedSegment[] {
  const out: PlannedSegment[] = [];
  for (const segment of segments) {
    const groups: Array<{ kind: VisualKind; sceneIds: string[] }> = [];
    for (const sceneId of segment.sceneIds) {
      const kind = kindByScene.get(sceneId) ?? "video";
      const last = groups.at(-1);
      if (last && last.kind === kind) last.sceneIds.push(sceneId);
      else groups.push({ kind, sceneIds: [sceneId] });
    }
    groups.forEach((group, index) => {
      out.push({
        ...segment,
        segmentId: index === 0 ? segment.segmentId : `${segment.segmentId}-k${index + 1}`,
        sceneIds: group.sceneIds,
        durationMs: groups.length === 1 ? segment.durationMs : group.sceneIds.reduce((total, sceneId) => total + Math.max(0, durationByScene.get(sceneId) ?? 0), 0),
        visualKind: group.kind,
      });
    });
  }
  return out;
}

export type WindowRangePlan = {
  /** One range per scene, in scene order. Uncovered scenes are laid out after the covered ones (`looped: true`), never all restarting at the same instant. */
  ranges: SceneSourceRange[];
  /** The clip's guard-bounded window cannot cover every scene without replaying footage: a second source should be sourced for `uncoveredSceneIds`. */
  needsSecondSource: boolean;
  uncoveredSceneIds: string[];
  coveredMs: number;
  neededMs: number;
};

/**
 * Non-looping per-scene ranges for ANY video source (TikTok or stock): contiguous, inside `[startGuard, duration - endGuard]`.
 * Scenes the window cannot cover are the last-resort case: they are placed one after another from the window start
 * (wrapping only when the window is exhausted) instead of each restarting at 0, so the replayed footage is spread out
 * rather than the same opening seconds appearing in every uncovered scene. Returns `null` when the duration is unknown.
 */
export function computeWindowRangesWithLoopFallback(scenes: MediaPlanScene[], sourceDurationMs: number | null | undefined, options: SocialWindowOptions = {}): WindowRangePlan | null {
  const plan = computeSocialWindowRanges(scenes, sourceDurationMs, options);
  if (!plan) return null;
  const byScene = new Map(plan.ranges.map((range) => [range.sceneId, range] as const));
  const { startMs, endMs, usableMs } = plan.window;
  const uncovered = scenes.filter((scene) => !byScene.has(scene.sceneId));
  let cursor = startMs;
  for (const scene of uncovered) {
    const wanted = Math.max(1, Math.round(scene.durationMs));
    if (usableMs <= 0) {
      byScene.set(scene.sceneId, { sceneId: scene.sceneId, sourceStartMs: 0, sourceDurationMs: Math.max(1, Math.min(wanted, Math.floor(sourceDurationMs!))), looped: true, short: wanted > Math.floor(sourceDurationMs!) });
      continue;
    }
    if (cursor + Math.min(wanted, usableMs) > endMs) cursor = startMs;
    const take = Math.min(wanted, usableMs);
    byScene.set(scene.sceneId, { sceneId: scene.sceneId, sourceStartMs: cursor, sourceDurationMs: take, looped: true, short: take < wanted });
    cursor += take;
  }
  return {
    ranges: scenes.map((scene) => byScene.get(scene.sceneId)!).filter(Boolean),
    needsSecondSource: plan.needsSecondSource,
    uncoveredSceneIds: plan.uncoveredSceneIds,
    coveredMs: plan.coveredMs,
    neededMs: plan.neededMs,
  };
}
