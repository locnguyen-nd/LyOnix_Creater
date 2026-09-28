import { describe, expect, it } from "vitest";
import type { MediaCandidate, VisionFindings } from "./media-candidate.js";
import {
  applyVisionFindings,
  buildBoundedQueryVariants,
  buildMediaCandidateCacheKey,
  canAutoApplyMediaCandidate,
  decideMediaSelection,
  deriveNarrativeBeat,
  deriveSceneBrief,
  detectScriptLanguageHeuristic,
  normalizeSceneBriefForCache,
  rankMediaCandidates,
  type SceneBrief,
  type SceneBriefSourceScript,
} from "./media-ranking.js";

const script: SceneBriefSourceScript = {
  language: "en",
  scenes: [
    { sceneId: "s1", narration: "A person is walking on the beach at sunrise", screenText: "Morning walk", visualQuery: "person walking on beach", durationHintMs: 5000 },
    { sceneId: "s2", narration: "Quick cut to the city street without any cars", screenText: "City cut", visualQuery: "city street transition, no cars", durationHintMs: 1200 },
    { sceneId: "s3", narration: "She explains the recipe while cooking in the kitchen", screenText: "Cooking demo", visualQuery: "person cooking in kitchen", durationHintMs: 6000 },
    { sceneId: "s4", narration: "A happy ending shot in the office celebrating success", screenText: "Celebration", visualQuery: "happy celebration in office", durationHintMs: 4000 },
  ],
};

const candidate = (overrides: Partial<MediaCandidate> = {}): MediaCandidate => ({
  candidateId: "pexels:video:1",
  source: "pexels",
  externalId: "1",
  mediaType: "video",
  accessMethod: "api_download",
  previewUrl: "https://pexels.com/preview/1",
  importUrl: "https://pexels.com/download/1",
  durationSeconds: 8,
  widthPx: 1080,
  heightPx: 1920,
  attribution: { name: "Jane Doe" },
  provenance: { query: "beach", providerAccountId: "acc-1", queriedAt: "2026-09-27T00:00:00.000Z" },
  rightsStatus: "cleared",
  capabilityEvidence: null,
  metadataScore: 0,
  descriptorText: null,
  visionFindings: null,
  relevanceScore: 0,
  moderationDecision: null,
  eligibility: { autoEligible: true },
  ...overrides,
});

describe("deriveNarrativeBeat", () => {
  it("marks the first scene as hook and the last scene as payoff", () => {
    expect(deriveNarrativeBeat(0, 4, 5000)).toBe("hook");
    expect(deriveNarrativeBeat(3, 4, 4000)).toBe("payoff");
  });

  it("marks a short middle scene as transition and a longer one as explanation_evidence", () => {
    expect(deriveNarrativeBeat(1, 4, 1200)).toBe("transition");
    expect(deriveNarrativeBeat(2, 4, 6000)).toBe("explanation_evidence");
  });

  it("treats a single-scene script as hook", () => {
    expect(deriveNarrativeBeat(0, 1, 5000)).toBe("hook");
  });
});

describe("deriveSceneBrief", () => {
  it("derives beat/phrases/exclusions from the scene without forcing translation", () => {
    const brief = deriveSceneBrief(script, 1);
    expect(brief.sceneId).toBe("s2");
    expect(brief.beat).toBe("transition");
    expect(brief.language).toBe("en");
    expect(brief.phrases).toContain("city street transition, no cars");
    expect(brief.exclusions).toContain("cars");
    // "cars" must not also leak into a positive-signal bucket once it's an exclusion.
    expect(brief.entities).not.toContain("cars");
  });

  it("buckets a known action/setting/mood term instead of leaving everything as an entity", () => {
    const brief = deriveSceneBrief(script, 2);
    expect(brief.action).toContain("cooking");
    expect(brief.setting).toContain("kitchen");
  });

  it("buckets mood terms and derives payoff beat for the final scene", () => {
    const brief = deriveSceneBrief(script, 3);
    expect(brief.beat).toBe("payoff");
    expect(brief.mood).toContain("happy");
  });

  it("throws on an out-of-range scene index", () => {
    expect(() => deriveSceneBrief(script, 99)).toThrow(RangeError);
  });
});

describe("detectScriptLanguageHeuristic", () => {
  it("detects vi/en/ja/ko without needing an explicit language field", () => {
    expect(detectScriptLanguageHeuristic("Xin chào đây là video")).toBe("vi");
    expect(detectScriptLanguageHeuristic("Hello this is a video")).toBe("en");
    expect(detectScriptLanguageHeuristic("こんにちは")).toBe("ja");
    expect(detectScriptLanguageHeuristic("안녕하세요")).toBe("ko");
  });
});

