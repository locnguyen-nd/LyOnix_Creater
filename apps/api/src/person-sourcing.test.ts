import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rankMediaCandidates, deriveSceneBrief, applySubjectToBrief, subjectProfileOf, type MediaCandidate, type PlannedSegment } from "@lyonix/domain";
import { MediaPlanService, SegmentSourceLedger, personBackdropQueries, segmentPersonDiagnostics, withPersonEvidence, type MediaPlanScript, type SegmentSource } from "./media-plan.service.js";
import { personQualityOf, type ApifyService } from "./apify.service.js";
import type { PexelsService } from "./pexels.service.js";
import { personGateInput } from "./workflow-runner.service.js";
import { parseTargetPersonIntake, readTargetPersonIntake } from "./target-person-intake.js";
import { personTargetOf, resolveTargetPerson, parseTargetPersonInput } from "@lyonix/domain";

// VE2E-151: person-focused sourcing (the video's subject is one person). STUBS only - not evidence of live Apify / Pexels / vision.
vi.mock("./quarantine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./quarantine.js")>()),
  writeQuarantineFile: vi.fn(async (buffer: Buffer) => ({ quarantineToken: "quarantine-token", sha256: "x", bytes: buffer.byteLength })),
}));

const NAMES = ["lee felix", "felix", "フィリックス", "stray kids", "スキズ"];
const namesPerson = (text: string) => NAMES.some((name) => text.toLowerCase().includes(name));

const script = (kind: string = "person"): MediaPlanScript => ({
  language: "ja",
  scenes: Array.from({ length: 4 }, (_, i) => ({ sceneId: `s${i + 1}`, narration: `フィリックス ${i}`, screenText: `t${i}`, visualQuery: `Felix close up ${i}`, durationHintMs: 5000, voiceDurationMs: 5000 })),
  visualPlan: {
    segments: [
      { segmentId: "g1", sceneIds: ["s1", "s2"], subject: "Felix", priority: 1, keywords: { ja: "フィリックス 直カム", en: "Lee Felix stage performance", broadEn: ["Stray Kids Felix concert"], moodEn: "concert stage lights" } },
      { segmentId: "g2", sceneIds: ["s3", "s4"], subject: "Felix", priority: 1, keywords: { ja: "フィリックス ダンス", en: "Felix dance practice", broadEn: ["Felix dance studio"], moodEn: "dance studio mirror" } },
    ],
    videoSubject: { main: "Lee Felix", kind, aliases: ["フィリックス", "Felix"], mustInclude: ["Stray Kids", "スキズ"], mustExclude: [], otherPeople: ["Hyunjin"] },
  } as never,
});

const apifyHit = (id: string, match: "verified" | "metadata") => ({
  ok: true as const,
  data: {
    asset: { id: `asset-${id}`, kind: "video", durationMs: 60_000 } as never,
    externalId: id,
    ledgerId: `apify:tiktok:${id}`,
    platform: "tiktok" as const,
    provenance: null,
    quality: {
      person: { identity: "strong", score: 0.9, match, flags: ["close_up"], tier: match === "verified" ? "verified" : "strong_metadata", identityConfidence: match === "verified" ? 0.92 : 0.75, verificationMethod: match === "verified" ? "vision" : "metadata", framing: "single" },
      personRejected: { person_wrong_person: 2 },
    } as never,
  },
});
const pexelsHit = (id: string) => ({ ok: true as const, data: { asset: { id: `pexels-asset-${id}`, kind: "video", durationMs: 30_000 }, externalId: id } });

