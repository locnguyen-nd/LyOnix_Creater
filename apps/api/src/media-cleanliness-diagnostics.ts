/**
 * VE2E-152: the cleanliness part of the media-plan diagnostics (what the chosen source looks like, why candidates were dropped, and
 * whether the pick is a "no clean footage left" fallback). Pure; shared by the Apify / Pexels tiers and the media plan.
 */
import { CLEANLINESS_FALLBACK_MESSAGE, cleanlinessRejectionCounts, isCleanlinessFallback, type MediaCleanliness, type RankedMediaCandidate } from "@lyonix/domain";
import type { SegmentCleanlinessDiagnostics } from "@lyonix/contracts";

/** `MEDIA_CLEANLINESS=0` stops asking vision for the cleanliness fields (the metadata hints still apply). Default on. */
export const cleanlinessCheckEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|false|off|no)$/i.test((env.MEDIA_CLEANLINESS ?? "").trim());

/** Frames sampled from a downloaded clip for the cleanliness / identity check: start, 25%, 50%, 75%, end - low resolution. */
export const CLEANLINESS_FRAME_COUNT = 5;
export const CLEANLINESS_FRAME_MAX_WIDTH = 384;

export function cleanlinessDiagnosticsOf(cleanliness: MediaCleanliness, fallback: boolean, rejected?: Record<string, number>): SegmentCleanlinessDiagnostics {
  return {
    tier: cleanliness.tier,
    cleanlinessScore: cleanliness.cleanlinessScore,
    textAreaRatio: cleanliness.textAreaRatio,
    logoDetected: cleanliness.logoDetected,
    watermarkDetected: cleanliness.watermarkDetected,
    subtitleDetected: cleanliness.subtitleDetected,
    preEdited: cleanliness.preEdited,
    editSignals: [...cleanliness.editSignals],
    method: cleanliness.method,
    fallback,
    ...(cleanliness.rejectionReason ? { rejectionReason: cleanliness.rejectionReason } : {}),
    ...(rejected && Object.keys(rejected).length > 0 ? { rejected: { ...rejected } } : {}),
    ...(fallback ? { message: CLEANLINESS_FALLBACK_MESSAGE } : {}),
  };
}

/** The chosen candidate's cleanliness diagnostics from a ranked pool (`undefined` when the pool carried no cleanliness evidence at all). */
export function chosenCleanlinessDiagnostics(ranked: readonly RankedMediaCandidate[], chosenCandidateId: string): SegmentCleanlinessDiagnostics | undefined {
  const rejected = cleanlinessRejectionCounts(ranked.map((entry) => entry.cleanliness));
  const chosen = ranked.find((entry) => entry.candidate.candidateId === chosenCandidateId)?.cleanliness;
  if (!chosen && Object.keys(rejected).length === 0) return undefined;
  const fallback = isCleanlinessFallback(ranked, chosenCandidateId);
  const verdict: MediaCleanliness = chosen ?? { tier: "clean", cleanlinessScore: 1, textAreaRatio: null, logoDetected: false, watermarkDetected: false, subtitleDetected: false, preEdited: false, editSignals: [], method: "none" };
  return cleanlinessDiagnosticsOf(verdict, fallback, rejected);
}
