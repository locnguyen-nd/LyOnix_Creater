import { describe, expect, it } from "vitest";
import type { MediaCandidate, VisionFindings, VisionIdentityFindings, VisionShotFindings } from "./media-candidate.js";
import { assessPersonCoveragePreflight, personCoverageSummary, personMediaRoleOf, strictPersonModeFor, type PersonCoverageScene, type PersonMediaRole } from "./person-coverage.js";
import { personTargetOf, resolveTargetPerson, parseTargetPersonInput, scorePersonCandidate } from "./person-target.js";
import { decideMediaSelection, deriveSceneBrief, rankMediaCandidates } from "./media-ranking.js";
import { runQualityGate, type QualityGateScene } from "./quality-gate.js";
import { applySubjectToBrief, subjectProfileOf } from "./subject-filter.js";

const roki = { kind: "person", main: "佐々木朗希", aliases: ["Roki Sasaki", "朗希"], mustInclude: ["ドジャース", "Dodgers"], otherPeople: ["大谷翔平"] };
const P: PersonMediaRole = "person_primary";
const S: PersonMediaRole = "person_support";
const C: PersonMediaRole = "context";
const G: PersonMediaRole = "generic";
const scenes = (roles: PersonMediaRole[]): PersonCoverageScene[] => roles.map((mediaRole, i) => ({ sceneId: `s${i + 1}`, targetPerson: "佐々木朗希", mediaRole, identityConfidence: mediaRole === P ? 0.9 : mediaRole === S ? 0.5 : 0, verificationMethod: mediaRole === P ? "vision" : mediaRole === S ? "metadata" : "none" }));

describe("strict person coverage preflight", () => {
  it("12 scenes / 8 of the person (scene 1, 2 of the first 3, never 2 context in a row) -> pass", () => {
    const report = assessPersonCoveragePreflight(scenes([P, P, C, P, S, C, P, P, C, P, P, C]));
    expect(report).toMatchObject({ ok: true, totalScenes: 12, personSceneCount: 8, exactPersonSceneCount: 7, contextSceneCount: 4, genericSceneCount: 0, personCoverageRatio: 0.667, consecutiveGenericMax: 1 });
    expect(personCoverageSummary(report)).toBe("Đúng người: 8/12 cảnh (67%) · Cảnh bối cảnh: 4/12");
  });

  it("12 scenes / 3 of the person -> block", () => {
    const report = assessPersonCoveragePreflight(scenes([P, G, P, G, G, C, P, G, G, C, G, G]));
    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(expect.arrayContaining(["coverage_below_threshold", "consecutive_non_person", "generic_majority"]));
  });

  it("scene 1 generic -> block (even with 11/12 of the person)", () => {
    const report = assessPersonCoveragePreflight(scenes([G, P, P, P, P, P, P, P, P, P, P, P]));
    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(["first_scene_not_person"]);
  });

  it("2 generic / context scenes in a row -> block; only 1 of the first 3 -> block", () => {
    expect(assessPersonCoveragePreflight(scenes([P, P, P, G, C, P, P, P, P, P])).reasons).toEqual(["consecutive_non_person"]);
    expect(assessPersonCoveragePreflight(scenes([P, C, P, C, P, P, P, P, P, P])).ok).toBe(true);
    expect(assessPersonCoveragePreflight(scenes([P, G, G, P, P, P, P, P, P, P])).reasons).toEqual(expect.arrayContaining(["first_three_scenes", "consecutive_non_person"]));
  });

  it("evidence -> media role: verified / strong = primary, weak or uncertain = support, context, generic", () => {
    expect(personMediaRoleOf({ match: "verified", identityConfidence: 0.9 })).toBe("person_primary");
    expect(personMediaRoleOf({ match: "metadata", identityConfidence: 0.75, tier: "strong_metadata" })).toBe("person_primary");
    expect(personMediaRoleOf({ match: "metadata", identityConfidence: 0.75, flags: ["frame_identity_uncertain"] })).toBe("person_support");
    expect(personMediaRoleOf({ match: "metadata", identityConfidence: 0.34 })).toBe("person_support");
    expect(personMediaRoleOf({ match: "generic", identityConfidence: 0, tier: "context", flags: ["context"] })).toBe("context");
    expect(personMediaRoleOf({ match: "generic", identityConfidence: 0, flags: ["generic"] })).toBe("generic");
    expect(personMediaRoleOf(null)).toBe("generic");
  });
});

