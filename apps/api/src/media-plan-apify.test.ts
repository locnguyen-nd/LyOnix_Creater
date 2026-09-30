import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIFY_FALLBACK_KEYWORD_MAX_CHARS, MediaPlanService, SegmentSourceLedger, apifyAutoPlatformFromEnv, apifyKeywordForSegment, apifyLedgerIdFromFileName, type MediaPlanScript } from "./media-plan.service.js";
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
  const prisma: any = { project: { findUnique: async () => ({ id: projectId }) } };
  const grants: any = { forUser: async () => ({ teamIds: [], projectIds: [projectId], channelIds: [] }) };

  const firstSegment = (svc: MediaPlanService, s: MediaPlanScript) => svc.planSegments(s, { min: 1, max: 1 })[0]!;

  beforeEach(() => {
    pexels = { autoImportForScene: vi.fn(async () => ({ ok: true as const, data: { asset: { id: "pexels-asset-1", kind: "video", durationMs: 30_000 } as any, externalId: "ext-1" } })) };
    apify = { findAccountForUser: vi.fn(async () => ({ id: "apify-acc", encryptedSecret: "enc" })), autoImportForSegment: vi.fn(async () => apifyOk) };
    service = new MediaPlanService(prisma, grants, pexels as unknown as PexelsService, apify as unknown as ApifyService);
  });

  afterEach(() => { delete process.env.APIFY_AUTO_PLATFORM; });

  it("sources the segment from Apify with keywords.ja and never touches Pexels on success", async () => {
    const s = script();
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { mediaAssetVersionId: "apify-asset-1", provider: "apify", sourcing: "imported", externalId: "apify:tiktok:7001" } });
    expect(pexels.autoImportForScene).not.toHaveBeenCalled();
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
    apify.autoImportForSegment.mockResolvedValueOnce({ ok: false, reason: "apify_no_usable_candidate" });
    const s = script();
    const segment = firstSegment(service, s);
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment, ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { mediaAssetVersionId: "pexels-asset-1", provider: "pexels", fallbackReason: "apify_no_usable_candidate" } });
    expect(pexels.autoImportForScene.mock.calls[0]![3].sceneBrief.phrases[0]).toBe("tokyo night");
    if (!outcome.ok) return;
    expect(service.buildBindings(s, [{ segment, source: outcome.data, errorCode: null }]).diagnostics[0]).toMatchObject({ sourceProvider: "pexels", fallbackReason: "apify_no_usable_candidate" });
  });

  it("falls back to Pexels when the Apify call throws or errors", async () => {
    apify.autoImportForSegment.mockRejectedValueOnce(new Error("boom"));
    const s = script();
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "apify_error:unexpected" } });
    apify.autoImportForSegment.mockResolvedValueOnce({ ok: false, reason: "apify_error:PROVIDER_TIMEOUT" });
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

  // VE2E-48: scripts without a visualPlan (every script generated before VE2E-38) still use Apify for language=ja.
  const noPlan = (language: string): MediaPlanScript => ({ ...script(), language, visualPlan: null });

  it("ja script without visualPlan: Apify is tried with the scenes' visualQuery as keyword and Pexels query is unchanged", async () => {
    const s = noPlan("ja");
    s.scenes[0]!.visualQuery = "東京 夜景";
    s.scenes[1]!.visualQuery = "ラーメン店";
    const segment = firstSegment(service, s);
    expect(segment.keywords).toBeNull();
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment, ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "apify" } });
    expect(apify.autoImportForSegment.mock.calls[0]![4]).toMatchObject({ keyword: "東京 夜景 ラーメン店" });
    expect(pexels.autoImportForScene).not.toHaveBeenCalled();
  });

  it("derives a single deduped keyword within the length limit", () => {
    const s = noPlan("ja");
    s.scenes[0]!.visualQuery = "東京 夜景";
    s.scenes[1]!.visualQuery = "東京  夜景";
    const segment = firstSegment(service, s);
    expect(apifyKeywordForSegment(s, segment)).toBe("東京 夜景");
    s.scenes[0]!.visualQuery = "あ".repeat(150);
    expect(apifyKeywordForSegment(s, segment)!.length).toBe(APIFY_FALLBACK_KEYWORD_MAX_CHARS);
    s.scenes[0]!.visualQuery = "あ".repeat(60);
    s.scenes[1]!.visualQuery = "い".repeat(60);
    expect(apifyKeywordForSegment(s, segment)).toBe("あ".repeat(60));
  });

  it("ja script without visualPlan falls back to Pexels with the Apify reason when Apify has no usable result", async () => {
    apify.autoImportForSegment.mockResolvedValueOnce({ ok: false, reason: "apify_no_usable_candidate" });
    const s = noPlan("ja");
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "apify_no_usable_candidate" } });
  });

  it("non-ja script without keywords: Pexels with reason no_ja_keywords (English is never invented)", async () => {
    const s = noPlan("en");
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "no_ja_keywords" } });
    expect(apify.autoImportForSegment).not.toHaveBeenCalled();
  });

  it("no ja keywords: Pexels, with the reason recorded and no Apify account lookup", async () => {
    const s = { ...script(""), language: "vi" };
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger: new SegmentSourceLedger() });
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "no_ja_keywords" } });
    expect(apify.findAccountForUser).not.toHaveBeenCalled();
    expect(apify.autoImportForSegment).not.toHaveBeenCalled();
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
    const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: s, segment: firstSegment(service, s), ledger });
    expect([...apify.autoImportForSegment.mock.calls[0]![4].usedExternalIds].sort()).toEqual(["555", "7001"]);
    expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels", fallbackReason: "apify_duplicate_or_unsupported_source" } });
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
