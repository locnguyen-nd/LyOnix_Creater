import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetVersionSummary } from "@lyonix/contracts";
import type { ApifyDeps } from "@lyonix/providers";
import { deriveSceneBrief } from "@lyonix/domain";
import {
  MEDIA_JOB_SCHEMA_VERSION,
  MediaJobClientError,
  REFRAME_ANALYZE_PROFILE_VERSION,
  REFRAME_ANALYZE_RESULT_TYPE,
  type ReframeAnalyzeJobInput,
  type ReframeAnalyzeResult,
  type ReframeCropPlan,
} from "@lyonix/media-jobs";
import { ApifyJobContext, ApifyService } from "./apify.service.js";
import type { MediaService } from "./media.service.js";
import { reframePolicyFromEnv, type ReframePolicy } from "./reframe-policy.js";
import { ReframeService } from "./reframe.service.js";
import { encryptSecret } from "./secret-crypto.js";
import * as safeBinaryFetch from "./safe-binary-fetch.js";

/**
 * VE2E-67 (CR-SUBJECT-REFRAME §6 Q5): the plan-time check of an imported Apify candidate. Auto (`swap`) rejects an
 * `overlay_unavoidable` candidate through the existing failed-candidate path (fallback to the next source); Studio (`flag`) keeps it
 * and exposes the flag + residualOverlayPct in `quality.reframe` (-> segment diagnostics `apifyQuality.reframe`).
 */
const projectId = "project-1";
const TOKEN = "stub_apify_token_value_000000";
const fakeAsset = { id: "asset-1", projectId, origin: "apify" } as unknown as MediaAssetVersionSummary;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const apifyStub = (items: unknown[]): ApifyDeps => {
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url.includes("/runs?")) return json({ data: { id: "run1", status: "READY", defaultDatasetId: "ds1" } }, 201);
    if (url.includes("/v2/actor-runs/run1")) return json({ data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1" } });
    if (url.includes("/v2/datasets/ds1/items")) return json(items);
    throw new Error(`unexpected ${url}`);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined };
};
const tiktokItem = { id: "7001", text: "夜景", webVideoUrl: "https://www.tiktok.com/@u/video/7001", authorMeta: { name: "creator" }, videoMeta: { duration: 12, coverUrl: "https://p16.tiktokcdn.com/c.jpg" }, mediaUrls: ["https://api.apify.com/v2/key-value-stores/kv1/records/v.mp4"] };

const plan = (overrides: Partial<ReframeCropPlan> = {}): ReframeCropPlan => ({
  version: "crop-plan.v1", sourceWidthPx: 720, sourceHeightPx: 1280, targetWidthPx: 1080, targetHeightPx: 1920, durationMs: 5000, zoomPermille: 1350, mode: "static",
  keyframes: [{ tMs: 0, xPx: 0, yPx: 0, widthPx: 533, heightPx: 948 }], primarySubjectId: "s", overlayUnavoidable: true, residualOverlayPct: 25, subjectCoveragePct: 100, ...overrides,
});
const analyzeResult = (job: ReframeAnalyzeJobInput, cropPlan: ReframeCropPlan): ReframeAnalyzeResult => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: REFRAME_ANALYZE_RESULT_TYPE, ok: true, jobKey: job.jobKey, reused: false,
  source: { relativePath: job.source.relativePath, mediaAssetVersionId: job.source.mediaAssetVersionId ?? null, kind: "video", durationMs: 12_000, width: 720, height: 1280 },
  window: { startMs: job.startMs ?? 0, durationMs: job.durationMs ?? 0 }, cropPlan, overlayUnavoidable: cropPlan.overlayUnavoidable,
  confidence: { overall: 0.6, subject: 0.6, overlay: 0.6, level: "medium", reasons: [] },
  analysis: { framesSampled: 7, framesAnalysed: 7, subjectSource: "face", framesWithFace: 7, framesWithPerson: 0, textRegions: 0, presetLogoRegions: 4, logoTemplateMatches: 0, warnings: [] },
  metrics: { totalMs: 1, sampleMs: 1, detectMs: 1, planMs: 1, detectMsPerFrame: 1, rssPeakMb: 1 }, retentionClass: "working", expiresAt: new Date(Date.now() + 1e9).toISOString(),
  tool: { profileVersion: REFRAME_ANALYZE_PROFILE_VERSION, ffmpegVersion: "t", detectorRuntime: "t", models: {} }, completedAt: new Date().toISOString(),
});

