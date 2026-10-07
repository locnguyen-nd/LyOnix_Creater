import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPlanService, SegmentSourceLedger, apifyAutoPlatformFromEnv, apifyAutoPlatformsFromEnv, apifyImagePlatformsFromEnv, apifyKeywordForSegment, apifyLedgerIdFromFileName, applyExtractedKeywords, segmentNarration, segmentsNeedingKeywords, type MediaPlanScript } from "./media-plan.service.js";
import type { ApifyService } from "./apify.service.js";
import type { PexelsService } from "./pexels.service.js";

const projectId = "project-1";
const userId = "user-1";

const plan = (ja: string, en = "tokyo night") => ({
  segments: [{ segmentId: "g1", sceneIds: ["s1", "s2"], subject: "夜の東京", priority: 1, keywords: { ja, en }, styleHints: { setting: "", timeOfDay: "", lighting: "", palette: "" } }],
});
const script = (ja = "東京 夜景"): MediaPlanScript => ({
  language: "ja",
  scenes: [
    { sceneId: "s1", narration: "一つ目。", screenText: "one", visualQuery: "tokyo street", durationHintMs: 5000, voiceDurationMs: 4000 },
    { sceneId: "s2", narration: "二つ目。", screenText: "two", visualQuery: "ramen shop", durationHintMs: 5000, voiceDurationMs: 3000 },
  ],
  visualPlan: plan(ja),
});

const apifyOk = {
  ok: true as const,
  data: {
    asset: { id: "apify-asset-1", kind: "video", durationMs: 12_000 } as any,
    externalId: "7001",
    ledgerId: "apify:tiktok:7001",
    platform: "tiktok" as const,
    provenance: { platform: "tiktok", actorId: "clockworks/tiktok-scraper", actorVersion: "0.0.611", actorRole: "primary" as const, runId: "run1", datasetItemIndex: 0, sourceUrl: "https://www.tiktok.com/@u/video/7001", author: "creator", fetchedAt: "2026-09-30T00:00:00.000Z" },
  },
};

