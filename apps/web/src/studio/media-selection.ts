import type { PexelsPhotoSearchResultResponse, PexelsVideoSearchResultResponse } from "@lyonix/contracts";
// Imports the browser-safe subpath, not the bare `@lyonix/domain` barrel - that barrel also
// re-exports a `node:crypto`-using module which Vite cannot bundle for the browser even when
// unused (see the note at the top of `packages/domain/src/index.ts`).
import {
  decideMediaSelection,
  rankMediaCandidates,
  type MediaCandidate,
  type SceneBrief,
} from "@lyonix/domain/media-ranking";

/** Number of Pexels results fetched per scene during auto-fill so there's a real pool to dedup/rank from, not just whatever the API happened to return first. */
export const AUTO_FILL_CANDIDATE_POOL = 10;

/**
 * VE2E-15a: this module used to hold its own small duration/orientation heuristic. It now
 * delegates scoring to the shared, source-neutral `rankMediaCandidates`/`decideMediaSelection`
 * in `@lyonix/domain` - the same ranking logic `apps/api/src/pexels.service.ts` uses for the
 * server-side Auto workflow - so there is exactly one ranking system, not two competing ones.
 *
 * The browser search results here (`PexelsPhotoSearchResultResponse`/
 * `PexelsVideoSearchResultResponse`) carry no descriptive text (Pexels' video search endpoint
 * never returns one, and the current `PexelsSearchResponse` contract does not forward photo alt
 * text to the client either), so `descriptorText` is always `null` and semantic scoring stays at
 * the domain module's documented neutral baseline here - continuity (not-yet-used + duration
 * fit) and quality (resolution/orientation) are what actually differentiate candidates
 * client-side today, same signals the superseded heuristic used.
 */
const minimalSceneBrief = (targetDurationSeconds: number): SceneBrief => ({
  sceneId: "client-auto-fill",
  beat: "explanation_evidence",
  language: "en",
  entities: [],
  action: [],
  setting: [],
  mood: [],
  exclusions: [],
  phrases: [],
  shotIntent: "",
  verticalOnly: true,
  targetDurationSeconds,
});

const videoToCandidate = (video: PexelsVideoSearchResultResponse): MediaCandidate => ({
  candidateId: `pexels:video:${video.externalId}`,
  source: "pexels",
  externalId: video.externalId,
  mediaType: "video",
  accessMethod: "api_download",
  previewUrl: video.thumbnailUrl,
  importUrl: null,
  durationSeconds: video.durationSeconds,
  widthPx: video.width || null,
  heightPx: video.height || null,
  attribution: { name: video.attribution.photographerName, profileUrl: video.attribution.photographerUrl, sourcePageUrl: video.attribution.pexelsPageUrl },
  provenance: { query: "", providerAccountId: "", queriedAt: new Date(0).toISOString() },
  rightsStatus: "cleared",
  capabilityEvidence: null,
  metadataScore: 0,
  descriptorText: null,
  visionFindings: null,
  relevanceScore: 0,
  moderationDecision: null,
  eligibility: { autoEligible: true },
});

const photoToCandidate = (photo: PexelsPhotoSearchResultResponse): MediaCandidate => ({
  candidateId: `pexels:photo:${photo.externalId}`,
  source: "pexels",
  externalId: photo.externalId,
  mediaType: "photo",
  accessMethod: "api_download",
  previewUrl: photo.previewUrl || photo.thumbnailUrl,
  importUrl: null,
  durationSeconds: null,
  widthPx: photo.width || null,
  heightPx: photo.height || null,
  attribution: { name: photo.attribution.photographerName, profileUrl: photo.attribution.photographerUrl, sourcePageUrl: photo.attribution.pexelsPageUrl },
  provenance: { query: "", providerAccountId: "", queriedAt: new Date(0).toISOString() },
  rightsStatus: "cleared",
  capabilityEvidence: null,
  metadataScore: 0,
  descriptorText: null,
  visionFindings: null,
  relevanceScore: 0,
  moderationDecision: null,
  eligibility: { autoEligible: true },
});

/**
 * Picks the best not-yet-used video candidate for a scene instead of always the API's first
 * result, via the shared `rankMediaCandidates`/`decideMediaSelection` policy (see file header).
 * Falls back to `null` both when every candidate has already been used elsewhere in this video
 * and when the best remaining candidate does not clear the shared relevance/eligibility gate.
 */
export function pickBestVideoCandidate(
  candidates: PexelsVideoSearchResultResponse[],
  usedExternalIds: Set<string>,
  targetDurationSeconds: number,
): PexelsVideoSearchResultResponse | null {
  const byExternalId = new Map(candidates.map((c) => [c.externalId, c] as const));
  const ranked = rankMediaCandidates(candidates.map(videoToCandidate), minimalSceneBrief(targetDurationSeconds), { usedExternalIds });
  const decision = decideMediaSelection(ranked);
  return decision.decision === "auto_select" ? (byExternalId.get(decision.chosen.externalId) ?? null) : null;
}

/** Same not-yet-used + portrait-preferred selection as video, minus the duration dimension (a still image never loops/freezes). */
export function pickBestPhotoCandidate(candidates: PexelsPhotoSearchResultResponse[], usedExternalIds: Set<string>): PexelsPhotoSearchResultResponse | null {
  const byExternalId = new Map(candidates.map((c) => [c.externalId, c] as const));
  const ranked = rankMediaCandidates(candidates.map(photoToCandidate), minimalSceneBrief(0), { usedExternalIds });
  const decision = decideMediaSelection(ranked);
  return decision.decision === "auto_select" ? (byExternalId.get(decision.chosen.externalId) ?? null) : null;
}