describe("strict person media mode decision", () => {
  const script = { title: "佐々木朗希の衝撃デマ騒動の真実", scenes: [{ sceneId: "s1", narration: "佐々木朗希投手にまつわる衝撃のニュース" }, { sceneId: "s2", narration: "彼の身に何が起きたのか" }, { sceneId: "s3", narration: "朗希は元気にマウンドへ" }] };

  it("typed target person -> strict; a model person the title names and the script stays on -> strict", () => {
    expect(strictPersonModeFor(personTargetOf(resolveTargetPerson({ user: parseTargetPersonInput("佐々木朗希 / Roki Sasaki (Dodgers)")! }))!, { scenes: [] })).toBe(true);
    expect(strictPersonModeFor(personTargetOf(resolveTargetPerson({ model: roki }))!, script)).toBe(true);
  });

  it("a model person the title does not name -> not strict; env forces on / off", () => {
    const target = personTargetOf(resolveTargetPerson({ model: roki }))!;
    expect(strictPersonModeFor(target, { title: "プロ野球の噂話", scenes: [{ sceneId: "s1", narration: "噂が広がる" }] })).toBe(false);
    expect(strictPersonModeFor(target, { scenes: [] }, { STRICT_PERSON_MEDIA_MODE: "1" })).toBe(true);
    expect(strictPersonModeFor(target, script, { STRICT_PERSON_MEDIA_MODE: "off" })).toBe(false);
  });
});

const shot = (overrides: Partial<VisionShotFindings> = {}): VisionShotFindings => ({ peopleCount: 1, closeUp: true, textCoverage: "none", logo: false, newsCard: false, ...overrides });
const candidate = (id: string, text: string, query: string, vision?: { shot?: VisionShotFindings; identity?: VisionIdentityFindings }): MediaCandidate => {
  const findings: VisionFindings | null = vision ? { decision: "accepted", confidence: 0.9, reasonCodes: [], sceneBeatRelevance: 0.7, safetyFindings: [], provider: "gemini", model: "m", operation: "image_moderation", version: "v", evidenceRefs: [], decidedAt: "2026-10-09T00:00:00.000Z", ...vision } : null;
  return {
    candidateId: id, source: "pexels", externalId: id, mediaType: "video", accessMethod: "api_download", previewUrl: `https://x/${id}.jpg`, durationSeconds: 12, widthPx: 1080, heightPx: 1920, attribution: { name: "u" },
    provenance: { query, providerAccountId: "a", queriedAt: "2026-10-09T00:00:00.000Z" }, rightsStatus: "cleared", capabilityEvidence: null, metadataScore: 0, descriptorText: text || null, visionFindings: findings, relevanceScore: 0, moderationDecision: findings ? "accepted" : null, eligibility: { autoEligible: true },
  };
};

