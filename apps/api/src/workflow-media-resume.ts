/**
 * VE2E-133: pure reconciliation between the media sourced EARLY (planned with `durationHintMs`, in parallel with TTS)
 * and the segment plan recomputed once the real voice durations are known. No I/O.
 *
 * Rule: sources already found are never searched again. Each final segment takes over the source of the early
 * segment that covers its first scene (exact scene-set match, or an overlapping one for a re-grouped plan) unless
 * that source can no longer cover the real durations; then the uncovered tail scenes (or the whole segment, when no
 * early source is usable) go back to `toSource` and are the only ones searched. Degraded sources (L4 window / L5 /
 * L6) are only taken over by an exact scene-set match.
 */
import { computeSocialWindowRanges, socialWindowOptionsFromEnv, type MediaPlanScene, type PlannedSegment } from "@lyonix/domain";
import type { SegmentSource, SourcedSegment } from "./media-plan.service.js";

const windowOptionsFor = (provider: string | undefined) => (provider === "apify" ? socialWindowOptionsFromEnv() : { startGuardMs: 0, endGuardMs: 0 });

const sameScenes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));

export type ReconcileStats = {
  /** Final segments that kept an early source for the exact same scenes. */
  exact: number;
  /** Final segments that took over an early source of an overlapping (re-grouped) segment. */
  overlap: number;
  /** Final segments (or tails) that need a new search. */
  resourced: number;
  /** Early sources not used by any final segment (found, then superseded by the real durations). */
  unused: number;
};

export type ReconcileResult = { reused: SourcedSegment[]; toSource: PlannedSegment[]; stats: ReconcileStats };

/** Does the early plan (scene grouping) still hold after the real durations? */
export const sameSegmentStructure = (early: readonly PlannedSegment[], final: readonly PlannedSegment[]): boolean =>
  early.length === final.length && early.every((segment, index) => sameScenes(segment.sceneIds, final[index]!.sceneIds) && segment.sceneIds.join("|") === final[index]!.sceneIds.join("|"));

export function reconcileSourcedSegments(input: {
  finalSegments: PlannedSegment[];
  early: SourcedSegment[];
  /** Real (voice) duration per scene id, ms. */
  durationOf: (sceneId: string) => number;
}): ReconcileResult {
  const consumed = new Set<SourcedSegment>();
  const reused: SourcedSegment[] = [];
  const toSource: PlannedSegment[] = [];
  const takenIds = new Set(input.finalSegments.map((segment) => segment.segmentId));
  const stats: ReconcileStats = { exact: 0, overlap: 0, resourced: 0, unused: 0 };
  const tailId = (base: string): string => {
    let candidate = `${base}-b`;
    for (let n = 2; takenIds.has(candidate); n += 1) candidate = `${base}-b${n}`;
    takenIds.add(candidate);
    return candidate;
  };
  const scenesOf = (segment: PlannedSegment): MediaPlanScene[] => segment.sceneIds.map((sceneId) => ({ sceneId, durationMs: Math.max(1, input.durationOf(sceneId)) }));
  const totalMs = (ids: string[]) => ids.reduce((sum, sceneId) => sum + Math.max(1, input.durationOf(sceneId)), 0);
  const isDegraded = (source: SegmentSource) => Boolean(source.degraded || source.window || source.placeholder);

  // A tail cut off because the clip cannot cover the real durations goes back through the same logic (an early second-source piece may already cover it).
  const queue = [...input.finalSegments];
  for (let final = queue.shift(); final; final = queue.shift()) {
    const first = final.sceneIds[0];
    const covering = input.early.find((piece) => first !== undefined && piece.segment.sceneIds.includes(first));
    // Keywords the early pass (or its extraction call) already derived are carried over: a re-grouped segment must not pay a second extraction call.
    const withKeywords = (segment: PlannedSegment): PlannedSegment => (segment.keywords || !covering?.segment.keywords ? segment : { ...segment, keywords: covering.segment.keywords });
    const exact = input.early.find((piece) => !consumed.has(piece) && piece.source && sameScenes(piece.segment.sceneIds, final.sceneIds));
    const overlap = exact ?? (covering && !consumed.has(covering) && covering.source && !isDegraded(covering.source) ? covering : undefined);
    const piece = exact ?? overlap;
    const source = piece?.source ?? null;
    if (!piece || !source) {
      toSource.push(withKeywords(final));
      stats.resourced += 1;
      continue;
    }
    // A piece is only consumed once it is actually taken over (a covered-nothing source goes back to `toSource` untouched).
    let keptIds = final.sceneIds;
    if (source.kind === "video" && !isDegraded(source)) {
      const plan = computeSocialWindowRanges(scenesOf(final), source.durationMs, windowOptionsFor(source.provider));
      if (plan && plan.needsSecondSource && plan.uncoveredSceneIds.length > 0) {
        const uncovered = new Set(plan.uncoveredSceneIds);
        keptIds = final.sceneIds.filter((sceneId) => !uncovered.has(sceneId));
        if (keptIds.length === 0) {
          toSource.push(withKeywords(final));
          stats.resourced += 1;
          continue;
        }
        const tailIds = final.sceneIds.filter((sceneId) => uncovered.has(sceneId));
        consumed.add(piece);
        queue.unshift(withKeywords({ ...final, segmentId: tailId(final.segmentId), sceneIds: tailIds, durationMs: totalMs(tailIds) }));
      }
    }
    consumed.add(piece);
    if (exact) stats.exact += 1;
    else stats.overlap += 1;
    reused.push({ segment: withKeywords({ ...final, sceneIds: keptIds, durationMs: totalMs(keptIds) }), source, errorCode: null });
  }
  stats.unused = input.early.filter((piece) => piece.source && !consumed.has(piece)).length;
  return { reused, toSource, stats };
}

/** Final segments in script order: reused + newly sourced pieces merged by the position of their first scene. */
export function orderByScript(pieces: SourcedSegment[], sceneOrder: readonly string[]): SourcedSegment[] {
  const position = new Map(sceneOrder.map((sceneId, index) => [sceneId, index] as const));
  const rank = (piece: SourcedSegment) => position.get(piece.segment.sceneIds[0] ?? "") ?? Number.MAX_SAFE_INTEGER;
  return [...pieces].sort((a, b) => rank(a) - rank(b));
}

/**
 * Last line of defence before the timeline is persisted (which rejects duplicate segment ids): a later piece that reuses an id
 * (reused early piece vs. second-source tail, repeated split) is renamed `<id>-r2`, `-r3`, ... Scene membership is untouched.
 */
export function ensureUniqueSegmentIds(pieces: SourcedSegment[]): SourcedSegment[] {
  const taken = new Set(pieces.map((piece) => piece.segment.segmentId));
  const seen = new Set<string>();
  return pieces.map((piece) => {
    const id = piece.segment.segmentId;
    if (!seen.has(id)) {
      seen.add(id);
      return piece;
    }
    let candidate = id;
    for (let n = 2; taken.has(candidate) || seen.has(candidate); n += 1) candidate = `${id}-r${n}`;
    taken.add(candidate);
    seen.add(candidate);
    return { ...piece, segment: { ...piece.segment, segmentId: candidate } };
  });
}
