import { describe, expect, it } from "vitest";
import type { MediaCandidate, VisionFindings, VisionIdentityFindings, VisionShotFindings } from "./media-candidate.js";
import { decideMediaSelection, deriveSceneBrief, rankMediaCandidates, type SceneBrief } from "./media-ranking.js";
import {
  assessPersonMediaCoverage,
  assessScriptPersonFocus,
  matchPersonIdentity,
  personMetadataFlags,
  personNameVariants,
  parseTargetPersonInput,
  personMatchLevelOf,
  personTargetOf,
  resolveTargetPerson,
  scorePersonCandidate,
  stripHonorifics,
  stripPersonNames,
} from "./person-target.js";
import { runQualityGate, type QualityGateScene } from "./quality-gate.js";
import { evaluateSocialCandidate, type SocialCandidateSignals } from "./social-candidate-filter.js";
import { selectSocialSearchItems, type SocialSearchCandidate } from "./social-search-select.js";
import { applySubjectToBrief, subjectProfileOf } from "./subject-filter.js";

const felixSubject = { kind: "person", main: "Lee Felix", aliases: ["フィリックス", "Felix", "이용복"], mustInclude: ["Stray Kids", "スキズ"], mustExclude: [], otherPeople: ["Hyunjin", "Bang Chan"] };
const felix = personTargetOf(felixSubject)!;
const ohtani = personTargetOf({ kind: "person", main: "大谷翔平選手", aliases: ["Shohei Ohtani"], mustInclude: ["Dodgers"] })!;

describe("person target: normalization", () => {
  it("only a `kind: person` subject is a person target (a team / an event keeps the plain subject rules)", () => {
    expect(personTargetOf({ kind: "team", main: "Stray Kids" })).toBeNull();
    expect(personTargetOf({ main: "Lee Felix" })).toBeNull(); // plans written before `kind` existed
    expect(personTargetOf({ kind: "person", main: "  " })).toBeNull();
  });

  it("strips honorifics / titles and splits strong (full name) from weak (one part) spellings", () => {
    expect(stripHonorifics("大谷翔平選手")).toBe("大谷翔平");
    expect(stripHonorifics("Mr. Kim")).toBe("Kim");
    expect(stripHonorifics("様")).toBe("様"); // never shortened to nothing
    expect(personNameVariants("キリアン・エムバペ")).toEqual({ strong: ["キリアン エムバペ"], weak: ["キリアン", "エムバペ"] });
    expect(personNameVariants("Lee Felix")).toEqual({ strong: ["Lee Felix", "Felix Lee"], weak: ["Lee", "Felix"] });
    expect(felix.strongNames).toEqual(["Lee Felix", "Felix Lee", "이용복"]);
    expect(felix.weakNames).toEqual(["Lee", "Felix", "フィリックス"]);
    expect(ohtani.name).toBe("大谷翔平");
    expect(ohtani.strongNames).toContain("大谷翔平");
    expect(felix.others).toEqual(["Hyunjin", "Bang Chan"]);
  });
});

