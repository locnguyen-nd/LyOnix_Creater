import { describe, expect, it } from "vitest";
import type { MediaCandidate, VisionCleanlinessFindings, VisionFindings, VisionIdentityFindings, VisionShotFindings } from "./media-candidate.js";
import { assessMediaCleanliness, metadataEditSignals } from "./media-cleanliness.js";
import { decideMediaSelection, deriveSceneBrief, isCleanlinessFallback, rankMediaCandidates, type SceneBrief } from "./media-ranking.js";
import { runQualityGate } from "./quality-gate.js";
import { applySubjectToBrief, subjectProfileOf } from "./subject-filter.js";

const clean = (overrides: Partial<VisionCleanlinessFindings> = {}): VisionCleanlinessFindings => ({
  textAreaPct: 2,
  textOverSubject: false,
  subtitles: false,
  logo: "none",
  watermark: false,
  lowerThird: false,
  stickers: false,
  frameTemplate: false,
  splitScreen: false,
  socialUi: false,
  largeOverlay: false,
  ...overrides,
});

const candidate = (id: string, overrides: Partial<MediaCandidate> = {}, vision?: { cleanliness?: VisionCleanlinessFindings; shot?: VisionShotFindings; identity?: VisionIdentityFindings }): MediaCandidate => {
  const findings: VisionFindings | null = vision
    ? { decision: "accepted", confidence: 0.9, reasonCodes: [], sceneBeatRelevance: 0.7, safetyFindings: [], provider: "gemini", model: "m", operation: "image_moderation", version: "v", evidenceRefs: [], decidedAt: "2026-10-09T00:00:00.000Z", ...vision }
    : null;
  return {
    candidateId: id,
    source: "apify",
    externalId: id,
    mediaType: "video",
    accessMethod: "api_download",
    previewUrl: `https://example.com/${id}.jpg`,
    importUrl: `https://example.com/${id}.mp4`,
    durationSeconds: 12,
    widthPx: 1080,
    heightPx: 1920,
    attribution: { name: "uploader" },
    provenance: { query: "q", providerAccountId: "acc", queriedAt: "2026-10-09T00:00:00.000Z" },
    rightsStatus: "owner_accepted_risk",
    capabilityEvidence: null,
    metadataScore: 0,
    descriptorText: "street dance performance",
    visionFindings: findings,
    relevanceScore: 0,
    moderationDecision: findings ? "accepted" : null,
    eligibility: { autoEligible: true },
    ...overrides,
  };
};

const brief = (): SceneBrief =>
  deriveSceneBrief({ language: "en", scenes: [{ sceneId: "s1", narration: "a dancer performs on the street", screenText: "", visualQuery: "street dance performance", durationHintMs: 8000 }] }, 0);
const felixSubject = { subject: "Lee Felix", aliases: ["フィリックス", "Felix"], mustInclude: ["Stray Kids"], subjectKind: "person" };
const personBrief = (): SceneBrief => applySubjectToBrief(brief(), subjectProfileOf({ keywords: felixSubject }), { priority: 1 });
const order = (ranked: ReturnType<typeof rankMediaCandidates>) => ranked.map((entry) => entry.candidate.candidateId);