describe("ApifyService.autoImportForSegment + plan-time reframe check (VE2E-67)", () => {
  let root: string;
  let prevRoot: string | undefined;
  let prevKey: string | undefined;
  let media: { registerAsset: ReturnType<typeof vi.fn>; assignScene: ReturnType<typeof vi.fn> };
  const account = () => ({ id: "acct-1", encryptedSecret: encryptSecret(TOKEN) });
  const brief = () => deriveSceneBrief({ language: "ja", scenes: [{ sceneId: "s1", narration: "", screenText: "", visualQuery: "東京 夜景", durationHintMs: 5000 }] }, 0);
  const input = (job?: ApifyJobContext) => ({ platform: "tiktok" as const, keyword: "東京 夜景", brief: brief(), sceneId: "s1", usedExternalIds: new Set<string>(), segmentDurationSeconds: 5, ...(job ? { job } : {}) });

  const build = (options: { analyze?: (job: ReframeAnalyzeJobInput) => ReframeAnalyzeResult | Error; policy?: Partial<ReframePolicy>; withReframe?: boolean; library?: boolean } = {}) => {
    const analyzeJobs: ReframeAnalyzeJobInput[] = [];
    const reframe = new ReframeService({
      analyzeReframe: async (job: ReframeAnalyzeJobInput) => {
        analyzeJobs.push(job);
        const out = (options.analyze ?? ((j) => analyzeResult(j, plan())))(job);
        if (out instanceof Error) throw out;
        return out;
      },
    } as never);
    reframe.fixedPolicy = { ...reframePolicyFromEnv({}), ...options.policy };
    reframe.warn = () => undefined;
    const prisma: any = {
      project: { findUnique: async () => ({ id: projectId }) },
      providerAccount: { findFirst: async () => null },
      // the library lookup (by original file name) finds nothing -> the candidate is downloaded + imported; the reframe lookup (by id) finds the row
      mediaAssetVersion: { findFirst: async ({ where }: any) => (where.originalFileName ? (options.library ? { id: "asset-1", kind: "video", durationMs: 12_000 } : null) : { id: "asset-1", kind: "video", origin: "apify", relativePath: "projects/p/assets/a.mp4", durationMs: 12_000, checksumSha256: "c".repeat(64) }) },
    };
    const service = new ApifyService(prisma, { forUser: async () => ({ projectIds: [projectId] }) } as any, media as unknown as MediaService, undefined, undefined, options.withReframe === false ? undefined : reframe);
    service.apifyDeps = apifyStub([tiktokItem]);
    return { service, analyzeJobs };
  };

  beforeEach(async () => {
    process.env.APIFY_TWO_PHASE = "0";
    prevKey = process.env.PERSISTENCE_ENCRYPTION_KEY;
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    root = await mkdtemp(join(tmpdir(), "lyonix-apify-reframe-"));
    prevRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = root;
    media = { registerAsset: vi.fn(async () => fakeAsset), assignScene: vi.fn(async () => undefined) };
    vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: MP4, mimeType: "video/mp4", finalUrl: "x" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.PERSISTENCE_ENCRYPTION_KEY = prevKey;
    if (prevRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("Auto (swap): an overlay_unavoidable candidate fails like a rejected one, is unbound, and the verdict is recorded", async () => {
    const { service, analyzeJobs } = build();
    const job = new ApifyJobContext();
    job.overlayPolicy = "swap";
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), input(job));
    expect(outcome).toMatchObject({ ok: false, reason: "apify_overlay_unavoidable", quality: { reframe: { status: "overlay_unavoidable", overlayUnavoidable: true, residualOverlayPct: 25, swapped: true, zoomPermille: 1350 } } });
    expect(media.assignScene).toHaveBeenCalledWith("asset-1", "u1", "staff", null);
    // the analysed window is the one the segment will use: after the start guard, as long as the segment
    expect(analyzeJobs).toHaveLength(1);
    expect(analyzeJobs[0]).toMatchObject({ origin: "apify", source: { kind: "video", mediaAssetVersionId: "asset-1" }, durationMs: 5000 });
    expect(analyzeJobs[0]!.startMs).toBeGreaterThanOrEqual(0);
  });

  it("Auto (swap) also screens a clip taken from the project library (no unbind of an asset that was already there)", async () => {
    const { service } = build({ library: true });
    const job = new ApifyJobContext();
    job.overlayPolicy = "swap";
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), input(job));
    expect(outcome).toMatchObject({ ok: false, reason: "apify_overlay_unavoidable", quality: { reusedLibraryAsset: true, reframe: { swapped: true } } });
    expect(media.registerAsset).not.toHaveBeenCalled();
  });

  it("Studio (flag, the default): the candidate is kept and carries the flag + residualOverlayPct for the UI", async () => {
    const { service } = build();
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), input());
    expect(outcome).toMatchObject({ ok: true, data: { quality: { reframe: { status: "overlay_unavoidable", residualOverlayPct: 25, swapped: false } } } });
    expect(media.assignScene).not.toHaveBeenCalled();
  });

  it("Auto with REFRAME_AUTO_SWAP_ON_OVERLAY off keeps the candidate (flag only)", async () => {
    const { service } = build({ policy: { autoSwapOnOverlay: false } });
    const job = new ApifyJobContext();
    job.overlayPolicy = "swap";
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), input(job));
    expect(outcome).toMatchObject({ ok: true, data: { quality: { reframe: { overlayUnavoidable: true, swapped: false } } } });
  });

  it("an avoidable overlay is recorded as ok and never swaps", async () => {
    const { service } = build({ analyze: (job) => analyzeResult(job, plan({ overlayUnavoidable: false, residualOverlayPct: 0, zoomPermille: 1000 })) });
    const job = new ApifyJobContext();
    job.overlayPolicy = "swap";
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), input(job));
    expect(outcome).toMatchObject({ ok: true, data: { quality: { reframe: { status: "ok", overlayUnavoidable: false, swapped: false } } } });
  });

  it("an analysis that cannot run never blocks sourcing: flagged analysis_unavailable with the worker code (render decides)", async () => {
    const { service } = build({ analyze: () => new MediaJobClientError("RESULT_TIMEOUT", "no answer") });
    const job = new ApifyJobContext();
    job.overlayPolicy = "swap";
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), input(job));
    expect(outcome).toMatchObject({ ok: true, data: { quality: { reframe: { status: "analysis_unavailable", reason: "RESULT_TIMEOUT", swapped: false } } } });
  });

  it("when reframing is not enabled for apify, or no ReframeService exists, nothing is analysed and quality has no reframe key", async () => {
    const off = build({ policy: { enabledOrigins: new Set(["pexels"]) } });
    const a = await off.service.autoImportForSegment(projectId, "u1", "staff", account(), input());
    expect(off.analyzeJobs).toHaveLength(0);
    expect(a.ok && "reframe" in a.data.quality).toBe(false);
    const none = build({ withReframe: false });
    const b = await none.service.autoImportForSegment(projectId, "u1", "staff", account(), input());
    expect(b.ok && "reframe" in b.data.quality).toBe(false);
  });
});