describe("person target: identity of a candidate", () => {
  it("full name = strong; a short name needs the group/team context (same-name people); author only = weak evidence", () => {
    expect(matchPersonIdentity(felix, { text: "Lee Felix fancam 4K" }).level).toBe("strong");
    expect(matchPersonIdentity(felix, { text: "#leefelix #skz" }).level).toBe("strong"); // hashtags glue the words
    expect(matchPersonIdentity(felix, { text: "Felix dance practice #straykids" }).level).toBe("context");
    expect(matchPersonIdentity(felix, { text: "フィリックス かわいい スキズ" }).level).toBe("context");
    const sameName = matchPersonIdentity(felix, { text: "Felix the cat cartoon compilation" });
    expect(sameName.level).toBe("weak");
    expect(sameName.score).toBeLessThan(matchPersonIdentity(felix, { text: "Felix stray kids" }).score);
    expect(matchPersonIdentity(felix, { text: "dance practice", author: "felix_fanpage" }).level).toBe("author");
    expect(matchPersonIdentity(felix, { text: "sleep routine" }).level).toBe("none"); // "Lee" is matched as a whole word only
  });

  it("romaji long vowels and diacritics match on both sides (Ohtani / Otani / Ōtani)", () => {
    expect(matchPersonIdentity(ohtani, { text: "Shohei Otani home run" }).level).toBe("strong");
    expect(matchPersonIdentity(ohtani, { text: "SHŌHEI ŌTANI" }).level).toBe("strong");
    expect(matchPersonIdentity(ohtani, { text: "大谷翔平 ホームラン" }).level).toBe("strong");
  });

  it("metadata hints: news / text card / group / close-up / slideshow / another person", () => {
    expect(personMetadataFlags(felix, { text: "【速報】Felix 活動休止", author: "news_jp" })).toContain("news");
    expect(personMetadataFlags(felix, { text: "Felix quotes that hit different" })).toContain("text_card");
    expect(personMetadataFlags(felix, { text: "Stray Kids members group photo" })).toContain("group");
    expect(personMetadataFlags(felix, { text: "Felix fancam 直カム" })).toContain("close_up");
    expect(personMetadataFlags(felix, { text: "Felix slideshow" })).toContain("slideshow");
    expect(personMetadataFlags(felix, { text: "Hyunjin solo stage" })).toContain("other_person");
    expect(personMetadataFlags(felix, { text: "Lee Felix with Hyunjin" })).not.toContain("other_person"); // the target is named in full
  });
});

const shot = (overrides: Partial<VisionShotFindings> = {}): VisionShotFindings => ({ peopleCount: 1, closeUp: true, textCoverage: "none", logo: false, newsCard: false, ...overrides });

describe("person target: candidate score", () => {
  it("solo close-up > texty solo > group > news card; a vision news card or an empty frame naming the person is excluded", () => {
    const solo = scorePersonCandidate(felix, { text: "Lee Felix fancam", mediaType: "video", shot: shot() });
    const group = scorePersonCandidate(felix, { text: "Lee Felix with members", mediaType: "video", shot: shot({ peopleCount: 6, closeUp: false }) });
    const texty = scorePersonCandidate(felix, { text: "Lee Felix", mediaType: "video", shot: shot({ textCoverage: "heavy", logo: true }) });
    expect(solo.score).toBeGreaterThan(texty.score); // same tier (strong metadata, one person): the cleaner frame wins
    expect(texty.score).toBeGreaterThan(group.score); // tier first: one named person (even with text) > a group photo
    expect([solo.tier, texty.tier, group.tier]).toEqual(["strong_metadata", "strong_metadata", "group"]);
    expect(scorePersonCandidate(felix, { text: "Lee Felix", mediaType: "photo", shot: shot({ newsCard: true }) })).toMatchObject({ tier: "rejected", rejectionReason: "person_news_card", hardReject: true, score: 0 });
    expect(scorePersonCandidate(felix, { text: "Lee Felix", mediaType: "photo", shot: shot({ peopleCount: 0, closeUp: false }) })).toMatchObject({ rejectionReason: "person_not_visible", hardReject: true });
    // A shot description alone is not an identity verification: metadata + one person in frame stays strong_metadata.
    expect(solo).toMatchObject({ tier: "strong_metadata", verificationMethod: "metadata" });
  });

  it("generic stock (does not name the person): an empty backdrop beats a stranger's close-up (impostor risk)", () => {
    const backdrop = scorePersonCandidate(felix, { text: "concert stage lights", mediaType: "video", shot: shot({ peopleCount: 0, closeUp: false }) });
    const stranger = scorePersonCandidate(felix, { text: "young man portrait", mediaType: "video", shot: shot() });
    expect(backdrop.score).toBeGreaterThan(stranger.score);
    expect(stranger.flags).toEqual(expect.arrayContaining(["generic", "impostor_risk"]));
    expect(backdrop).toMatchObject({ tier: "generic", verificationMethod: "none" }); // an empty backdrop is fine when it never claimed to be the person
    expect(stranger).toMatchObject({ tier: "rejected", rejectionReason: "person_impostor_risk" });
    expect(stranger.hardReject).toBeUndefined();
  });

  it("without vision the metadata hints decide: a quote / news post loses to a fancam; video beats a photo", () => {
    const fancam = scorePersonCandidate(felix, { text: "Lee Felix fancam", mediaType: "video" });
    const quote = scorePersonCandidate(felix, { text: "Lee Felix quotes", mediaType: "video" });
    const news = scorePersonCandidate(felix, { text: "Lee Felix news", mediaType: "video" });
    const photo = scorePersonCandidate(felix, { text: "Lee Felix fancam", mediaType: "photo" });
    expect(fancam.score).toBeGreaterThan(news.score);
    expect(news.score).toBeGreaterThan(quote.score);
    expect(fancam.score).toBeGreaterThan(photo.score);
  });

  it("names are stripped for stock backdrop queries", () => {
    expect(stripPersonNames("Lee Felix stage performance", felix)).toBe("stage performance");
    expect(stripPersonNames("Stray Kids Felix concert lights", felix)).toBe("concert lights");
    expect(stripPersonNames("フィリックス ライブ", felix)).toBe("ライブ");
  });
});