describe("VE2E-152 cleanliness rules", () => {
  it("text area bands: <= 8% clean, 8-18% acceptable, 18-30% penalized, > 30% reject (TEXT_HEAVY)", () => {
    expect(assessMediaCleanliness({ vision: clean({ textAreaPct: 6 }) }).tier).toBe("clean");
    expect(assessMediaCleanliness({ vision: clean({ textAreaPct: 12 }) }).tier).toBe("acceptable");
    expect(assessMediaCleanliness({ vision: clean({ textAreaPct: 25 }) }).tier).toBe("penalized");
    expect(assessMediaCleanliness({ vision: clean({ textAreaPct: 40 }) })).toMatchObject({ tier: "reject", rejectionReason: "TEXT_HEAVY", textAreaRatio: 0.4 });
  });

  it("text over the face / subject is one band worse", () => {
    expect(assessMediaCleanliness({ vision: clean({ textAreaPct: 12, textOverSubject: true }) }).tier).toBe("penalized");
    expect(assessMediaCleanliness({ vision: clean({ textAreaPct: 25, textOverSubject: true }) }).rejectionReason).toBe("TEXT_HEAVY");
  });

  it("small corner logo = light penalty; large logo = LARGE_WATERMARK reject; watermark / username = strong penalty", () => {
    expect(assessMediaCleanliness({ vision: clean({ logo: "small" }) })).toMatchObject({ tier: "acceptable", logoDetected: true });
    expect(assessMediaCleanliness({ vision: clean({ logo: "large" }) })).toMatchObject({ tier: "reject", rejectionReason: "LARGE_WATERMARK" });
    expect(assessMediaCleanliness({ vision: clean({ watermark: true }) })).toMatchObject({ tier: "penalized", watermarkDetected: true });
  });

  it("multi-frame sample: heavy text on >= 2 of 5 frames = text-heavy; subtitles on them = BURNT_IN_SUBTITLES", () => {
    expect(assessMediaCleanliness({ vision: clean({ textAreaPct: 15, heavyTextFrames: 2, sampledFrames: 5 }) }).rejectionReason).toBe("TEXT_HEAVY");
    expect(assessMediaCleanliness({ vision: clean({ textAreaPct: 15, heavyTextFrames: 1, sampledFrames: 5 }) }).tier).toBe("acceptable");
    expect(assessMediaCleanliness({ vision: clean({ textAreaPct: 12, subtitles: true, heavyTextFrames: 0, sampledFrames: 5 }) })).toMatchObject({ tier: "penalized", subtitleDetected: true });
  });

  it("pre-edited: >= 2 edit signals penalize (preEdited), >= 3 visible signals = a finished edit (PRE_EDITED_VIDEO)", () => {
    expect(assessMediaCleanliness({ vision: clean({ stickers: true }), text: "#capcut edit" })).toMatchObject({ tier: "penalized", preEdited: true });
    expect(assessMediaCleanliness({ vision: clean({ stickers: true, frameTemplate: true, splitScreen: true }) })).toMatchObject({ tier: "reject", rejectionReason: "PRE_EDITED_VIDEO", preEdited: true });
  });

  it("social-app UI / CTA and a news card are rejects", () => {
    expect(assessMediaCleanliness({ vision: clean({ socialUi: true }) }).rejectionReason).toBe("SOCIAL_UI_OVERLAY");
    expect(assessMediaCleanliness({ shot: { peopleCount: 1, closeUp: false, textCoverage: "heavy", logo: false, newsCard: true } })).toMatchObject({ tier: "reject", rejectionReason: "NEWS_CARD" });
  });

  it("metadata alone never rejects (it can only lower to penalized); no evidence = clean, method none", () => {
    expect(metadataEditSignals("Felix edit #capcut lyrics 歌詞")).toEqual(expect.arrayContaining(["edit_hashtags", "lyrics_or_text_video"]));
    expect(assessMediaCleanliness({ text: "Felix edit #capcut lyrics", platformSignals: ["stickers_or_emoji"] })).toMatchObject({ tier: "penalized", method: "metadata", preEdited: true });
    expect(assessMediaCleanliness({ text: "street dance" })).toMatchObject({ tier: "clean", method: "none" });
  });
});