describe("buildBoundedQueryVariants", () => {
  it("never exceeds the bounded max and drops duplicates", () => {
    const brief: SceneBrief = {
      sceneId: "s1", beat: "hook", language: "en", entities: [], action: [], setting: [], mood: [], exclusions: [],
      phrases: ["same phrase", "Same Phrase", "another phrase", "third phrase", "fourth phrase"],
      shotIntent: "", verticalOnly: true, targetDurationSeconds: 5,
    };
    const variants = buildBoundedQueryVariants(brief);
    expect(variants.length).toBeLessThanOrEqual(3);
    expect(variants).toEqual(["same phrase", "another phrase", "third phrase"]);
  });
});

describe("rankMediaCandidates", () => {
  const brief = deriveSceneBrief(script, 0); // hook: "person walking on beach"

  it("ranks a candidate with matching descriptor text above one with no descriptor text", () => {
    const matching = candidate({ candidateId: "pexels:photo:2", externalId: "2", mediaType: "photo", descriptorText: "a person walking along the beach at sunrise" });
    const generic = candidate({ candidateId: "pexels:photo:3", externalId: "3", mediaType: "photo", descriptorText: "a red sports car on a highway" });
    const ranked = rankMediaCandidates([generic, matching], brief);
    expect(ranked[0]!.candidate.externalId).toBe("2");
    expect(ranked[0]!.semanticScore).toBeGreaterThan(ranked[1]!.semanticScore);
  });

  it("prefers a video long enough to cover the scene duration over a too-short one, same as the superseded heuristic", () => {
    const short = candidate({ externalId: "short", durationSeconds: 2 });
    const longEnough = candidate({ externalId: "long-enough", durationSeconds: 8 });
    const ranked = rankMediaCandidates([short, longEnough], brief);
    expect(ranked[0]!.candidate.externalId).toBe("long-enough");
  });

  it("filters out already-used external ids instead of merely down-ranking them", () => {
    const used = candidate({ externalId: "used" });
    const fresh = candidate({ externalId: "fresh" });
    const ranked = rankMediaCandidates([used, fresh], brief, { usedExternalIds: new Set(["used"]) });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.candidate.externalId).toBe("fresh");
  });

  it("hard-filters (score 0) a candidate whose descriptor text matches an explicit scene exclusion", () => {
    const excludeBrief = deriveSceneBrief(script, 1); // exclusion: "cars"
    const withCars = candidate({ externalId: "cars", mediaType: "video", descriptorText: "busy street full of cars honking" });
    const ranked = rankMediaCandidates([withCars], excludeBrief);
    expect(ranked[0]!.combinedScore).toBe(0);
    expect(ranked[0]!.excludedReason).toBe("matches_exclusion");
  });

  it("restricts to allowedTypes when the template only accepts one media kind", () => {
    const video = candidate({ externalId: "v", mediaType: "video" });
    const photo = candidate({ externalId: "p", mediaType: "photo", candidateId: "pexels:photo:p" });
    const ranked = rankMediaCandidates([video, photo], brief, { allowedTypes: ["photo"] });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.candidate.mediaType).toBe("photo");
  });
});