const media = (overrides: Partial<MediaCandidate> = {}): MediaCandidate => ({
  candidateId: "apify:video:1",
  source: "apify",
  externalId: "1",
  mediaType: "video",
  accessMethod: "api_download",
  previewUrl: "https://example.com/p/1.jpg",
  importUrl: "https://example.com/d/1.mp4",
  durationSeconds: 12,
  widthPx: 1080,
  heightPx: 1920,
  attribution: { name: "uploader" },
  provenance: { query: "q", providerAccountId: "acc", queriedAt: "2026-10-09T00:00:00.000Z" },
  rightsStatus: "owner_accepted_risk",
  capabilityEvidence: null,
  metadataScore: 0,
  descriptorText: null,
  visionFindings: null,
  relevanceScore: 0,
  moderationDecision: null,
  eligibility: { autoEligible: true },
  ...overrides,
});
const withShot = (candidate: MediaCandidate, value: VisionShotFindings): MediaCandidate => {
  const findings: VisionFindings = { decision: "accepted", confidence: 0.9, reasonCodes: [], sceneBeatRelevance: 0.7, safetyFindings: [], provider: "gemini", model: "m", operation: "image_moderation", version: "v", evidenceRefs: [], decidedAt: "2026-10-09T00:00:00.000Z", shot: value };
  return { ...candidate, visionFindings: findings, moderationDecision: "accepted" };
};

const baseBrief = (): SceneBrief =>
  deriveSceneBrief({ language: "ja", scenes: [{ sceneId: "s1", narration: "フィリックスが新曲を披露", screenText: "Felix", visualQuery: "Felix stage", durationHintMs: 8000 }] }, 0);
const personBrief = (): SceneBrief => applySubjectToBrief(baseBrief(), subjectProfileOf({ keywords: { subject: felixSubject.main, aliases: felixSubject.aliases, mustInclude: felixSubject.mustInclude, otherPeople: felixSubject.otherPeople, subjectKind: "person" } }), { priority: 1 });