describe("VE2E-152 ranking with cleanliness", () => {
  it("raw clean footage > a video with burnt-in subtitles (same relevance)", () => {
    const ranked = rankMediaCandidates([candidate("subs", {}, { cleanliness: clean({ textAreaPct: 14, subtitles: true }) }), candidate("raw", {}, { cleanliness: clean() })], brief());
    expect(order(ranked)).toEqual(["raw", "subs"]);
    expect(ranked[1]!.cleanliness).toMatchObject({ tier: "penalized", subtitleDetected: true });
  });

  it("small corner logo > large watermark (the large one is out of the auto pick)", () => {
    const ranked = rankMediaCandidates([candidate("big", {}, { cleanliness: clean({ logo: "large" }) }), candidate("small", {}, { cleanliness: clean({ logo: "small" }) })], brief());
    expect(order(ranked)).toEqual(["small", "big"]);
    expect(ranked[1]).toMatchObject({ combinedScore: 0, excludedReason: "LARGE_WATERMARK" });
  });

  it("news card / text-heavy and social-app UI overlays are rejected", () => {
    const ranked = rankMediaCandidates([
      candidate("text", {}, { cleanliness: clean({ textAreaPct: 45 }) }),
      candidate("ui", {}, { cleanliness: clean({ socialUi: true }) }),
      candidate("ok", {}, { cleanliness: clean({ textAreaPct: 10 }) }),
    ], brief());
    expect(order(ranked)[0]).toBe("ok");
    expect(ranked.find((entry) => entry.candidate.candidateId === "text")?.excludedReason).toBe("TEXT_HEAVY");
    expect(ranked.find((entry) => entry.candidate.candidateId === "ui")?.excludedReason).toBe("SOCIAL_UI_OVERLAY");
  });

  it("right person but text-heavy: below the right person's clean clip and not auto-picked alone (unless allowed)", () => {
    const shot: VisionShotFindings = { peopleCount: 1, closeUp: true, textCoverage: "none", logo: false, newsCard: false };
    const heavy = candidate("heavy", { descriptorText: "Lee Felix fancam" }, { cleanliness: clean({ textAreaPct: 38 }), shot });
    const fine = candidate("fine", { descriptorText: "Lee Felix fancam" }, { cleanliness: clean(), shot });
    expect(order(rankMediaCandidates([heavy, fine], personBrief()))).toEqual(["fine", "heavy"]);
    expect(decideMediaSelection(rankMediaCandidates([heavy], personBrief())).decision).toBe("needs_input");
    const allowed = decideMediaSelection(rankMediaCandidates([heavy], personBrief(), { allowCleanlinessRejects: true }));
    expect(allowed.decision).toBe("auto_select");
  });

  it("wrong person is rejected even when perfectly clean; the right person with subtitles wins", () => {
    const shot: VisionShotFindings = { peopleCount: 1, closeUp: true, textCoverage: "little", logo: false, newsCard: false };
    const wrongClean = candidate("wrong", { descriptorText: "#leefelix #straykids" }, { cleanliness: clean(), shot, identity: { match: "different_person", confidence: 0.85 } });
    const rightSubs = candidate("right", { descriptorText: "Lee Felix stage" }, { cleanliness: clean({ textAreaPct: 12, subtitles: true }), shot });
    const ranked = rankMediaCandidates([wrongClean, rightSubs], personBrief());
    expect(order(ranked)).toEqual(["right", "wrong"]);
    expect(ranked[1]).toMatchObject({ combinedScore: 0, excludedReason: "person_wrong_person" });
  });

  it("fallback: with no clean footage left a medium candidate is taken and flagged; with a clean one it is not a fallback", () => {
    const medium = [candidate("logo", {}, { cleanliness: clean({ logo: "small", textAreaPct: 10 }) }), candidate("subs", {}, { cleanliness: clean({ subtitles: true }) }), candidate("bad", {}, { cleanliness: clean({ socialUi: true }) })];
    const ranked = rankMediaCandidates(medium, brief());
    const decision = decideMediaSelection(ranked);
    expect(decision.decision === "auto_select" && decision.chosen.candidateId).toBe("logo");
    expect(isCleanlinessFallback(ranked, "logo")).toBe(true);
    const withClean = rankMediaCandidates([...medium, candidate("raw", {}, { cleanliness: clean() })], brief());
    expect(order(withClean)[0]).toBe("raw");
    expect(isCleanlinessFallback(withClean, "raw")).toBe(false);
    // Only rejects left: nothing is auto-picked.
    expect(decideMediaSelection(rankMediaCandidates([candidate("bad", {}, { cleanliness: clean({ socialUi: true }) })], brief())).decision).toBe("needs_input");
  });

  it("no cleanliness evidence at all -> the ranking is exactly as before (no cleanliness field, unchanged score)", () => {
    const plain = rankMediaCandidates([candidate("p")], brief())[0]!;
    expect(plain.cleanliness).toBeUndefined();
    expect(plain.combinedScore).toBeGreaterThan(0.45);
  });

  it("the quality gate reports the overlay fallback clearly (never blocks)", () => {
    const scene = (sceneId: string, cleanlinessFallback: boolean) => ({ sceneId, segmentId: sceneId, assetId: null, kind: null, sourceStartMs: null, sourceDurationMs: null, sceneDurationMs: 4000, narration: "x", cleanlinessFallback });
    const result = runQualityGate({ scenes: [scene("s1", false), scene("s2", true)], assets: [], targetSec: 8 });
    expect(result.failure).toBeNull();
    expect(result.warnings.find((warning) => warning.code === "media_overlay_fallback")?.detail).toContain("Không đủ footage sạch, đang dùng media có overlay nhẹ.");
    expect(result.checks.find((check) => check.name === "media_cleanliness")?.status).toBe("warning");
  });
});

describe("VE2E-152 five sample candidates (person target Lee Felix)", () => {
  it("ranking order: verified raw > small corner logo > burnt-in subtitles > rejected (TikTok edit UI, wrong person)", () => {
    const shot: VisionShotFindings = { peopleCount: 1, closeUp: true, textCoverage: "none", logo: false, newsCard: false };
    const pool = [
      candidate("A_tiktok_edit_ui", { descriptorText: "Lee Felix edit #capcut" }, { cleanliness: clean({ textAreaPct: 22, stickers: true, socialUi: true, watermark: true }), shot }),
      candidate("B_subtitled_fancam", { descriptorText: "Lee Felix fancam 字幕" }, { cleanliness: clean({ textAreaPct: 14, subtitles: true }), shot }),
      candidate("C_wrong_person_clean", { descriptorText: "#leefelix #straykids" }, { cleanliness: clean(), shot, identity: { match: "different_person", confidence: 0.9 } }),
      candidate("D_small_logo_stage", { descriptorText: "Lee Felix stage" }, { cleanliness: clean({ logo: "small", textAreaPct: 5 }), shot }),
      candidate("E_raw_verified", { descriptorText: "Felix #straykids practice" }, { cleanliness: clean(), shot, identity: { match: "match", confidence: 0.9 } }),
    ];
    const ranked = rankMediaCandidates(pool, personBrief());
    expect(order(ranked)).toEqual(["E_raw_verified", "D_small_logo_stage", "B_subtitled_fancam", "A_tiktok_edit_ui", "C_wrong_person_clean"]);
    expect(ranked.slice(3).map((entry) => entry.excludedReason)).toEqual(["SOCIAL_UI_OVERLAY", "person_wrong_person"]);
  });
});