describe("decideMediaSelection", () => {
  const brief = deriveSceneBrief(script, 0);

  it("abstains with no_candidates on an empty pool", () => {
    expect(decideMediaSelection([])).toEqual({ decision: "needs_input", reason: "no_candidates", ranked: [] });
  });

  it("auto-selects a strong, cleared, eligible top candidate", () => {
    const strong = candidate({ descriptorText: "a person walking along the beach at sunrise" });
    const ranked = rankMediaCandidates([strong], brief);
    const decision = decideMediaSelection(ranked);
    expect(decision.decision).toBe("auto_select");
    if (decision.decision === "auto_select") expect(decision.chosen.externalId).toBe("1");
  });

  it("routes a weak-relevance top candidate to needs_input rather than silently importing it", () => {
    const weak = candidate({ descriptorText: "a red sports car on a highway" });
    const ranked = rankMediaCandidates([weak], brief);
    const decision = decideMediaSelection(ranked, { relevanceThreshold: 0.99 });
    expect(decision).toMatchObject({ decision: "needs_input", reason: "below_relevance_threshold" });
  });

  it("routes an otherwise-strong candidate with unresolved rights to needs_input", () => {
    const unresolved = candidate({ descriptorText: "a person walking along the beach at sunrise", rightsStatus: "unclear" });
    const ranked = rankMediaCandidates([unresolved], brief);
    const decision = decideMediaSelection(ranked);
    expect(decision).toMatchObject({ decision: "needs_input", reason: "rights_unresolved" });
  });

  it("skips a rejected top candidate and falls through to a usable lower-ranked one", () => {
    const rejected = candidate({ externalId: "rejected", descriptorText: "a person walking along the beach at sunrise", moderationDecision: "rejected" });
    const usable = candidate({ externalId: "usable", descriptorText: "a person walking near the beach", candidateId: "pexels:video:usable" });
    const ranked = rankMediaCandidates([rejected, usable], brief);
    const decision = decideMediaSelection(ranked);
    expect(decision.decision).toBe("auto_select");
    if (decision.decision === "auto_select") expect(decision.chosen.externalId).toBe("usable");
  });

  it("abstains when every candidate is rejected by moderation", () => {
    const rejected = candidate({ moderationDecision: "rejected", descriptorText: "a person walking along the beach at sunrise" });
    const ranked = rankMediaCandidates([rejected], brief);
    const decision = decideMediaSelection(ranked);
    expect(decision).toMatchObject({ decision: "needs_input", reason: "rejected_by_moderation" });
  });

  const photoCandidate = (overrides: Partial<MediaCandidate> = {}) =>
    candidate({ mediaType: "photo", candidateId: "pexels:photo:1", ...overrides });

  it("without requireVerifiedSemanticSignal, still auto-selects a candidate with no descriptor/vision evidence (unchanged Studio auto-fill behavior)", () => {
    const noEvidence = candidate(); // descriptorText/visionFindings both null by default
    const ranked = rankMediaCandidates([noEvidence], brief);
    const decision = decideMediaSelection(ranked);
    expect(decision.decision).toBe("auto_select");
  });

  it("with requireVerifiedSemanticSignal, a video candidate with no descriptor/vision evidence is still auto-selected (Pexels video search returns no alt/tag text at all - gating it would make Auto abstain on nearly every video scene; real per-frame verification needs media-worker frame extraction that does not exist yet, tracked as a separate follow-up)", () => {
    const noEvidenceVideo = candidate({ mediaType: "video" });
    const ranked = rankMediaCandidates([noEvidenceVideo], brief);
    const decision = decideMediaSelection(ranked, { requireVerifiedSemanticSignal: true });
    expect(decision.decision).toBe("auto_select");
  });

  it("with requireVerifiedSemanticSignal, abstains on a PHOTO candidate with no descriptor/vision evidence instead of trusting continuity/quality/cost alone (Auto's guard against the JOB-1007-class bug for the media type where real Pexels alt text is actually available)", () => {
    const noEvidencePhoto = photoCandidate();
    const ranked = rankMediaCandidates([noEvidencePhoto], brief);
    const decision = decideMediaSelection(ranked, { requireVerifiedSemanticSignal: true });
    expect(decision).toMatchObject({ decision: "needs_input", reason: "unverified_relevance" });
  });

  it("with requireVerifiedSemanticSignal, still auto-selects a photo once real evidence (descriptor/alt text) is present", () => {
    const verified = photoCandidate({ descriptorText: "a person walking along the beach at sunrise" });
    const ranked = rankMediaCandidates([verified], brief);
    const decision = decideMediaSelection(ranked, { requireVerifiedSemanticSignal: true });
    expect(decision.decision).toBe("auto_select");
  });

  it("with requireVerifiedSemanticSignal, real vision findings alone (no descriptor text) also count as verified for a photo", () => {
    const visionOnly = photoCandidate({
      visionFindings: {
        decision: "accepted", confidence: 0.9, reasonCodes: ["safety_clear_high_confidence"], sceneBeatRelevance: 0.85, safetyFindings: [],
        provider: "gemini", model: "gemini-2.5-flash", operation: "image_moderation", version: "vision-moderation-policy.v1",
        evidenceRefs: [], decidedAt: "2026-09-28T00:00:00.000Z",
      },
    });
    const ranked = rankMediaCandidates([visionOnly], brief);
    const decision = decideMediaSelection(ranked, { requireVerifiedSemanticSignal: true });
    expect(decision.decision).toBe("auto_select");
  });

  it("with requireVerifiedSemanticSignal, skips an unverified top photo and falls through to a verified lower-ranked one", () => {
    const unverified = photoCandidate({ externalId: "unverified" });
    const verified = photoCandidate({ externalId: "verified", candidateId: "pexels:photo:verified", descriptorText: "a person walking near the beach" });
    const ranked = rankMediaCandidates([unverified, verified], brief);
    const decision = decideMediaSelection(ranked, { requireVerifiedSemanticSignal: true });
    expect(decision.decision).toBe("auto_select");
    if (decision.decision === "auto_select") expect(decision.chosen.externalId).toBe("verified");
  });
});