describe("rankMediaCandidates in person mode", () => {
  it("the brief carries the person target only for a person subject", () => {
    expect(personBrief().person?.name).toBe("Lee Felix");
    expect(applySubjectToBrief(baseBrief(), subjectProfileOf({ keywords: { subject: "Stray Kids", subjectKind: "group" } })).person).toBeUndefined();
  });

  it("video of the person > clip about something else; single-person photo > group photo > quote card", () => {
    const brief = personBrief();
    const onTarget = media({ candidateId: "a", externalId: "a", descriptorText: "Lee Felix fancam #straykids" });
    const offTopic = media({ candidateId: "b", externalId: "b", descriptorText: "funny cat compilation" });
    const ranked = rankMediaCandidates([offTopic, onTarget], brief);
    expect(ranked.map((entry) => entry.candidate.candidateId)).toEqual(["a", "b"]);
    expect(ranked[0]!.person?.identity.level).toBe("strong");

    const photo = (id: string, text: string, value: VisionShotFindings) => withShot(media({ candidateId: id, externalId: id, mediaType: "photo", descriptorText: text }), value);
    const single = photo("single", "Lee Felix portrait", shot());
    const group = photo("group", "Lee Felix and members", shot({ peopleCount: 8, closeUp: false }));
    const quote = photo("quote", "Lee Felix quote", shot({ peopleCount: 1, closeUp: false, textCoverage: "heavy", newsCard: true }));
    const photos = rankMediaCandidates([quote, group, single], brief);
    expect(photos.map((entry) => entry.candidate.candidateId)).toEqual(["single", "group", "quote"]);
    expect(photos[2]!.excludedReason).toBe("person_news_card");
    expect(decideMediaSelection(rankMediaCandidates([quote], brief)).decision).toBe("needs_input"); // a news / quote card is never auto-picked
  });

  it("a group photo is still used when no single-person media exists (penalised, not excluded)", () => {
    const group = withShot(media({ candidateId: "g", externalId: "g", mediaType: "photo", descriptorText: "Lee Felix and members" }), shot({ peopleCount: 8, closeUp: false }));
    const decision = decideMediaSelection(rankMediaCandidates([group], personBrief()));
    expect(decision.decision).toBe("auto_select");
  });

  it("no person subject -> exactly the previous ranking (no person field, same scores)", () => {
    const brief = applySubjectToBrief(baseBrief(), subjectProfileOf({ keywords: { subject: "Lee Felix", aliases: ["Felix"] } }), { priority: 1 });
    const ranked = rankMediaCandidates([media({ descriptorText: "Lee Felix fancam" })], brief);
    expect(ranked[0]!.person).toBeUndefined();
    expect(brief.person).toBeUndefined();
  });
});

describe("script focus on the person", () => {
  const scenes = (texts: string[]) => texts.map((narration, index) => ({ sceneId: `s${index + 1}`, narration, screenText: "" }));

  it("a script about the person passes (pronouns cover the scenes that do not repeat the name)", () => {
    const focus = assessScriptPersonFocus(felix, { title: "Felix の新曲", scenes: scenes(["フィリックスが新曲を発表", "彼の声は低い", "ファンは歓喜", "フィリックスの次のステージ"]) });
    expect(focus.ok).toBe(true);
    expect(focus.coverage).toBe(0.5);
  });

  it("drift: no name in the hook, another member dominates -> fail with reasons", () => {
    const focus = assessScriptPersonFocus(felix, { title: "Stray Kids news", scenes: scenes(["Stray Kids comeback", "Hyunjin dances", "Hyunjin sings", "Hyunjin wins", "Felix waves"]) });
    expect(focus.ok).toBe(false);
    expect(focus.reasons).toEqual(expect.arrayContaining(["target_missing_in_hook", "other_person_dominates", "too_many_off_target_scenes"]));
    expect(focus.dominantOther).toBe("Hyunjin");
    expect(focus.offTargetSceneIds).toEqual(["s2", "s3", "s4"]);
  });
});

describe("person media coverage + quality gate", () => {
  const gateScene = (sceneId: string, personMatch: QualityGateScene["personMatch"], ms = 5000): QualityGateScene => ({ sceneId, segmentId: sceneId, assetId: null, kind: null, sourceStartMs: null, sourceDurationMs: null, sceneDurationMs: ms, narration: "x", ...(personMatch !== undefined ? { personMatch } : {}) });

  it("duration-weighted share of media naming the person", () => {
    const coverage = assessPersonMediaCoverage([{ durationMs: 6000, personMatch: "verified" }, { durationMs: 2000, personMatch: "metadata" }, { durationMs: 2000, personMatch: "generic" }]);
    expect(coverage).toEqual({ onTargetShare: 0.8, verifiedShare: 0.6, genericShare: 0.2, lowConfidence: false });
    expect(assessPersonMediaCoverage([{ durationMs: 1000, personMatch: "generic" }, { durationMs: 1000, personMatch: null }]).lowConfidence).toBe(true);
  });

  it("the gate warns clearly (script drift, too little media of the person); strict mode blocks the render", () => {
    const drift = assessScriptPersonFocus(felix, { scenes: [{ sceneId: "s1", narration: "Hyunjin dances" }, { sceneId: "s2", narration: "Hyunjin sings" }] });
    const input = { scenes: [gateScene("s1", "generic"), gateScene("s2", "metadata", 2000)], assets: [], targetSec: 7, person: { name: "Lee Felix", focus: drift } };
    const warned = runQualityGate(input);
    expect(warned.failure).toBeNull();
    expect(warned.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["script_off_target", "person_media_low_confidence"]));
    expect(warned.checks.find((check) => check.name === "person_media")?.status).toBe("warning");
    expect(warned.personMedia?.onTargetShare).toBeCloseTo(0.286, 3);
    const strict = runQualityGate({ ...input, config: { personStrict: true } });
    expect(strict.failure?.code).toBe("person_low_confidence");
    expect(strict.checks.find((check) => check.name === "person_media")?.status).toBe("failed");
  });

  it("no person subject -> no person checks at all", () => {
    const result = runQualityGate({ scenes: [gateScene("s1", undefined)], assets: [], targetSec: 5 });
    expect(result.checks.some((check) => check.name === "person_media" || check.name === "script_person_focus")).toBe(false);
    expect(result.personMedia).toBeUndefined();
  });
});

