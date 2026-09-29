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
      const outcome = await service.importSegmentSource(projectId, userId, "staff", { providerAccountId: "pexels-acc", script: script(), segment: segment!, ledger });
      expect(outcome).toMatchObject({ ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" });
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
        // 5s source, second scene no longer fits after 4s -> loops to 0 at the scene boundary
        { sceneId: "s2", mediaAssetVersionId: "v1", mediaKind: "video", segmentId: "seg-1", sourceStartMs: 0, sourceDurationMs: 3000 },
        { sceneId: "s3", mediaAssetVersionId: null, mediaKind: null, segmentId: null, sourceStartMs: null, sourceDurationMs: null },
      ]);
      expect(built.segments).toEqual([{ segmentId: "seg-1", sceneIds: ["s1", "s2"], mediaAssetVersionId: "v1", subject: null, priority: null }]);
      expect(built.diagnostics).toEqual([
        { segmentId: "seg-1", origin: "fallback", sourcing: "imported", errorCode: null, durationMs: 7000, looped: true, short: false },
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
      expect((pexels.autoImportForScene as ReturnType<typeof vi.fn>).mock.calls[1]![3].usedExternalIds).toEqual(["x1"]);
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