describe("strict person ranking", () => {
  const strictBrief = () =>
    applySubjectToBrief(
      deriveSceneBrief({ language: "ja", scenes: [{ sceneId: "s1", narration: "佐々木朗希投手", screenText: "", visualQuery: "Roki Sasaki pitching", durationHintMs: 6000 }] }, 0),
      subjectProfileOf({ keywords: { subject: roki.main, aliases: roki.aliases, mustInclude: roki.mustInclude, subjectKind: "person", personStrict: true } }),
      { priority: 1 },
    );

  it("verified exact > strong match > single probable > directly related context; generic unrelated rejected", () => {
    const pool = [
      candidate("generic_phone", "hand scrolling phone", "smartphone news"),
      candidate("context_stadium", "", "Dodgers"),
      candidate("single", "朗希 #ドジャース", "q", { shot: shot() }),
      candidate("strong", "佐々木朗希 投球", "q"),
      candidate("verified", "Roki Sasaki pitch", "q", { shot: shot(), identity: { match: "match", confidence: 0.92 } }),
    ];
    const ranked = rankMediaCandidates(pool, strictBrief());
    expect(ranked.map((entry) => [entry.candidate.candidateId, entry.person?.tier])).toEqual([
      ["verified", "verified"],
      ["strong", "strong_metadata"],
      ["single", "single_portrait"],
      ["context_stadium", "context"],
      ["generic_phone", "rejected"],
    ]);
    expect(ranked[4]).toMatchObject({ combinedScore: 0, excludedReason: "person_generic_unrelated" });
  });

  it("wrong person -> rejected even when perfectly clean (vision different_person)", () => {
    const wrong = candidate("wrong", "#佐々木朗希 #ドジャース", "q", { shot: shot(), identity: { match: "different_person", confidence: 0.88 } });
    const ranked = rankMediaCandidates([wrong], strictBrief());
    expect(ranked[0]).toMatchObject({ combinedScore: 0, excludedReason: "person_wrong_person" });
    expect(decideMediaSelection(ranked).decision).toBe("needs_input");
  });

  it("only generic stock left (Apify out of quota) -> nothing of the person is auto-picked in strict mode", () => {
    const ranked = rankMediaCandidates([candidate("phone", "hand holding iphone", "smartphone"), candidate("street", "city street", "street")], strictBrief());
    expect(decideMediaSelection(ranked).decision).toBe("needs_input");
  });

  it("non-strict keeps generic stock as a last-resort backdrop (unchanged behaviour)", () => {
    const target = personTargetOf(resolveTargetPerson({ model: roki }))!;
    expect(scorePersonCandidate(target, { text: "city street", mediaType: "video" }).tier).toBe("generic");
    expect(scorePersonCandidate({ ...target, strict: true }, { text: "city street", mediaType: "video" })).toMatchObject({ tier: "rejected", rejectionReason: "person_generic_unrelated", hardReject: true });
  });
});

describe("quality gate in strict person mode", () => {
  const gateScene = (sceneId: string, mediaRole: PersonMediaRole): QualityGateScene => ({ sceneId, segmentId: sceneId, assetId: null, kind: null, sourceStartMs: null, sourceDurationMs: null, sceneDurationMs: 4000, narration: "x", personMatch: mediaRole === P || mediaRole === S ? "metadata" : "generic", mediaRole, identityConfidence: mediaRole === P ? 0.8 : 0, verificationMethod: mediaRole === P ? "metadata" : "none" });
  const build = (roles: PersonMediaRole[], strict: boolean) => runQualityGate({ scenes: roles.map((role, i) => gateScene(`s${i + 1}`, role)), assets: [], targetSec: roles.length * 4, person: { name: "佐々木朗希", focus: null, strict } });

  it("insufficient coverage blocks the render with person_media_insufficient (strict) and only warns otherwise", () => {
    const strict = build([G, G, C, G, G, G, P, G, G, G], true);
    expect(strict.failure?.code).toBe("person_media_insufficient");
    expect(strict.failure?.reason).toContain("Không đủ hình/video đúng người mục tiêu để dựng video.");
    expect(strict.failure?.reason).toContain("Đúng người: 1/10 cảnh (10%)");
    expect(strict.personMedia?.coverage?.scenes[0]).toMatchObject({ sceneId: "s1", targetPerson: "佐々木朗希", mediaRole: "generic", verificationMethod: "none" });
    expect(build([G, G, C, G, G, G, P, G, G, G], false).failure).toBeNull();
  });

  it("sufficient coverage passes (8/12)", () => {
    const ok = build([P, P, C, P, S, C, P, P, C, P, P, C], true);
    expect(ok.failure).toBeNull();
    expect(ok.checks.find((check) => check.name === "person_coverage")).toMatchObject({ status: "ok" });
  });
});
