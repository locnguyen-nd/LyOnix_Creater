import type { PexelsPhotoSearchResultResponse, PexelsVideoSearchResultResponse } from "@lyonix/contracts";

/** Number of Pexels results fetched per scene during auto-fill so there's a real pool to dedup/rank from, not just whatever the API happened to return first. */
export const AUTO_FILL_CANDIDATE_POOL = 10;

/**
 * Picks the best not-yet-used video candidate for a scene instead of always the API's first
 * result: a clip whose own native length already covers the scene's target duration avoids
 * Creatomate looping/freezing a too-short source, and portrait framing avoids an ugly crop.
 * Falls back to the closest-duration remaining candidate if none is long enough, and to null
 * only when every candidate has already been used elsewhere in this video.
 */
export function pickBestVideoCandidate(
  candidates: PexelsVideoSearchResultResponse[],
  usedExternalIds: Set<string>,
  targetDurationSeconds: number,
): PexelsVideoSearchResultResponse | null {
  const fresh = candidates.filter((candidate) => !usedExternalIds.has(candidate.externalId));
  if (fresh.length === 0) return null;
  const scored = fresh.map((candidate) => {
    const longEnough = candidate.durationSeconds >= targetDurationSeconds ? 1 : 0;
    const portrait = candidate.height > candidate.width ? 1 : 0;
    const durationGap = Math.abs(candidate.durationSeconds - targetDurationSeconds);
    return { candidate, score: longEnough * 100 + portrait * 10 - durationGap };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.candidate;
}

/** Same not-yet-used + portrait-preferred selection as video, minus the duration dimension (a still image never loops/freezes). */
export function pickBestPhotoCandidate(candidates: PexelsPhotoSearchResultResponse[], usedExternalIds: Set<string>): PexelsPhotoSearchResultResponse | null {
  const fresh = candidates.filter((candidate) => !usedExternalIds.has(candidate.externalId));
  if (fresh.length === 0) return null;
  const scored = fresh.map((candidate) => ({ candidate, score: candidate.height > candidate.width ? 1 : 0 }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.candidate;
}
