import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPlanService, SegmentSourceLedger, pexelsExternalIdFromFileName, type MediaPlanScript } from "./media-plan.service.js";
import type { PexelsService } from "./pexels.service.js";

const projectId = "project-1";
const userId = "user-1";

const script = (visualPlan: MediaPlanScript["visualPlan"] = null): MediaPlanScript => ({
  language: "ja",
  scenes: [
    { sceneId: "s1", narration: "一つ目。", screenText: "one", visualQuery: "tokyo street", durationHintMs: 5000, voiceDurationMs: 4000 },
    { sceneId: "s2", narration: "二つ目。", screenText: "two", visualQuery: "ramen shop", durationHintMs: 5000, voiceDurationMs: 3000 },
    { sceneId: "s3", narration: "三つ目。", screenText: "three", visualQuery: "night train", durationHintMs: 5000, voiceDurationMs: null },
  ],
  visualPlan,
});

describe("MediaPlanService", () => {
  let prisma: any;
  let grants: any;
  let pexels: Partial<PexelsService>;
  let service: MediaPlanService;
  let assets: any[];

  beforeEach(() => {
    assets = [];
    prisma = {
      project: { findUnique: async ({ where }: any) => (where.id === projectId ? { id: projectId } : null) },
      mediaAssetVersion: {
        findFirst: vi.fn(async ({ where }: any) =>
          assets.filter((a) => a.projectId === where.projectId && a.sceneId === where.sceneId && !a.deletedAt && (where.parentMediaAssetVersionId === null ? !a.parentMediaAssetVersionId : true))[0] ?? null,
        ),
      },
      scriptDraftVersion: { findUnique: vi.fn(async () => null) },
      audioVersion: { findMany: vi.fn(async () => []) },
    };
    grants = { forUser: async () => ({ teamIds: [], projectIds: [projectId], channelIds: [] }) };
    let n = 0;
    pexels = {
      autoImportForScene: vi.fn(async (_p: string, _u: string, _r: string, input: any) => {
        n += 1;
        return { ok: true as const, data: { asset: { id: `asset-${n}`, kind: "video", durationMs: 30_000 } as any, externalId: `ext-${n}` } };
      }),
    };
    service = new MediaPlanService(prisma, grants, pexels as PexelsService);
  });

  it("pexelsExternalIdFromFileName reads the id Pexels imports are named with", () => {
    expect(pexelsExternalIdFromFileName("pexels-12345.mp4")).toBe("12345");
    expect(pexelsExternalIdFromFileName("upload.mp4")).toBeNull();
  });

  describe("findReusableSource", () => {
    const segment = { segmentId: "g1", sceneIds: ["s1", "s2"], subject: null, priority: null, keywords: null, durationMs: 7000, origin: "fallback" as const };

    it("reuses the asset assigned to the segment's first scene", async () => {
      assets.push({ id: "lib-1", projectId, sceneId: "s1", kind: "video", durationMs: 9000, originalFileName: "pexels-77.mp4" });
      expect(await service.findReusableSource(projectId, segment, new SegmentSourceLedger())).toEqual({ mediaAssetVersionId: "lib-1", kind: "video", durationMs: 9000, externalId: "77", sourcing: "reused" });
    });

    it("never reuses a source an earlier segment already used, and never picks a derivative", async () => {
      assets.push({ id: "lib-1", projectId, sceneId: "s1", kind: "video", durationMs: 9000, originalFileName: "pexels-77.mp4" });
      const ledger = new SegmentSourceLedger();
      ledger.add({ mediaAssetVersionId: "other", kind: "video", durationMs: 1, externalId: "77", sourcing: "imported" });
      expect(await service.findReusableSource(projectId, segment, ledger)).toBeNull();
      expect(prisma.mediaAssetVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ parentMediaAssetVersionId: null }) }));
    });

    it("ignores audio/document assets", async () => {
      assets.push({ id: "aud", projectId, sceneId: "s1", kind: "audio", durationMs: 9000, originalFileName: "tts.mp3" });
      expect(await service.findReusableSource(projectId, segment, new SegmentSourceLedger())).toBeNull();
    });
  });

  describe("importSegmentSource", () => {
    it("searches with keywords.en first and the whole segment duration, excluding earlier segments' sources", async () => {
      const plan = { segments: [{ segmentId: "g1", sceneIds: ["s1", "s2", "s3"], subject: "夜の東京", priority: 1, keywords: { ja: "東京 夜", en: "tokyo night street" }, styleHints: { setting: "", timeOfDay: "", lighting: "", palette: "" } }] };
      const planScript = script(plan);
      const [segment] = service.planSegments(planScript, { min: 1, max: 1 });
      const ledger = new SegmentSourceLedger();
      ledger.add({ mediaAssetVersionId: "prev", kind: "video", durationMs: 1, externalId: "ext-prev", sourcing: "imported" });
      const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: planScript, segment: segment!, ledger });
      expect(outcome).toMatchObject({ ok: true, data: { mediaAssetVersionId: "asset-1", sourcing: "imported", externalId: "ext-1" } });
      const input = (pexels.autoImportForScene as ReturnType<typeof vi.fn>).mock.calls[0]![3];
      expect(input).toMatchObject({ sceneId: "s1", query: "tokyo night street", usedExternalIds: ["ext-prev"] });
      expect(input.sceneBrief.phrases[0]).toBe("tokyo night street");
      // 4000 + 3000 + 5000 (no audio -> durationHintMs)
      expect(input.sceneBrief.targetDurationSeconds).toBe(12);
    });

    it("rejects an import that deduped onto an earlier segment's asset", async () => {
      const ledger = new SegmentSourceLedger();
      ledger.add({ mediaAssetVersionId: "asset-1", kind: "video", durationMs: 1, externalId: "ext-x", sourcing: "imported" });
      const [segment] = service.planSegments(script(), { min: 1, max: 1 });
      // The stock API keeps handing back the same bytes (asset-1, different external ids): after one retry the tier gives up.
      let n = 0;
      pexels.autoImportForScene = vi.fn(async () => ({ ok: true as const, data: { asset: { id: "asset-1", kind: "video", durationMs: 30_000 } as any, externalId: `dup-${++n}` } }));
      const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: script(), segment: segment!, ledger });
      expect(outcome).toMatchObject({ ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" });
      expect(pexels.autoImportForScene).toHaveBeenCalledTimes(2);
    });

    it("a clash with an id another segment claimed a moment ago retries once with that id excluded (no Pexels mutex)", async () => {
      const ledger = new SegmentSourceLedger();
      const [segment] = service.planSegments(script(), { min: 1, max: 1 });
      const seen: string[][] = [];
      pexels.autoImportForScene = vi.fn(async (_p: string, _u: string, _r: string, input: any) => {
        seen.push([...input.usedExternalIds]);
        ledger.apifyPlainIds.add("clash"); // another segment claims it while this call is in flight
        return seen.length === 1
          ? { ok: true as const, data: { asset: { id: "a-clash", kind: "video", durationMs: 30_000 } as any, externalId: "clash" } }
          : { ok: true as const, data: { asset: { id: "a-free", kind: "video", durationMs: 30_000 } as any, externalId: "free" } };
      });
      const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: script(), segment: segment!, ledger });
      expect(outcome).toMatchObject({ ok: true, data: { externalId: "free", provider: "pexels", tier: "pexels" } });
      expect(seen[1]).toContain("clash");
      expect(ledger.apifyPlainIds.has("free")).toBe(true);
    });
  });

  describe("buildBindings", () => {
    it("binds every scene of a segment to its source with contiguous ranges; photos and failed segments get no range", () => {
      const planScript = script();
      const segments = service.planSegments(planScript, { min: 2, max: 2 });
      expect(segments.map((s) => s.sceneIds)).toEqual([["s1", "s2"], ["s3"]]);
      const built = service.buildBindings(planScript, [
        { segment: segments[0]!, source: { mediaAssetVersionId: "v1", kind: "video", durationMs: 5000, externalId: "e1", sourcing: "imported" }, errorCode: null },
        { segment: segments[1]!, source: null, errorCode: "MEDIA_RELEVANCE_BELOW_THRESHOLD" },
      ]);
      expect(built.scenes).toEqual([
        { sceneId: "s1", mediaAssetVersionId: "v1", mediaKind: "video", segmentId: "seg-1", sourceStartMs: 0, sourceDurationMs: 4000 },
        // 5s source, the second scene no longer fits after 4s -> it gets only the remaining 1s (never a replay of scene 1's footage); a second source should cover the rest
        { sceneId: "s2", mediaAssetVersionId: "v1", mediaKind: "video", segmentId: "seg-1", sourceStartMs: 4000, sourceDurationMs: 1000 },
        { sceneId: "s3", mediaAssetVersionId: null, mediaKind: null, segmentId: null, sourceStartMs: null, sourceDurationMs: null },
      ]);
      expect(built.segments).toEqual([{ segmentId: "seg-1", sceneIds: ["s1", "s2"], mediaAssetVersionId: "v1", subject: null, priority: null }]);
      expect(built.diagnostics).toEqual([
        { segmentId: "seg-1", origin: "fallback", sourcing: "imported", errorCode: null, durationMs: 7000, looped: false, short: true, needsSecondSource: true, coveredMs: 5000 },
        { segmentId: "seg-2", origin: "fallback", sourcing: "failed", errorCode: "MEDIA_RELEVANCE_BELOW_THRESHOLD", durationMs: 5000, looped: false, short: false },
      ]);
    });

    it("a photo source binds without ranges", () => {
      const planScript = script();
      const [segment] = service.planSegments(planScript, { min: 1, max: 1 });
      const built = service.buildBindings(planScript, [{ segment: segment!, source: { mediaAssetVersionId: "p1", kind: "image", durationMs: null, externalId: "e", sourcing: "imported" }, errorCode: null }]);
      expect(built.scenes.every((s) => s.mediaAssetVersionId === "p1" && s.sourceStartMs === null)).toBe(true);
    });
  });

  describe("planForScriptVersion (Studio endpoint)", () => {
    const scriptRow = {
      id: "script-1",
      language: "ja",
      visualPlan: null,
      sourceVersion: { projectId },
      scenes: [
        { id: "sd-2", sceneId: "s2", orderIndex: 1, narration: "b", screenText: "b", visualQuery: "q2", durationHintMs: 5000 },
        { id: "sd-1", sceneId: "s1", orderIndex: 0, narration: "a", screenText: "a", visualQuery: "q1", durationHintMs: 5000 },
      ],
    };

    it("plans with real voice durations and reports a failed segment instead of failing the whole plan", async () => {
      prisma.scriptDraftVersion.findUnique = vi.fn(async () => scriptRow);
      prisma.audioVersion.findMany = vi.fn(async () => [{ sceneDraftVersionId: "sd-1", durationMs: 6000 }, { sceneDraftVersionId: "sd-2", durationMs: 7000 }]);
      let call = 0;
      pexels.autoImportForScene = vi.fn(async () => {
        call += 1;
        return call === 1
          ? { ok: true as const, data: { asset: { id: "a1", kind: "video", durationMs: 30_000 } as any, externalId: "x1" } }
          : { ok: false as const, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" as const, message: "weak" };
      });
      const range = vi.fn(() => ({ min: 2, max: 3 }));
      const outcome = await service.planForScriptVersion(projectId, userId, "staff", { scriptDraftVersionId: "script-1", providerAccountId: "pexels-acc", range });
      expect(range).toHaveBeenCalledWith(13);
      expect(outcome).toMatchObject({
        ok: true,
        data: {
          policyVersion: "media-plan-policy.v1",
          range: { min: 2, max: 3 },
          scenes: [
            { sceneId: "s1", mediaAssetVersionId: "a1", segmentId: "seg-1", sourceStartMs: 0, sourceDurationMs: 6000 },
            { sceneId: "s2", mediaAssetVersionId: null, segmentId: null, sourceStartMs: null, sourceDurationMs: null },
          ],
          segments: [{ segmentId: "seg-1", sceneIds: ["s1"], mediaAssetVersionId: "a1" }],
          diagnostics: [{ segmentId: "seg-1", sourcing: "imported" }, { segmentId: "seg-2", sourcing: "failed", errorCode: "MEDIA_RELEVANCE_BELOW_THRESHOLD" }],
        },
      });
    });

    describe("VE2E-55: keyword extraction for Studio plans", () => {
      let apify: { findAccountForUser: ReturnType<typeof vi.fn>; autoImportForSegment: ReturnType<typeof vi.fn> };
      let scriptGeneration: { resolveContentAccountId: ReturnType<typeof vi.fn>; extractSegmentKeywords: ReturnType<typeof vi.fn> };
      let operations: any[];
      const plan = () => service.planForScriptVersion(projectId, userId, "staff", { scriptDraftVersionId: "script-1", providerAccountId: "pexels-acc", range: () => ({ min: 1, max: 1 }) });

      beforeEach(() => {
        operations = [];
        prisma.scriptDraftVersion.findUnique = vi.fn(async () => scriptRow);
        prisma.providerOperation = { create: vi.fn(async ({ data }: any) => { operations.push(data); return data; }) };
        apify = {
          findAccountForUser: vi.fn(async () => ({ id: "apify-acc" })),
          autoImportForSegment: vi.fn(async () => ({ ok: true as const, data: { asset: { id: "apify-a1", kind: "video", durationMs: 30_000 } as any, externalId: "1", ledgerId: "apify:tiktok:1", platform: "tiktok" as const, provenance: null } })),
        };
        scriptGeneration = {
          resolveContentAccountId: vi.fn(async () => "content-acc"),
          extractSegmentKeywords: vi.fn(async () => ({ ok: true as const, keywords: { "seg-1": { ja: "新宿 夜景", en: "shinjuku night" } }, rejectedSegmentIds: [], usage: { inputTokens: 10, outputTokens: 5, costAmount: null, costCurrency: null, providerRequestId: "req-1" }, modelId: "m", provider: "openai", promptTemplateVersion: "v" })),
        };
        service = new MediaPlanService(prisma, grants, pexels as PexelsService, apify as never, scriptGeneration as never);
      });

      it("a script without ja keywords: one extraction call, its keyword reaches Apify, the call is recorded", async () => {
        const outcome = await plan();
        expect(scriptGeneration.extractSegmentKeywords).toHaveBeenCalledTimes(1);
        expect(scriptGeneration.extractSegmentKeywords.mock.calls[0]![2].providerAccountId).toBe("content-acc");
        expect(apify.autoImportForSegment.mock.calls[0]![4].keyword).toBe("新宿 夜景");
        expect(operations).toEqual([expect.objectContaining({ role: "content", operation: "extract_keywords", status: "succeeded", providerAccountId: "content-acc", externalRequestId: "req-1" })]);
        expect(outcome).toMatchObject({ ok: true, data: { diagnostics: [{ sourceProvider: "apify" }] } });
      });

      it("no content account: Pexels with reason no_content_account and no extraction call", async () => {
        scriptGeneration.resolveContentAccountId.mockResolvedValue(null);
        const outcome = await plan();
        expect(scriptGeneration.extractSegmentKeywords).not.toHaveBeenCalled();
        expect(apify.autoImportForSegment).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ ok: true, data: { diagnostics: [{ sourceProvider: "pexels", fallbackReason: "no_content_account" }] } });
      });

      it("extraction failure: Pexels with reason extraction_failed, failed operation recorded", async () => {
        scriptGeneration.extractSegmentKeywords.mockResolvedValue({ ok: false, code: "PROVIDER_TIMEOUT", message: "t" });
        const outcome = await plan();
        expect(outcome).toMatchObject({ ok: true, data: { diagnostics: [{ sourceProvider: "pexels", fallbackReason: "extraction_failed" }] } });
        expect(operations[0]).toMatchObject({ status: "failed", errorCode: "PROVIDER_TIMEOUT" });
      });

      it("no Apify account: no content account lookup and no extraction call", async () => {
        apify.findAccountForUser.mockResolvedValue(null);
        await plan();
        expect(scriptGeneration.resolveContentAccountId).not.toHaveBeenCalled();
        expect(scriptGeneration.extractSegmentKeywords).not.toHaveBeenCalled();
      });

      it("a plan that already has valid ja keywords pays no extraction", async () => {
        const seg = { segmentId: "g1", sceneIds: ["s1", "s2"], subject: "x", priority: 1, keywords: { ja: "東京 夜景", en: "tokyo night" }, styleHints: { setting: "", timeOfDay: "", lighting: "", palette: "" } };
        prisma.scriptDraftVersion.findUnique = vi.fn(async () => ({ ...scriptRow, visualPlan: { segments: [seg] } }));
        await plan();
        expect(scriptGeneration.extractSegmentKeywords).not.toHaveBeenCalled();
        expect(apify.autoImportForSegment.mock.calls[0]![4].keyword).toBe("東京 夜景");
      });
    });

    it("hides a project without write access, and a script from another project, as NOT_FOUND", async () => {
      grants.forUser = async () => ({ teamIds: [], projectIds: [], channelIds: [] });
      expect(await service.planForScriptVersion(projectId, userId, "staff", { scriptDraftVersionId: "script-1", providerAccountId: "p", range: () => null })).toMatchObject({ ok: false, code: "NOT_FOUND" });
      grants.forUser = async () => ({ teamIds: [], projectIds: [projectId], channelIds: [] });
      prisma.scriptDraftVersion.findUnique = vi.fn(async () => ({ ...scriptRow, sourceVersion: { projectId: "other" } }));
      expect(await service.planForScriptVersion(projectId, userId, "staff", { scriptDraftVersionId: "script-1", providerAccountId: "p", range: () => null })).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(pexels.autoImportForScene).not.toHaveBeenCalled();
    });
  });
});
