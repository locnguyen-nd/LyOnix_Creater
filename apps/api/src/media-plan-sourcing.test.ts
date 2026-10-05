import { describe, expect, it, vi } from "vitest";
import { MEDIA_PLAN_SOURCING_CONCURRENCY, MediaPlanService, SegmentSourceLedger, type MediaPlanScript } from "./media-plan.service.js";
import type { ApifyService } from "./apify.service.js";
import type { PexelsService } from "./pexels.service.js";

// VE2E-51: bounded-concurrency segment sourcing, ledger guarantees, Pexels fallback serialisation, job usage.
const projectId = "project-1";
const scriptOf = (count: number, language = "ja"): MediaPlanScript => ({
  language,
  scenes: Array.from({ length: count }, (_, i) => ({ sceneId: `s${i + 1}`, narration: `n${i}`, screenText: `t${i}`, visualQuery: `クエリ${i + 1}`, durationHintMs: 5000, voiceDurationMs: 5000 })),
  visualPlan: null,
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function setup(apifyImpl: (call: number, args: any[]) => Promise<any>) {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const apify = {
    findAccountForUser: vi.fn(async () => ({ id: "acc", encryptedSecret: "enc" })),
    autoImportForSegment: vi.fn(async (...args: any[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await tick();
        return await apifyImpl(calls++, args);
      } finally {
        inFlight -= 1;
      }
    }),
  };
  const pexelSnapshots: string[][] = [];
  let pexelsCalls = 0;
  const pexels = {
    autoImportForScene: vi.fn(async (_p: string, _u: string, _r: string, input: { usedExternalIds: string[] }) => {
      pexelSnapshots.push([...input.usedExternalIds]);
      await tick();
      const n = ++pexelsCalls;
      return { ok: true as const, data: { asset: { id: `pex-asset-${n}`, kind: "video", durationMs: 30_000 } as any, externalId: `pex-${n}` } };
    }),
  };
  const prisma: any = { mediaAssetVersion: { findFirst: async () => null } };
  const service = new MediaPlanService(prisma, {} as any, pexels as unknown as PexelsService, apify as unknown as ApifyService);
  // VE2E-50: Apify only searches with a validated ja keyword (no visualQuery fallback) - give each planned segment its own.
  const planOriginal = service.planSegments.bind(service);
  service.planSegments = (script, range) => planOriginal(script, range).map((segment, i) => ({ ...segment, keywords: { ja: `東京夜景${i + 1}`, en: `tokyo ${i + 1}` } }));
  return { service, apify, pexels, pexelSnapshots, stats: () => ({ maxInFlight }) };
}

const okFor = (n: number) => ({ ok: true as const, data: { asset: { id: `apify-asset-${n}`, kind: "video", durationMs: 30_000 } as any, externalId: `70${n}`, ledgerId: `apify:tiktok:70${n}`, platform: "tiktok" as const, provenance: null, quality: { considered: 3, passed: 1, rejected: { language_mismatch: 2 }, rejectedExamples: [], twoPhase: false, phase2: "not_used" as const, reusedLibraryAsset: false, searchReused: false } } });

describe("MediaPlanService.sourceSegments (VE2E-51)", () => {
  it("sources at most 3 segments at once, keeps segment order and a source per segment", async () => {
    const { service, stats } = setup(async (n) => okFor(n));
    const script = scriptOf(8);
    const segments = service.planSegments(script, { min: 8, max: 8 });
    const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments, ledger: new SegmentSourceLedger() });
    expect(MEDIA_PLAN_SOURCING_CONCURRENCY).toBe(3);
    expect(stats().maxInFlight).toBe(3);
    expect(result.sourced.map((s) => s.segment.segmentId)).toEqual(segments.map((s) => s.segmentId));
    expect(result.sourced.every((s) => s.source)).toBe(true);
    expect(new Set(result.sourced.map((s) => s.source!.mediaAssetVersionId)).size).toBe(8);
    expect(result.failure).toBeNull();
  });

  it("hands every parallel Apify call the SAME live reservation set and the segment duration/language", async () => {
    const seen: any[] = [];
    const { service } = setup(async (n, args) => { seen.push(args[4]); args[4].usedExternalIds.add(`70${n}`); return okFor(n); });
    const script = scriptOf(3);
    await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments: service.planSegments(script, { min: 3, max: 3 }), ledger: new SegmentSourceLedger() });
    expect(seen[0].usedExternalIds).toBe(seen[1].usedExternalIds);
    expect(seen.every((s) => s.scriptLanguage === "ja" && s.segmentDurationSeconds === 5 && s.job)).toBe(true);
    expect(seen[0].job).toBe(seen[2].job);
  });

  it("serialises Pexels fallbacks so a later segment excludes every earlier fallback clip", async () => {
    const { service, pexelSnapshots } = setup(async () => ({ ok: false, reason: "apify_no_usable_candidate" }));
    const script = scriptOf(3);
    const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments: service.planSegments(script, { min: 3, max: 3 }), ledger: new SegmentSourceLedger() });
    expect(result.sourced.map((s) => s.source?.provider)).toEqual(["pexels", "pexels", "pexels"]);
    expect(result.sourced.every((s) => s.source?.fallbackReason === "apify_no_usable_candidate")).toBe(true);
    expect(pexelSnapshots.map((ids) => ids.length).sort()).toEqual([0, 1, 2]);
    expect(new Set(result.sourced.map((s) => s.source!.externalId)).size).toBe(3);
  });

  it("keeps the Apify reject reasons in the diagnostics of a segment that fell back to Pexels", async () => {
    const { service } = setup(async () => ({ ok: false, reason: "apify_no_usable_candidate", quality: okFor(0).data.quality }));
    const script = scriptOf(1);
    const segments = service.planSegments(script, { min: 1, max: 1 });
    const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments, ledger: new SegmentSourceLedger() });
    const built = service.buildBindings(script, result.sourced);
    expect(built.diagnostics[0]).toMatchObject({ sourceProvider: "pexels", fallbackReason: "apify_no_usable_candidate", apifyQuality: { considered: 3, rejected: { language_mismatch: 2 } } });
  });

  it("stopOnFailure: the first thrown failure stops scheduling and is returned (lowest index), earlier successes are kept", async () => {
    const { service } = setup(async (n) => okFor(n));
    const script = scriptOf(4);
    const segments = service.planSegments(script, { min: 4, max: 4 });
    const boom = new Error("step failed");
    const result = await service.sourceSegments(projectId, "u", "staff", {
      providerAccountId: "p", script, segments, ledger: new SegmentSourceLedger(), concurrency: 1, stopOnFailure: true,
      runImport: async (segment, task) => { if (segment.segmentId === segments[1]!.segmentId) throw boom; return task(); },
    });
    expect(result.failure).toEqual({ segment: segments[1], error: boom });
    expect(result.sourced.map((s) => s.segment.segmentId)).toEqual([segments[0]!.segmentId]);
  });

  it("without stopOnFailure (Studio) a thrown/failed segment is reported unbound and the rest continue", async () => {
    const { service } = setup(async (n) => okFor(n));
    const script = scriptOf(3);
    const segments = service.planSegments(script, { min: 3, max: 3 });
    const result = await service.sourceSegments(projectId, "u", "staff", {
      providerAccountId: "p", script, segments, ledger: new SegmentSourceLedger(),
      runImport: async (segment, task) => { if (segment.segmentId === segments[1]!.segmentId) throw new Error("x"); return task(); },
    });
    expect(result.sourced).toHaveLength(3);
    expect(result.sourced[1]!.source).toBeNull();
    expect(result.failure).toBeNull();
  });

  it("returns null usage when Apify was not involved", async () => {
    const plain = new MediaPlanService({ mediaAssetVersion: { findFirst: async () => null } } as any, {} as any, { autoImportForScene: async () => ({ ok: true, data: { asset: { id: "a", kind: "video", durationMs: 1000 }, externalId: "e" } }) } as unknown as PexelsService);
    const script = scriptOf(1);
    const result = await plain.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script, segments: plain.planSegments(script, { min: 1, max: 1 }), ledger: new SegmentSourceLedger() });
    expect(result.apifyUsage).toBeNull();
  });
});