describe("social filters in person mode", () => {
  const tiktok = (videoId: string, text: string, hashtags: string[] = []): SocialCandidateSignals => ({ videoId, text, hashtags, textLanguage: "ja", countryCode: "1861060", isAd: false, isSponsored: false, widthPx: 1080, heightPx: 1920, durationSeconds: 20 });
  const ctx = { scriptLanguage: "ja", keyword: "フィリックス", minDurationSeconds: 8, usedVideoIds: new Set<string>(), person: felix };

  it("TikTok: a solo fancam outranks a news post and a members post with the same keyword overlap", () => {
    const score = (signals: SocialCandidateSignals) => {
      const evaluation = evaluateSocialCandidate(signals, ctx);
      return evaluation.ok ? evaluation.score : -1;
    };
    const fancam = score(tiktok("1", "フィリックス 直カム", ["straykids"]));
    const news = score(tiktok("2", "フィリックス 速報ニュース", ["straykids"]));
    const members = score(tiktok("3", "フィリックス メンバー全員", ["straykids"]));
    expect(fancam).toBeGreaterThan(news);
    expect(fancam).toBeGreaterThan(members);
  });

  const pin = (id: string, title: string, tags: string[] = []): SocialSearchCandidate => ({ url: `https://pinterest.com/pin/${id}`, externalId: id, mediaType: "image", title, description: null, uploader: null, channel: null, durationSeconds: null, width: 1000, height: 1500, viewCount: null, tags });

  it("Pinterest images: own photo of the person first, group / quote / same-name results last", () => {
    const selection = selectSocialSearchItems([pin("quote", "Felix quotes"), pin("cat", "Felix the cat"), pin("group", "Stray Kids members group photo Felix"), pin("solo", "Lee Felix selca")], {
      mediaType: "image",
      usedIds: new Set(),
      minDurationSeconds: 0,
      maxDurationSeconds: 60,
      subjectAliases: ["Lee Felix", "Felix"],
      keywords: ["Felix"],
      person: felix,
    });
    const order = selection.passed.map((entry) => entry.item.externalId);
    expect(order[0]).toBe("solo");
    expect(order.indexOf("group")).toBeLessThan(order.indexOf("quote"));
    expect(order.indexOf("solo")).toBeLessThan(order.indexOf("cat"));
  });
});

const verdict = (match: VisionIdentityFindings["match"], confidence = 0.9): VisionIdentityFindings => ({ match, confidence });

