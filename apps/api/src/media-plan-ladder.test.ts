import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPlanService, SegmentSourceLedger, type MediaPlanScript } from "./media-plan.service.js";
import type { ApifyService } from "./apify.service.js";
import type { PexelsService } from "./pexels.service.js";

// VE2E-130 (CR-MEDIA-SLA §3.1/§7): the media step never fails the job - race by priority, deadline, degraded ladder L4-L6.
// Everything here is a unit test with fakes (no live provider; none of this is evidence of live behaviour).
vi.mock("./quarantine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./quarantine.js")>()),
  writeQuarantineFile: vi.fn(async (buffer: Buffer) => ({ quarantineToken: "quarantine-token", sha256: "x", bytes: buffer.byteLength })),
}));

const projectId = "project-1";
const scriptOf = (count: number): MediaPlanScript => ({
  language: "ja",
  scenes: Array.from({ length: count }, (_, i) => ({ sceneId: `s${i + 1}`, narration: `n${i}`, screenText: `t${i}`, visualQuery: `q${i + 1}`, durationHintMs: 5000, voiceDurationMs: 5000 })),
  visualPlan: null,
});
const apifyHit = (id: string, durationMs = 60_000) => ({ ok: true as const, data: { asset: { id: `asset-${id}`, kind: "video", durationMs } as any, externalId: id, ledgerId: `apify:tiktok:${id}`, platform: "tiktok" as const, provenance: null, quality: null } });
const noApify = { ok: false as const, reason: "apify_no_usable_candidate" };
const pexelsHit = (id: string, kind: "video" | "image" = "video") => ({ ok: true as const, data: { asset: { id: `pex-${id}`, kind, durationMs: kind === "video" ? 30_000 : null } as any, externalId: id } });
const pexelsMiss = { ok: false as const, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" as const, message: "none" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Setup = { apifyImpl?: (args: any[]) => Promise<any>; pexelsImpl?: (input: any) => Promise<any>; media?: boolean; prisma?: any };
function setup(options: Setup = {}) {
  const apify = { findAccountForUser: vi.fn(async () => ({ id: "apify-acc", encryptedSecret: "enc" })), autoImportForSegment: vi.fn(async (...args: any[]) => (options.apifyImpl ? options.apifyImpl(args) : noApify)) };
  const pexels = { autoImportForScene: vi.fn(async (_p: string, _u: string, _r: string, input: any) => (options.pexelsImpl ? options.pexelsImpl(input) : pexelsMiss)) };
  const media = { registerAsset: vi.fn(async (..._args: any[]) => ({ id: "brand-bg", kind: "image" })) };
  const prisma = options.prisma ?? { mediaAssetVersion: { findFirst: async () => null } };
  const service = new MediaPlanService(prisma, {} as any, pexels as unknown as PexelsService, apify as unknown as ApifyService, undefined, options.media === false ? undefined : (media as never));
  const planOriginal = service.planSegments.bind(service);
  service.planSegments = (script, range) => planOriginal(script, range).map((segment, i) => ({ ...segment, keywords: { ja: `東京夜景${i + 1}`, en: `tokyo ${i + 1}` } }));
  return { service, apify, pexels, media };
}

describe("VE2E-130 media ladder", () => {
  beforeEach(() => { process.env.APIFY_VIDEO_PLATFORMS = "tiktok"; });
  afterEach(() => { delete process.env.APIFY_VIDEO_PLATFORMS; delete process.env.MEDIA_SEGMENT_DEADLINE_MS; delete process.env.MEDIA_BRAND_BACKGROUND_COLOR; });

  describe("race by priority + deadline", () => {
    it("ja beats en and Pexels even when they finish first; the losers' reservations are released", async () => {
      process.env.MEDIA_SEGMENT_DEADLINE_MS = "2000";
      const { service } = setup({
        apifyImpl: async (args) => { if (args[4].keyword.startsWith("東京")) { await sleep(40); return apifyHit("ja1"); } return apifyHit("en1"); },
        pexelsImpl: async () => pexelsHit("px1"),
      });
      const script = scriptOf(1);
      const ledger = new SegmentSourceLedger();
      const outcome = await service.importSegmentSource(projectId, "u", "staff", { providerAccountId: "p", script, segment: service.planSegments(script, { min: 1, max: 1 })[0]!, ledger });
      expect(outcome).toMatchObject({ ok: true, data: { provider: "apify", tier: "ja", externalId: "apify:tiktok:ja1" } });
      expect(ledger.apifyPlainIds.has("px1")).toBe(false);
    });

    it("falls to en when ja finishes empty, then to Pexels when every Apify tier is empty", async () => {
      const first = setup({ apifyImpl: async (args) => (args[4].keyword.startsWith("tokyo") ? apifyHit("en1") : noApify), pexelsImpl: async () => pexelsHit("px1") });
      const script = scriptOf(1);
      const segmentOf = (svc: MediaPlanService) => svc.planSegments(script, { min: 1, max: 1 })[0]!;
      expect(await first.service.importSegmentSource(projectId, "u", "staff", { providerAccountId: "p", script, segment: segmentOf(first.service), ledger: new SegmentSourceLedger() })).toMatchObject({ ok: true, data: { tier: "en" } });
      const second = setup({ pexelsImpl: async () => pexelsHit("px1") });
      expect(await second.service.importSegmentSource(projectId, "u", "staff", { providerAccountId: "p", script, segment: segmentOf(second.service), ledger: new SegmentSourceLedger() })).toMatchObject({ ok: true, data: { provider: "pexels", tier: "pexels", fallbackReason: "apify_no_usable_candidate" } });
    });

    it("at most 3 searches (ja, en, broad) + one call each per segment; broad is bound to the subject", async () => {
      const { service, apify } = setup();
      const script = scriptOf(1);
      const segment = { ...service.planSegments(script, { min: 1, max: 1 })[0]!, subject: "Shohei Ohtani" };
      await service.importSegmentSource(projectId, "u", "staff", { providerAccountId: "p", script, segment, ledger: new SegmentSourceLedger() });
      expect(apify.autoImportForSegment.mock.calls.map((c: any[]) => c[4].keyword)).toEqual(["東京夜景1", "tokyo 1", "Shohei Ohtani"]);
      // VE2E-89: the relaxed tiers use the en language filter (VE2E-131), no `lenient` pass any more.
      expect(apify.autoImportForSegment.mock.calls.map((c: any[]) => c[4].lang)).toEqual([undefined, "en", "en"]);
      expect(apify.autoImportForSegment.mock.calls.map((c: any[]) => Boolean(c[4].lenient))).toEqual([false, false, false]);
    });

    it("reads the multi-tier keyword format (arrays, broad_en) next to the legacy one", async () => {
      const { service, apify } = setup();
      const script = scriptOf(1);
      const segment = { ...service.planSegments(script, { min: 1, max: 1 })[0]!, keywords: { ja: ["大谷翔平"], en: ["Ohtani"], broad_en: ["baseball homerun"], mood_en: "stadium night" } as any };
      await service.importSegmentSource(projectId, "u", "staff", { providerAccountId: "p", script, segment, ledger: new SegmentSourceLedger() });
      expect(apify.autoImportForSegment.mock.calls.map((c: any[]) => c[4].keyword)).toEqual(["大谷翔平", "Ohtani", "baseball homerun"]);
    });

    it("deadline: a hanging ja search does not hold the segment - the best finished tier (Pexels) is taken at MEDIA_SEGMENT_DEADLINE_MS", async () => {
      process.env.MEDIA_SEGMENT_DEADLINE_MS = "60";
      const { service } = setup({ apifyImpl: () => new Promise(() => undefined), pexelsImpl: async () => pexelsHit("px1") });
      const script = scriptOf(1);
      const started = Date.now();
      const outcome = await service.importSegmentSource(projectId, "u", "staff", { providerAccountId: "p", script, segment: service.planSegments(script, { min: 1, max: 1 })[0]!, ledger: new SegmentSourceLedger() });
      expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels" } });
      expect(Date.now() - started).toBeLessThan(1000);
      expect((outcome as any).data.fallbackReason).toBe("segment_deadline");
    });

    it("deadline with nothing found: ok:false reports which tiers hit the deadline (Auto degrades, never fails)", async () => {
      process.env.MEDIA_SEGMENT_DEADLINE_MS = "40";
      const { service } = setup({ apifyImpl: () => new Promise(() => undefined) });
      const script = scriptOf(1);
      const outcome = await service.importSegmentSource(projectId, "u", "staff", { providerAccountId: "p", script, segment: service.planSegments(script, { min: 1, max: 1 })[0]!, ledger: new SegmentSourceLedger() });
      expect(outcome).toMatchObject({ ok: false, reasons: expect.stringContaining("ja:segment_deadline") });
    });
  });

  describe("Pexels account resolution", () => {
    it("uses any verified Pexels account the user can see when the profile's media account is Apify", async () => {
      const prisma = {
        mediaAssetVersion: { findFirst: async () => null },
        providerAccount: { findFirst: vi.fn(async () => ({ provider: "apify", enabled: true, status: "verified", isFake: false })), findMany: vi.fn(async () => [{ id: "pexels-other" }]) },
      };
      const { service, pexels } = setup({ prisma, pexelsImpl: async () => pexelsHit("px1") });
      const script = scriptOf(1);
      const outcome = await service.importSegmentSource(projectId, "u", "staff", { providerAccountId: "apify-profile-acc", script, segment: service.planSegments(script, { min: 1, max: 1 })[0]!, ledger: new SegmentSourceLedger() });
      expect(outcome).toMatchObject({ ok: true, data: { provider: "pexels" } });
      expect(pexels.autoImportForScene.mock.calls[0]![3].providerAccountId).toBe("pexels-other");
      expect((prisma.providerAccount.findMany.mock.calls as any[][])[0]![0].where).toMatchObject({ provider: "pexels", OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: "u" }] });
    });

    it("no Pexels account anywhere: resolves to null (no stock tier)", async () => {
      const prisma = { providerAccount: { findFirst: async () => ({ provider: "apify", enabled: true, status: "verified", isFake: false }), findMany: async () => [] } };
      const { service } = setup({ prisma });
      expect(await service.resolvePexelsAccountId("u", "staff", "x")).toBeNull();
    });
  });

  describe("degraded ladder via sourceSegments({ guaranteeSource })", () => {
    it("L4: a segment nothing can source takes a window of another segment's clip that no segment uses, flagged quality_degraded", async () => {
      // segment 1 (ja keyword 東京夜景1) finds a 60 s clip; segment 2 finds nothing anywhere
      const { service } = setup({ apifyImpl: async (args) => (args[4].keyword === "東京夜景1" ? apifyHit("clip1", 60_000) : noApify) });
      const script = scriptOf(2);
      const segments = service.planSegments(script, { min: 2, max: 2 });
      const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments, ledger: new SegmentSourceLedger(), guaranteeSource: true });
      expect(result.failure).toBeNull();
      const [one, two] = result.sourced;
      expect(one!.source).toMatchObject({ mediaAssetVersionId: "asset-clip1" });
      expect(two!.source).toMatchObject({ mediaAssetVersionId: "asset-clip1", degraded: "reuse_window", sourcing: "reused" });
      expect(two!.source!.window!.startMs).toBeGreaterThanOrEqual(5000); // after the window segment 1 occupies (guards + 5 s)
      const built = service.buildBindings(script, result.sourced);
      expect(built.diagnostics[1]).toMatchObject({ qualityDegraded: true, degradedTier: "reuse_window", reusedWindow: { startMs: two!.source!.window!.startMs } });
      expect(built.diagnostics[0]!.qualityDegraded).toBeUndefined();
      const firstEnd = built.scenes[0]!.sourceStartMs! + built.scenes[0]!.sourceDurationMs!;
      expect(built.scenes[1]!.sourceStartMs!).toBeGreaterThanOrEqual(firstEnd); // no overlap of source time
    });

    it("L5: without any clip to reuse, a stock photo is taken and carries Ken Burns info", async () => {
      const { service } = setup({ pexelsImpl: async (input) => (input.mediaType === "image" ? pexelsHit("photo1", "image") : pexelsMiss) });
      const script = scriptOf(1);
      const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments: service.planSegments(script, { min: 1, max: 1 }), ledger: new SegmentSourceLedger(), guaranteeSource: true });
      expect(result.sourced[0]!.source).toMatchObject({ kind: "image", degraded: "stock_image", provider: "pexels" });
      const built = service.buildBindings(script, result.sourced);
      expect(built.diagnostics[0]).toMatchObject({ qualityDegraded: true, degradedTier: "stock_image", kenBurns: { zoomFrom: 1, zoomTo: 1.15, durationMs: 5000 } });
      expect(built.scenes[0]).toMatchObject({ mediaKind: "image", sourceStartMs: null });
    });

    it("L6: with no stock either, a flagged brand-background placeholder asset is registered and used (generated PNG, no FFmpeg)", async () => {
      process.env.MEDIA_BRAND_BACKGROUND_COLOR = "#112233";
      const { service, media } = setup();
      const script = scriptOf(2);
      const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments: service.planSegments(script, { min: 2, max: 2 }), ledger: new SegmentSourceLedger(), guaranteeSource: true });
      expect(result.sourced.map((s) => s.source?.degraded)).toEqual(["brand_background", "brand_background"]);
      const registered = (media.registerAsset.mock.calls[0] as any[])[3];
      expect(registered).toMatchObject({ kind: "image", mimeType: "image/png", origin: "generated", widthPx: 1080, heightPx: 1920, serverProvenance: { placeholder: "brand_background", qualityDegraded: true, color: "#112233" } });
      expect(service.buildBindings(script, result.sourced).diagnostics[0]).toMatchObject({ qualityDegraded: true, degradedTier: "brand_background", placeholder: true });
    });

    it("a runImport failure (thrown StepRun error, any MEDIA_RELEVANCE_* code) never becomes a failure: the segment degrades and the run goes on", async () => {
      const { service } = setup({ apifyImpl: async () => apifyHit("c1") });
      const script = scriptOf(2);
      const segments = service.planSegments(script, { min: 2, max: 2 });
      const result = await service.sourceSegments(projectId, "u", "staff", {
        providerAccountId: "p", script, segments, ledger: new SegmentSourceLedger(), guaranteeSource: true, stopOnFailure: true,
        runImport: async (segment, task) => {
          if (segment.segmentId === segments[0]!.segmentId) throw Object.assign(new Error("weak"), { code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" });
          return task();
        },
      });
      expect(result.failure).toBeNull();
      expect(result.sourced).toHaveLength(2);
      expect(result.sourced.every((s) => s.source)).toBe(true);
      expect(result.sourced[0]!.source!.degraded).toBeDefined();
      expect(result.sourced[1]!.source!.degraded).toBeUndefined();
    });

    it("without the Media service L6 is unavailable and the segment is reported unbound (never throws)", async () => {
      const { service } = setup({ media: false });
      const script = scriptOf(1);
      const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments: service.planSegments(script, { min: 1, max: 1 }), ledger: new SegmentSourceLedger(), guaranteeSource: true });
      expect(result.failure).toBeNull();
      expect(result.sourced[0]).toMatchObject({ source: null, errorCode: "MEDIA_PLACEHOLDER_UNAVAILABLE" });
    });

    it("without guaranteeSource (Studio) a segment with no source stays unbound for the user to pick", async () => {
      const { service, media } = setup();
      const script = scriptOf(1);
      const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments: service.planSegments(script, { min: 1, max: 1 }), ledger: new SegmentSourceLedger() });
      expect(result.sourced[0]!.source).toBeNull();
      expect(media.registerAsset).not.toHaveBeenCalled();
    });
  });
});