describe("canAutoApplyMediaCandidate", () => {
  it("only allows accepted-or-unmoderated, rights-cleared, eligible candidates", () => {
    expect(canAutoApplyMediaCandidate(candidate())).toBe(true);
    expect(canAutoApplyMediaCandidate(candidate({ moderationDecision: "rejected" }))).toBe(false);
    expect(canAutoApplyMediaCandidate(candidate({ rightsStatus: "unclear" }))).toBe(false);
    expect(canAutoApplyMediaCandidate(candidate({ eligibility: { autoEligible: false, reason: "discovery_only_no_import_capability" } }))).toBe(false);
    expect(canAutoApplyMediaCandidate(candidate({ moderationDecision: "accepted" }))).toBe(true);
  });
});

describe("applyVisionFindings (VE2E-24 integration)", () => {
  const findings = (overrides: Partial<VisionFindings> = {}): VisionFindings => ({
    decision: "accepted",
    confidence: 0.9,
    reasonCodes: ["safety_clear_high_confidence"],
    sceneBeatRelevance: 0.8,
    safetyFindings: [],
    provider: "gemini",
    model: "gemini-2.5-flash",
    operation: "image_moderation",
    version: "vision-moderation-policy.v1",
    evidenceRefs: ["req-1"],
    decidedAt: "2026-09-27T00:00:00.000Z",
    ...overrides,
  });

  it("a rejected finding forces eligibility.autoEligible to false, overriding an adapter that had marked it eligible", () => {
    const eligible = candidate({ eligibility: { autoEligible: true } });
    const result = applyVisionFindings(eligible, findings({ decision: "rejected" }));
    expect(result.moderationDecision).toBe("rejected");
    expect(result.eligibility).toEqual({ autoEligible: false, reason: "rejected_by_vision_moderation" });
    expect(canAutoApplyMediaCandidate(result)).toBe(false);
  });

  it("an accepted finding never flips an already-ineligible candidate (e.g. discovery-only) to eligible", () => {
    const ineligible = candidate({ eligibility: { autoEligible: false, reason: "discovery_and_embed_only_no_import_capability" } });
    const result = applyVisionFindings(ineligible, findings({ decision: "accepted" }));
    expect(result.moderationDecision).toBe("accepted");
    expect(result.eligibility).toEqual({ autoEligible: false, reason: "discovery_and_embed_only_no_import_capability" });
  });

  it("attaches visionFindings and moderationDecision without mutating the original candidate", () => {
    const original = candidate({ eligibility: { autoEligible: true } });
    const result = applyVisionFindings(original, findings());
    expect(original.visionFindings).toBeNull();
    expect(result.visionFindings).toEqual(findings());
  });
});

describe("normalizeSceneBriefForCache / buildMediaCandidateCacheKey", () => {
  it("is stable regardless of array ordering and produces distinct keys for distinct briefs", () => {
    const briefA: SceneBrief = { sceneId: "s1", beat: "hook", language: "en", entities: ["a", "b"], action: [], setting: [], mood: [], exclusions: [], phrases: ["x", "y"], shotIntent: "", verticalOnly: true, targetDurationSeconds: 5 };
    const briefAReordered: SceneBrief = { ...briefA, entities: ["b", "a"], phrases: ["y", "x"] };
    expect(normalizeSceneBriefForCache(briefA)).toBe(normalizeSceneBriefForCache(briefAReordered));

    const keyA = buildMediaCandidateCacheKey({ normalizedBrief: normalizeSceneBriefForCache(briefA), provider: "pexels", providerAccountId: "acc-1", catalogVersion: "v1" });
    const keyB = buildMediaCandidateCacheKey({ normalizedBrief: normalizeSceneBriefForCache(briefA), provider: "pexels", providerAccountId: "acc-2", catalogVersion: "v1" });
    expect(keyA).not.toBe(keyB);
    expect(keyA).toMatch(/^mc:[0-9a-f]{8}$/);
  });
});