describe("MediaPlanService - Apify first (VE2E-46)", () => {
  let pexels: { autoImportForScene: ReturnType<typeof vi.fn> };
  let apify: { findAccountForUser: ReturnType<typeof vi.fn>; autoImportForSegment: ReturnType<typeof vi.fn> };
  let service: MediaPlanService;
  const prisma: any = { project: { findUnique: async () => ({ id: projectId }) }, mediaAssetVersion: { findFirst: async () => null } };
  const grants: any = { forUser: async () => ({ teamIds: [], projectIds: [projectId], channelIds: [] }) };

  const firstSegment = (svc: MediaPlanService, s: MediaPlanScript) => svc.planSegments(s, { min: 1, max: 1 })[0]!;

  beforeEach(() => {
    process.env.APIFY_VIDEO_PLATFORMS = "tiktok";
    pexels = { autoImportForScene: vi.fn(async () => ({ ok: true as const, data: { asset: { id: "pexels-asset-1", kind: "video", durationMs: 30_000 } as any, externalId: "ext-1" } })) };
    apify = { findAccountForUser: vi.fn(async () => ({ id: "apify-acc", encryptedSecret: "enc" })), autoImportForSegment: vi.fn(async () => apifyOk) };
    service = new MediaPlanService(prisma, grants, pexels as unknown as PexelsService, apify as unknown as ApifyService);
  });

  afterEach(() => { delete process.env.APIFY_AUTO_PLATFORM; delete process.env.APIFY_AUTO_PLATFORMS; delete process.env.APIFY_VIDEO_PLATFORMS; delete process.env.APIFY_IMAGE_PLATFORMS; });

  it("sources the segment from Apify with keywords.ja; the Pexels result of the race is discarded (ja has priority)", async () => {
    const s = script();
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { mediaAssetVersionId: "apify-asset-1", provider: "apify", sourcing: "imported", externalId: "apify:tiktok:7001" } });
    const call = apify.autoImportForSegment.mock.calls[0]!;
    expect(call[4]).toMatchObject({ platform: "tiktok", keyword: "東京 夜景", sceneId: "s1" });
    expect(call[4].brief.phrases[0]).toBe("東京 夜景");
    expect(call[4].brief.targetDurationSeconds).toBeCloseTo(7);
  });

  it("carries per-segment provenance into the diagnostics", async () => {
    const s = script();
    const segment = firstSegment(service, s);
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment, ledger: new SegmentSourceLedger() });
    if (!outcome.ok) throw new Error("expected ok");
    const built = service.buildBindings(s, [{ segment, source: outcome.data, errorCode: null }]);
    expect(built.diagnostics[0]).toMatchObject({ sourceProvider: "apify", apifyProvenance: { platform: "tiktok", actorId: "clockworks/tiktok-scraper", actorVersion: "0.0.611", author: "creator", sourceUrl: "https://www.tiktok.com/@u/video/7001" } });
    expect(built.diagnostics[0]!.fallbackReason).toBeUndefined();
    expect(built.scenes.every((scene) => scene.mediaAssetVersionId === "apify-asset-1")).toBe(true);
  });

  it("falls back to Pexels (keywords.en) when Apify has no usable candidate, recording the reason", async () => {
    apify.autoImportForSegment.mockResolvedValue({ ok: false, reason: "apify_no_usable_candidate" });
    const s = script();
    const segment = firstSegment(service, s);
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment, ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { mediaAssetVersionId: "pexels-asset-1", provider: "pexels", fallbackReason: "apify_no_usable_candidate" } });
    // at most 3 searches per segment (ja, en, broad), one call each
    expect(apify.autoImportForSegment).toHaveBeenCalledTimes(3);
    expect(pexels.autoImportForScene.mock.calls[0]![3].sceneBrief.phrases[0]).toBe("tokyo night");
    if (!outcome.ok) return;
    expect(service.buildBindings(s, [{ segment, source: outcome.data, errorCode: null }]).diagnostics[0]).toMatchObject({ sourceProvider: "pexels", fallbackReason: "apify_no_usable_candidate" });
  });

  it("falls back to Pexels when the Apify call throws or errors", async () => {
    apify.autoImportForSegment.mockRejectedValue(new Error("boom"));
    const s = script();
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "apify_error:unexpected" } });
    apify.autoImportForSegment.mockResolvedValue({ ok: false, reason: "apify_error:PROVIDER_TIMEOUT" });
    const again = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(again).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "apify_error:PROVIDER_TIMEOUT" } });
  });

  it("no Apify account: Pexels path, Apify is never searched, reason no_apify_account is recorded", async () => {
    apify.findAccountForUser.mockResolvedValueOnce(null);
    const s = script();
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels" } });
    expect(outcome.ok && outcome.data.fallbackReason).toBe("no_apify_account");
    expect(apify.autoImportForSegment).not.toHaveBeenCalled();
    if (!outcome.ok) return;
    const segment = firstSegment(service, s);
    expect(service.buildBindings(s, [{ segment, source: outcome.data, errorCode: null }]).diagnostics[0]).toMatchObject({ sourceProvider: "pexels", fallbackReason: "no_apify_account" });
  });

  // VE2E-50: scene visualQuery is NEVER an Apify keyword (VE2E-48's fallback removed).
  const noPlan = (language: string): MediaPlanScript => ({ ...script(), language, visualPlan: null });
  const englishShotDescriptions = (s: MediaPlanScript) => {
    s.scenes[0]!.visualQuery = "Flashy news intro, breaking news graphic, urgent atmosphere";
    s.scenes[1]!.visualQuery = "Boxing ring center, empty ring, focus on the ropes";
    return s;
  };

  it("ja script without visualPlan and English visualQuery: visualQuery is never sent to Apify, Pexels with no_ja_keywords", async () => {
    const s = englishShotDescriptions(noPlan("ja"));
    const segment = firstSegment(service, s);
    expect(segment.keywords).toBeNull();
    expect(apifyKeywordForSegment(segment)).toBeNull();
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment, ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "no_ja_keywords" } });
    expect(apify.autoImportForSegment).not.toHaveBeenCalled();
    expect(apify.findAccountForUser).not.toHaveBeenCalled();
  });

  it("a ja keyword without kana/kanji (English) is rejected and not sent to Apify (the en/broad tiers still search)", async () => {
    apify.autoImportForSegment.mockResolvedValue({ ok: false, reason: "apify_no_usable_candidate" });
    const s = englishShotDescriptions({ ...script("Flashy news intro breaking news") });
    const segment = firstSegment(service, s);
    expect(apifyKeywordForSegment(segment)).toBeNull();
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment, ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "no_ja_keywords" } });
    expect(apify.autoImportForSegment.mock.calls.map((c: any[]) => c[4].keyword)).toEqual(["tokyo night", "夜の東京"]);
  });

  it("keywords extracted from the narration (applyExtractedKeywords) are what Apify receives; English visualQuery still never is", async () => {
    const s = englishShotDescriptions(noPlan("ja"));
    const segments = service.planSegments(s, { min: 1, max: 1 });
    expect(segmentsNeedingKeywords(segments)).toHaveLength(1);
    expect(segmentNarration(s, segments[0]!)).toBe("一つ目。 二つ目。");
    applyExtractedKeywords(segments, { [segments[0]!.segmentId]: { ja: "ボクシング 試合", en: "boxing match" }, unknown: { ja: "x", en: "y" } });
    expect(segmentsNeedingKeywords(segments)).toHaveLength(0);
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: segments[0]!, ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "apify" } });
    expect(apify.autoImportForSegment.mock.calls[0]![4].keyword).toBe("ボクシング 試合");
    // only "keyword" is the search query sent to the Actor (the brief is used locally for ranking/moderation)
    expect(apify.autoImportForSegment.mock.calls[0]![4].brief.phrases[0]).toBe("ボクシング 試合");
  });

  it("applyExtractedKeywords rejects an invalid ja and keeps the plan's own en", () => {
    const s = script("Broken english");
    const segments = service.planSegments(s, { min: 1, max: 1 });
    applyExtractedKeywords(segments, { g1: { ja: "still english", en: "x" } });
    expect(segments[0]!.keywords).toEqual({ ja: "Broken english", en: "tokyo night" });
    applyExtractedKeywords(segments, { g1: { ja: "東京 夜景", en: "other" } });
    expect(segments[0]!.keywords).toEqual({ ja: "東京 夜景", en: "tokyo night" });
  });

  it("reports whether Apify can be searched at all", async () => {
    expect(await service.apifyAvailable(userId, "staff")).toBe(true);
    apify.findAccountForUser.mockResolvedValueOnce(null);
    expect(await service.apifyAvailable(userId, "staff")).toBe(false);
    expect(await new MediaPlanService(prisma, grants, pexels as unknown as PexelsService).apifyAvailable(userId, "staff")).toBe(false);
  });

  it("non-ja script without keywords: Pexels with reason no_ja_keywords (English is never invented)", async () => {
    const s = noPlan("en");
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "no_ja_keywords" } });
    expect(apify.autoImportForSegment).not.toHaveBeenCalled();
  });

  it("no ja keyword but an en keyword: the en tier searches (never an empty keyword), Pexels wins when it finds nothing, reason recorded", async () => {
    apify.autoImportForSegment.mockResolvedValue({ ok: false, reason: "apify_no_usable_candidate" });
    const s = { ...script(""), language: "vi" };
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "no_ja_keywords" } });
    expect(apify.autoImportForSegment.mock.calls.every((c: any[]) => c[4].keyword !== "")).toBe(true);
  });

  it("is unchanged when the service is built without an ApifyService (3-argument construction)", async () => {
    const plain = new MediaPlanService(prisma, grants, pexels as unknown as PexelsService);
    const s = script();
    const outcome = await plain.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(plain, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { mediaAssetVersionId: "pexels-asset-1" } });
  });

  it("falls back when Apify returns a source an earlier segment already used, and hands Apify only plain external ids to exclude", async () => {
    const ledger = new SegmentSourceLedger();
    ledger.add({ mediaAssetVersionId: "earlier", kind: "video", durationMs: 1, externalId: "apify:tiktok:7001", sourcing: "imported" });
    ledger.add({ mediaAssetVersionId: "earlier-2", kind: "video", durationMs: 1, externalId: "555", sourcing: "imported" });
    const s = script();
    let seen: string[] = [];
    apify.autoImportForSegment.mockImplementationOnce(async (...args: any[]) => { seen = [...args[4].usedExternalIds].sort(); return apifyOk; });
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger });
    expect(seen).toEqual(["555", "7001"]);
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "apify_duplicate_or_unsupported_source" } });
  });

  it("VE2E-53: splits a segment whose short social clip cannot cover every scene and sources the rest from a second clip", async () => {
    const s: MediaPlanScript = {
      ...script(),
      scenes: [
        { sceneId: "s1", narration: "一つ目。", screenText: "one", visualQuery: "a", durationHintMs: 2000, voiceDurationMs: 2000 },
        { sceneId: "s2", narration: "二つ目。", screenText: "two", visualQuery: "b", durationHintMs: 6000, voiceDurationMs: 6000 },
      ],
    };
    let jaCalls = 0;
    apify.autoImportForSegment.mockImplementation(async (...args: any[]) => {
      if (args[4].keyword !== "東京 夜景") return { ok: false as const, reason: "apify_no_usable_candidate" };
      jaCalls += 1;
      return jaCalls === 1
        ? { ...apifyOk, data: { ...apifyOk.data, asset: { id: "short-clip", kind: "video", durationMs: 5000 }, externalId: "1", ledgerId: "apify:tiktok:1" } }
        : { ...apifyOk, data: { ...apifyOk.data, asset: { id: "long-clip", kind: "video", durationMs: 20_000 }, externalId: "2", ledgerId: "apify:tiktok:2" } };
    });
    const result = await service.sourceSegments(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segments: service.planSegments(s, { min: 1, max: 1 }), ledger: new SegmentSourceLedger() });
    expect(result.sourced.map((piece) => [piece.segment.segmentId, piece.segment.sceneIds, piece.source?.mediaAssetVersionId])).toEqual([
      ["g1", ["s1"], "short-clip"],
      ["g1-b", ["s2"], "long-clip"],
    ]);
    expect(jaCalls).toBe(2);
  });

  it("VE2E-53: keeps the single short clip when no second source can be found", async () => {
    const s: MediaPlanScript = {
      ...script(),
      scenes: [
        { sceneId: "s1", narration: "一つ目。", screenText: "one", visualQuery: "a", durationHintMs: 2000, voiceDurationMs: 2000 },
        { sceneId: "s2", narration: "二つ目。", screenText: "two", visualQuery: "b", durationHintMs: 6000, voiceDurationMs: 6000 },
      ],
    };
    apify.autoImportForSegment
      .mockResolvedValueOnce({ ...apifyOk, data: { ...apifyOk.data, asset: { id: "short-clip", kind: "video", durationMs: 5000 }, externalId: "1", ledgerId: "apify:tiktok:1" } })
      .mockResolvedValue({ ok: false as const, reason: "apify_no_usable_candidate" });
    pexels.autoImportForScene.mockResolvedValue({ ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", message: "none" });
    const result = await service.sourceSegments(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segments: service.planSegments(s, { min: 1, max: 1 }), ledger: new SegmentSourceLedger() });
    expect(result.sourced).toHaveLength(1);
    expect(result.sourced[0]).toMatchObject({ segment: { segmentId: "g1", sceneIds: ["s1", "s2"] }, source: { mediaAssetVersionId: "short-clip" } });
  });

  it("a VIDEO slot only ever searches a video platform (first configured; never an image platform), one call per tier", async () => {
    process.env.APIFY_VIDEO_PLATFORMS = "tiktok,x,pinterest";
    apify.autoImportForSegment.mockResolvedValueOnce({ ok: false, reason: "apify_abstained:low_relevance" });
    const s = script();
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: { ...firstSegment(service, s), visualKind: "video" }, ledger: new SegmentSourceLedger() });
    expect(apify.autoImportForSegment.mock.calls.map((c: any[]) => [c[4].platform, c[4].mediaType])).toEqual([["tiktok", "video"], ["tiktok", "video"], ["tiktok", "video"]]);
    expect(outcome).toMatchObject({ ok: true, data: { provider: "apify", tier: "en" } });
  });

  it("an IMAGE slot is sourced from Pinterest as a photo, and its Pexels fallback is photos only", async () => {
    apify.autoImportForSegment.mockResolvedValueOnce({ ok: true, data: { ...apifyOk.data, asset: { id: "pin-photo", kind: "image", durationMs: null }, externalId: "pin1", ledgerId: "apify:pinterest:pin1", platform: "pinterest" } });
    const s = script();
    const imageSegment = { ...firstSegment(service, s), visualKind: "image" as const };
    const ok = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: imageSegment, ledger: new SegmentSourceLedger() });
    expect(apify.autoImportForSegment.mock.calls[0]![4]).toMatchObject({ platform: "pinterest", mediaType: "image" });
    expect(ok).toMatchObject({ ok: true, data: { mediaAssetVersionId: "pin-photo", kind: "image", provider: "apify" } });

    apify.autoImportForSegment.mockResolvedValueOnce({ ok: false, reason: "apify_no_usable_candidate" });
    await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: imageSegment, ledger: new SegmentSourceLedger() });
    expect(pexels.autoImportForScene.mock.calls[0]![3]).toMatchObject({ mediaType: "image" });
  });

  it("a segment with no template kind keeps the legacy behaviour (video platforms, no Pexels media type)", async () => {
    apify.autoImportForSegment.mockResolvedValueOnce({ ok: false, reason: "apify_no_usable_candidate" });
    const s = script();
    await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(apify.autoImportForSegment.mock.calls[0]![4]).toMatchObject({ platform: "tiktok", mediaType: "video" });
    expect(pexels.autoImportForScene.mock.calls[0]![3]).not.toHaveProperty("mediaType");
  });

  it("parses the per-kind platform lists (video default tiktok then x, image default pinterest; wrong-kind platforms are ignored)", () => {
    delete process.env.APIFY_VIDEO_PLATFORMS;
    delete process.env.APIFY_AUTO_PLATFORMS;
    delete process.env.APIFY_IMAGE_PLATFORMS;
    expect(apifyAutoPlatformsFromEnv()).toEqual(["tiktok", "x"]);
    expect(apifyImagePlatformsFromEnv()).toEqual(["pinterest"]);
    process.env.APIFY_VIDEO_PLATFORMS = "pinterest, google_video, x, instagram, tiktok, x";
    expect(apifyAutoPlatformsFromEnv()).toEqual(["x", "tiktok"]);
    process.env.APIFY_IMAGE_PLATFORMS = "tiktok, google_image, pinterest";
    expect(apifyImagePlatformsFromEnv()).toEqual(["google_image", "pinterest"]);
    process.env.APIFY_VIDEO_PLATFORMS = "instagram";
    expect(apifyAutoPlatformsFromEnv()).toEqual(["tiktok", "x"]);
    delete process.env.APIFY_VIDEO_PLATFORMS;
    process.env.APIFY_AUTO_PLATFORM = "x";
    expect(apifyAutoPlatformsFromEnv()).toEqual(["x"]);
  });

  it("reads the platform from APIFY_AUTO_PLATFORM but never allows google_video or unknown values", () => {
    expect(apifyAutoPlatformFromEnv()).toBe("tiktok");
    process.env.APIFY_AUTO_PLATFORM = "pinterest";
    expect(apifyAutoPlatformFromEnv()).toBe("pinterest");
    process.env.APIFY_AUTO_PLATFORM = "google_video";
    expect(apifyAutoPlatformFromEnv()).toBe("tiktok");
    process.env.APIFY_AUTO_PLATFORM = "instagram";
    expect(apifyAutoPlatformFromEnv()).toBe("tiktok");
  });

  it("recognises Apify-registered file names so a retry reuses the segment source without a new search", async () => {
    expect(apifyLedgerIdFromFileName("apify-tiktok-7001.mp4")).toBe("apify:tiktok:7001");
    expect(apifyLedgerIdFromFileName("apify-google_image-1a2b3c4d.jpg")).toBe("apify:google_image:1a2b3c4d");
    expect(apifyLedgerIdFromFileName("pexels-1.mp4")).toBeNull();
    const withAsset: any = { ...prisma, mediaAssetVersion: { findFirst: async () => ({ id: "lib-1", kind: "video", durationMs: 9000, originalFileName: "apify-tiktok-7001.mp4", origin: "apify" }) } };
    const svc = new MediaPlanService(withAsset, grants, pexels as unknown as PexelsService, apify as unknown as ApifyService);
    const s = script();
    expect(await svc.findReusableSource(projectId, firstSegment(svc, s), new SegmentSourceLedger())).toMatchObject({ provider: "apify", externalId: "apify:tiktok:7001", sourcing: "reused" });
  });
});