describe("VE2E-151 target person precedence (user > news > model)", () => {
  it("parses the create-form field: names / aliases, the group / team in brackets, full-width forms", () => {
    expect(parseTargetPersonInput("Lee Felix / フィリックス / 이용복 (Stray Kids)")).toEqual({ main: "Lee Felix", aliases: ["フィリックス", "이용복"], context: ["Stray Kids"] });
    expect(parseTargetPersonInput("大谷翔平選手、Shohei Ohtani（ドジャース）")).toEqual({ main: "大谷翔平", aliases: ["Shohei Ohtani"], context: ["ドジャース"] });
    expect(parseTargetPersonInput("   ")).toBeNull();
    expect(parseTargetPersonInput("x".repeat(201))).toBeNull();
  });

  it("the user's person overrides a different model subject; the model's person becomes context-only", () => {
    const user = parseTargetPersonInput("Lee Felix / フィリックス (Stray Kids)")!;
    const resolved = resolveTargetPerson({ user, model: { kind: "person", main: "Hyunjin", aliases: ["ヒョンジン"], mustInclude: ["JYP"], otherPeople: ["Bang Chan"] } })!;
    expect(resolved).toEqual({ kind: "person", main: "Lee Felix", aliases: ["フィリックス"], mustInclude: ["Stray Kids"], mustExclude: [], otherPeople: ["Hyunjin", "Bang Chan"], source: "user" });
    // Even when the model saw no person at all (a group video), the user's person is the target.
    expect(resolveTargetPerson({ user, model: { kind: "group", main: "Stray Kids" } })?.main).toBe("Lee Felix");
  });

  it("the same person named by the model keeps the model's extra spellings / context", () => {
    const resolved = resolveTargetPerson({ user: parseTargetPersonInput("Felix")!, model: { kind: "person", main: "Lee Felix", aliases: ["이용복"], mustInclude: ["Stray Kids"], otherPeople: ["Hyunjin"] } })!;
    expect(resolved.aliases).toEqual(["Lee Felix", "이용복"]);
    expect(resolved.mustInclude).toEqual(["Stray Kids"]);
    expect(resolved.otherPeople).toEqual(["Hyunjin"]);
    expect(resolved.source).toBe("user");
  });

  it("no user target: the model's person is `news` when the selected news names it, else `model`; a non-person subject is no target", () => {
    const model = { kind: "person", main: "Lee Felix", aliases: ["フィリックス"], mustInclude: ["Stray Kids"] };
    expect(resolveTargetPerson({ model, newsText: "Stray Kidsフィリックス、活動再開を発表" })?.source).toBe("news");
    expect(resolveTargetPerson({ model, newsText: "円安が進行" })?.source).toBe("model");
    expect(resolveTargetPerson({ model })?.source).toBe("model");
    expect(resolveTargetPerson({ model: { kind: "team", main: "Dodgers" } })).toBeNull();
    expect(personTargetOf(resolveTargetPerson({ user: parseTargetPersonInput("Lee Felix")! }))?.source).toBe("user");
  });

  it("same-name ambiguity: with the user's group in brackets, 'Felix' without the group is weak evidence only", () => {
    const target = personTargetOf(resolveTargetPerson({ user: parseTargetPersonInput("Felix (Stray Kids)")! }))!;
    expect(matchPersonIdentity(target, { text: "Felix #straykids dance" }).level).toBe("context");
    expect(matchPersonIdentity(target, { text: "Felix Mendelssohn piano" }).level).toBe("weak");
    const cat = scorePersonCandidate(target, { text: "Felix the cat", mediaType: "video" });
    const idol = scorePersonCandidate(target, { text: "Felix stray kids fancam", mediaType: "video" });
    expect(idol.score).toBeGreaterThan(cat.score);
    expect(cat.identityConfidence).toBeLessThan(idol.identityConfidence);
  });
});