function setup(apifyImpl: (input: any) => any, pexelsImpl: (input: any) => any = () => ({ ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", message: "none" })) {
  const apify = { findAccountForUser: vi.fn(async () => ({ id: "apify-acc", encryptedSecret: "enc" })), autoImportForSegment: vi.fn(async (...args: any[]) => apifyImpl(args[4])) };
  const pexels = { autoImportForScene: vi.fn(async (...args: any[]) => pexelsImpl(args[3])) };
  const media = { registerAsset: vi.fn(async () => ({ id: "brand-bg", kind: "image" })) };
  const service = new MediaPlanService({ mediaAssetVersion: { findFirst: async () => null }, providerAccount: { findFirst: async () => null } } as never, {} as never, pexels as unknown as PexelsService, apify as unknown as ApifyService, undefined, media as never);
  return { service, apify, pexels };
}

describe("VE2E-151 person-focused sourcing (stubs)", () => {
  beforeEach(() => { process.env.APIFY_VIDEO_PLATFORMS = "tiktok"; process.env.MEDIA_SEGMENT_DEADLINE_MS = "3000"; });
  afterEach(() => { delete process.env.APIFY_VIDEO_PLATFORMS; delete process.env.MEDIA_SEGMENT_DEADLINE_MS; });

  it("the Apify tiers get the person target in the brief; the chosen clip carries its person match into the diagnostics", async () => {
    const { service, apify } = setup((input) => (input.sceneId === "s1" && !input.lang ? apifyHit("v1", "verified") : input.sceneId === "s3" && !input.lang ? apifyHit("v2", "metadata") : { ok: false, reason: "apify_no_usable_candidate" }));
    const planned = service.planSegments(script(), null);
    const result = await service.sourceSegments("p1", "u", "staff", { providerAccountId: "p", script: script(), segments: planned, ledger: new SegmentSourceLedger(), guaranteeSource: true });
    const briefs = apify.autoImportForSegment.mock.calls.map((call) => (call as any[])[4].brief as { person?: { name: string; context: string[] } });
    expect(briefs.every((brief) => brief.person?.name === "Lee Felix")).toBe(true);
    expect(briefs[0]!.person!.context).toEqual(["Stray Kids", "スキズ"]);
    const bySegment = new Map(result.sourced.map((entry) => [entry.segment.segmentId, entry.source!]));
    expect(bySegment.get("g1")?.personEvidence).toMatchObject({ match: "verified", verificationMethod: "vision", identityConfidence: 0.92, flags: ["close_up"] });
    expect(bySegment.get("g2")?.personEvidence).toMatchObject({ match: "metadata", verificationMethod: "metadata" });
    const diagnostics = service.buildBindings(script(), result.sourced).diagnostics;
    expect(diagnostics.map((entry) => entry.person?.match)).toEqual(["verified", "metadata"]);
    expect(diagnostics[0]!.person).toMatchObject({ targetPerson: "Lee Felix", targetSource: "model", tier: "verified", identityConfidence: 0.92, verificationMethod: "vision", rejected: { person_wrong_person: 2 }, framing: "single" });
    expect(diagnostics[0]!.person?.rejectionReason).toBeUndefined();
  });

  it("Pexels (stock) searches the BACKDROP without the person's names and is recorded as generic", async () => {
    const { service, pexels } = setup(() => ({ ok: false, reason: "apify_no_usable_candidate" }), (input) => pexelsHit(`px-${input.sceneId}`));
    const planned = service.planSegments(script(), null);
    const result = await service.sourceSegments("p1", "u", "staff", { providerAccountId: "p", script: script(), segments: planned, ledger: new SegmentSourceLedger(), guaranteeSource: true });
    const calls = pexels.autoImportForScene.mock.calls.map((call) => (call as any[])[3] as { query: string; sceneBrief: { phrases: string[] } });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(namesPerson(call.query)).toBe(false);
      expect(call.sceneBrief.phrases).toEqual([call.query]); // the brief's own phrases name the person: never sent to stock
    }
    expect(calls.map((call) => call.query)).toEqual(expect.arrayContaining(["stage performance", "dance practice"]));
    expect(result.sourced.every((entry) => entry.source?.personEvidence?.match === "generic")).toBe(true);
    const diagnostics = service.buildBindings(script(), result.sourced).diagnostics;
    expect(diagnostics[0]!.person).toMatchObject({ match: "generic", verificationMethod: "none", identityConfidence: 0 });
    expect(diagnostics[0]!.person?.rejectionReason).toBeTruthy(); // why no source of the person was found
  });

  it("a non-person subject keeps the subject-anchored Pexels queries and records no person match", async () => {
    const { service, pexels } = setup(() => ({ ok: false, reason: "apify_no_usable_candidate" }), (input) => pexelsHit(`px-${input.sceneId}`));
    const group = script("group");
    const result = await service.sourceSegments("p1", "u", "staff", { providerAccountId: "p", script: group, segments: service.planSegments(group, null), ledger: new SegmentSourceLedger(), guaranteeSource: true });
    const queries = pexels.autoImportForScene.mock.calls.map((call) => ((call as any[])[3] as { query: string }).query);
    expect(queries.some(namesPerson)).toBe(true);
    expect(result.sourced.every((entry) => entry.source?.personEvidence === undefined)).toBe(true);
    expect(service.buildBindings(group, result.sourced).diagnostics.every((entry) => entry.person === undefined)).toBe(true);
  });
});

describe("VE2E-151 helpers", () => {
  const segment = (kind?: string): PlannedSegment => ({
    segmentId: "g1",
    sceneIds: ["s1"],
    subject: "Felix",
    priority: 1,
    durationMs: 5000,
    origin: "visual_plan",
    keywords: { ja: "", en: "Lee Felix stage performance", broadEn: ["Felix"], moodEn: "concert stage lights", subject: "Lee Felix", aliases: ["Felix"], mustInclude: ["Stray Kids"], ...(kind ? { subjectKind: kind } : {}) },
  }) as PlannedSegment;
  const source = (overrides: Partial<SegmentSource>): SegmentSource => ({ mediaAssetVersionId: "a", kind: "video", durationMs: 1000, externalId: null, sourcing: "imported", ...overrides });

  it("personBackdropQueries: names stripped, one-word leftovers dropped, mood kept; null for a non-person subject", () => {
    expect(personBackdropQueries(segment("person"))).toEqual(["stage performance", "concert stage lights"]);
    expect(personBackdropQueries(segment())).toBeNull();
  });

  it("withPersonEvidence: stock / placeholder = generic, social / library = metadata, a ranked match is kept, non-person untouched", () => {
    const person = segment("person");
    const ranked = { match: "verified" as const, identityConfidence: 0.9, verificationMethod: "vision" as const, flags: [] };
    expect(withPersonEvidence(person, source({ provider: "pexels" })).personEvidence?.match).toBe("generic");
    expect(withPersonEvidence(person, source({ degraded: "brand_background", placeholder: true })).personEvidence?.match).toBe("generic");
    expect(withPersonEvidence(person, source({ provider: "social", tier: "shorts" })).personEvidence?.match).toBe("metadata");
    expect(withPersonEvidence(person, source({ tier: "library" })).personEvidence).toMatchObject({ match: "metadata", verificationMethod: "metadata" });
    expect(withPersonEvidence(person, source({ provider: "apify", personEvidence: ranked })).personEvidence).toBe(ranked);
    expect(withPersonEvidence(segment(), source({ provider: "pexels" })).personEvidence).toBeUndefined();
  });

  it("segment diagnostics: target, who named it, the identity evidence, and why nothing of the person was found", () => {
    const target = personTargetOf(resolveTargetPerson({ user: parseTargetPersonInput("Lee Felix (Stray Kids)")! }))!;
    const generic = segmentPersonDiagnostics(target, source({ provider: "pexels", personEvidence: { match: "generic", identityConfidence: 0, verificationMethod: "none", flags: ["generic"] }, apifyQuality: { personRejected: { person_wrong_person: 3, person_news_card: 1 } } as never }), null);
    expect(generic).toMatchObject({ targetPerson: "Lee Felix", targetSource: "user", match: "generic", identityConfidence: 0, verificationMethod: "none", rejected: { person_wrong_person: 3, person_news_card: 1 }, rejectionReason: "person_wrong_person" });
    expect(segmentPersonDiagnostics(target, null, "MEDIA_RELEVANCE_BELOW_THRESHOLD").rejectionReason).toBe("MEDIA_RELEVANCE_BELOW_THRESHOLD");
  });

  it("personGateInput is only built for a person subject; the typed person outranks the script's own subject", () => {
    expect(personGateInput(script(), "t")?.target.name).toBe("Lee Felix");
    expect(personGateInput(script("team"), "t")).toBeNull();
    const typed = personGateInput(script("team"), "t", { user: parseTargetPersonInput("Hyunjin / ヒョンジン")!, newsText: null });
    expect(typed?.target).toMatchObject({ name: "Hyunjin", source: "user" });
  });

  it("submit intake: typed person + news text validated and stored; read back tolerantly", () => {
    const ok = parseTargetPersonIntake("Lee Felix / フィリックス (Stray Kids)", "  Stray Kids フィリックス 活動再開  ");
    expect(ok).toEqual({ ok: true, value: { user: { main: "Lee Felix", aliases: ["フィリックス"], context: ["Stray Kids"] }, newsText: "Stray Kids フィリックス 活動再開" } });
    expect(parseTargetPersonIntake("", undefined)).toEqual({ ok: true, value: null });
    expect(parseTargetPersonIntake("x", undefined).ok).toBe(false);
    expect(parseTargetPersonIntake(42, undefined).ok).toBe(false);
    expect(readTargetPersonIntake(ok.ok ? ok.value : null)).toEqual({ user: { main: "Lee Felix", aliases: ["フィリックス"], context: ["Stray Kids"] }, newsText: "Stray Kids フィリックス 活動再開" });
    expect(readTargetPersonIntake(null)).toEqual({ user: null, newsText: null });
    expect(readTargetPersonIntake({ user: { main: 3 } })).toEqual({ user: null, newsText: null });
  });

  it("user target overrides the model in the media plan, even without a visualPlan (fallback segments get the person)", () => {
    const { service } = setup(() => ({ ok: false, reason: "apify_no_usable_candidate" }));
    const typed = resolveTargetPerson({ user: parseTargetPersonInput("Hyunjin / ヒョンジン (Stray Kids)")!, model: { kind: "person", main: "Lee Felix" } })!;
    const withPlan = service.planSegments(script(), null, typed);
    expect(withPlan.every((planned) => (planned.keywords as { subject?: string; targetSource?: string }).subject === "Hyunjin" && (planned.keywords as { targetSource?: string }).targetSource === "user")).toBe(true);
    const noPlan = { ...script(), visualPlan: null };
    const fallback = service.planSegments(noPlan, null, typed);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.every((planned) => planned.origin === "fallback" && planned.subject === "Hyunjin")).toBe(true);
    expect(service.planSegments(noPlan, null).every((planned) => planned.keywords === null)).toBe(true); // unchanged without a target
  });

  it("personQualityOf summarises the chosen candidate's person ranking", () => {
    const brief = applySubjectToBrief(deriveSceneBrief({ language: "ja", scenes: [{ sceneId: "s1", narration: "フィリックス", screenText: "", visualQuery: "Felix", durationHintMs: 5000 }] }, 0), subjectProfileOf(segment("person")), { priority: 1 });
    const candidate = { candidateId: "c1", source: "apify", externalId: "1", mediaType: "video", accessMethod: "api_download", previewUrl: "https://x/p.jpg", durationSeconds: 10, widthPx: 1080, heightPx: 1920, attribution: null, provenance: { query: "q", providerAccountId: "a", queriedAt: "2026-10-09T00:00:00.000Z" }, rightsStatus: "owner_accepted_risk", capabilityEvidence: null, metadataScore: 0, descriptorText: "Lee Felix fancam", visionFindings: null, relevanceScore: 0, moderationDecision: null, eligibility: { autoEligible: true } } as MediaCandidate;
    expect(personQualityOf(rankMediaCandidates([candidate], brief), "c1")).toMatchObject({ identity: "strong", match: "metadata", flags: ["close_up"] });
    expect(personQualityOf(rankMediaCandidates([candidate], { ...brief, person: undefined } as never), "c1")).toBeUndefined();
  });
});