describe("VE2E-151 identity verification (vision)", () => {
  it("tier order: verified > strong metadata > single portrait > group > generic > rejected", () => {
    const tiers = [
      scorePersonCandidate(felix, { text: "Lee Felix", mediaType: "video", shot: shot(), identity: verdict("match") }),
      scorePersonCandidate(felix, { text: "Lee Felix", mediaType: "video" }),
      scorePersonCandidate(felix, { text: "Felix #straykids selca", mediaType: "photo", shot: shot() }),
      scorePersonCandidate(felix, { text: "Lee Felix and members", mediaType: "photo", shot: shot({ peopleCount: 8, closeUp: false }) }),
      scorePersonCandidate(felix, { text: "stage lights", mediaType: "video", shot: shot({ peopleCount: 0, closeUp: false }) }),
      scorePersonCandidate(felix, { text: "Lee Felix quote", mediaType: "photo", shot: shot({ newsCard: true }) }),
    ];
    expect(tiers.map((entry) => entry.tier)).toEqual(["verified", "strong_metadata", "single_portrait", "group", "generic", "rejected"]);
    for (let i = 1; i < tiers.length; i += 1) expect(tiers[i - 1]!.score).toBeGreaterThan(tiers[i]!.score);
    expect(tiers[0]).toMatchObject({ verificationMethod: "vision", identityConfidence: 0.9 });
    expect(personMatchLevelOf(tiers[0]!)).toBe("verified");
    expect(personMatchLevelOf(tiers[1]!)).toBe("metadata");
    expect(personMatchLevelOf(tiers[4]!)).toBe("generic");
  });

  it("wrong person: a sure vision `different_person` is a hard reject even with the full name in the hashtags", () => {
    const wrong = scorePersonCandidate(felix, { text: "#leefelix #straykids", mediaType: "video", shot: shot(), identity: verdict("different_person", 0.85) });
    expect(wrong).toMatchObject({ tier: "rejected", rejectionReason: "person_wrong_person", hardReject: true, score: 0, identityConfidence: 0 });
    expect(wrong.flags).toContain("wrong_person");
    const doubtful = scorePersonCandidate(felix, { text: "#leefelix", mediaType: "video", shot: shot(), identity: verdict("different_person", 0.4) });
    expect(doubtful).toMatchObject({ tier: "rejected", rejectionReason: "person_wrong_person" });
    expect(doubtful.hardReject).toBeUndefined(); // very low score, still below the auto-pick threshold
    expect(doubtful.score).toBeLessThan(0.45);
  });

  it("uncertain: kept with a lower tier + flagged (strong metadata -> single portrait), never verified", () => {
    const unsure = scorePersonCandidate(felix, { text: "Lee Felix", mediaType: "video", shot: shot(), identity: verdict("uncertain", 0.5) });
    const weakMatch = scorePersonCandidate(felix, { text: "Lee Felix", mediaType: "video", shot: shot(), identity: verdict("match", 0.4) });
    expect(unsure).toMatchObject({ tier: "single_portrait", verificationMethod: "vision" });
    expect(unsure.flags).toContain("identity_uncertain");
    expect(weakMatch.tier).toBe("single_portrait");
    expect(unsure.identityConfidence).toBeLessThan(scorePersonCandidate(felix, { text: "Lee Felix", mediaType: "video" }).identityConfidence);
  });

  it("ranking: a vision-rejected wrong person never wins; the verified clip leads; the decision auto-selects it", () => {
    const brief = personBrief();
    const tagged = (id: string, text: string, identity: VisionIdentityFindings | null) => {
      const candidate = withShot(media({ candidateId: id, externalId: id, descriptorText: text }), shot());
      return identity ? { ...candidate, visionFindings: { ...candidate.visionFindings!, identity } } : candidate;
    };
    const ranked = rankMediaCandidates([tagged("wrong", "#leefelix #straykids", verdict("different_person")), tagged("meta", "Lee Felix", null), tagged("ok", "Felix stage", verdict("match"))], brief);
    expect(ranked.map((entry) => entry.candidate.candidateId)).toEqual(["ok", "meta", "wrong"]);
    expect(ranked[2]).toMatchObject({ combinedScore: 0, excludedReason: "person_wrong_person" });
    const decision = decideMediaSelection(ranked);
    expect(decision.decision === "auto_select" && decision.chosen.candidateId).toBe("ok");
    expect(decideMediaSelection(rankMediaCandidates([tagged("wrong", "#leefelix", verdict("different_person"))], brief)).decision).toBe("needs_input");
  });

  it("vision unavailable (no findings at all): the metadata tiers rank and the job is never blocked", () => {
    const brief = personBrief();
    const ranked = rankMediaCandidates([media({ candidateId: "group", externalId: "g", descriptorText: "Lee Felix members" }), media({ candidateId: "solo", externalId: "s", descriptorText: "Lee Felix fancam" })], brief);
    expect(ranked.map((entry) => [entry.candidate.candidateId, entry.person?.tier, entry.person?.verificationMethod])).toEqual([
      ["solo", "strong_metadata", "metadata"],
      ["group", "group", "metadata"],
    ]);
    expect(decideMediaSelection(ranked).decision).toBe("auto_select");
  });
});
