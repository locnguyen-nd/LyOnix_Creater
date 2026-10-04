import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildClipPrepareJobKey,
  cropPlanDigest,
  MEDIA_JOB_SCHEMA_VERSION,
  MediaJobClientError,
  REFRAME_ANALYZE_PROFILE_VERSION,
  REFRAME_ANALYZE_RESULT_TYPE,
  type ReframeAnalyzeJobInput,
  type ReframeAnalyzeResult,
  type ReframeCropPlan,
} from "@lyonix/media-jobs";
import { ClipDerivativesService, derivativeMatches, imageDerivativeMatches } from "./clip-derivatives.service.js";
import { mediaAssetStore, startStubMediaWorker, type StoredAsset } from "./clip-derivatives.test-helpers.js";
import type { ReframeAnalyzer } from "./media-jobs.gateway.js";
import { reframePolicyFromEnv, type ReframePolicy } from "./reframe-policy.js";
import { ReframeService } from "./reframe.service.js";

/** VE2E-67: the crop plan from reframe.analyze reaches clip.prepare, is part of the derivative identity, and every failure/flag is explicit. */
const projectId = "project-1";
const sha = (char: string) => char.repeat(64);
const apifyVideo: StoredAsset = { id: "v-apify", projectId, kind: "video", origin: "apify", bytes: 20_000_000, relativePath: "projects/project-1/assets/a.mp4", originalFileName: "tiktok.mp4", checksumSha256: sha("c") };
const pexelsVideo: StoredAsset = { id: "v-pexels", projectId, kind: "video", origin: "pexels", bytes: 60_000_000, relativePath: "projects/project-1/assets/p.mp4", originalFileName: "pexels.mp4", checksumSha256: sha("d") };
const apifyImage: StoredAsset = { id: "i-apify", projectId, kind: "image", origin: "apify", bytes: 900_000, relativePath: "projects/project-1/assets/pin.jpg", originalFileName: "pin.jpg", checksumSha256: sha("e") };
const uploadImage: StoredAsset = { id: "i-upload", projectId, kind: "image", origin: "upload", bytes: 900_000, relativePath: "projects/project-1/assets/u.jpg", originalFileName: "u.jpg", checksumSha256: sha("f") };

const plan = (overrides: Partial<ReframeCropPlan> = {}): ReframeCropPlan => ({
  version: "crop-plan.v1",
  sourceWidthPx: 1280,
  sourceHeightPx: 720,
  targetWidthPx: 1080,
  targetHeightPx: 1920,
  durationMs: 4000,
  zoomPermille: 1000,
  mode: "static",
  keyframes: [{ tMs: 0, xPx: 300, yPx: 0, widthPx: 405, heightPx: 720 }],
  primarySubjectId: "subject-1",
  overlayUnavoidable: false,
  residualOverlayPct: 0,
  subjectCoveragePct: 100,
  ...overrides,
});

const analyzeOk = (job: ReframeAnalyzeJobInput, cropPlan: ReframeCropPlan): ReframeAnalyzeResult => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: REFRAME_ANALYZE_RESULT_TYPE,
  ok: true,
  jobKey: job.jobKey,
  reused: false,
  source: { relativePath: job.source.relativePath, mediaAssetVersionId: job.source.mediaAssetVersionId ?? null, kind: job.source.kind ?? "video", durationMs: 30_000, width: 1280, height: 720 },
  window: { startMs: job.startMs ?? 0, durationMs: job.durationMs ?? 0 },
  cropPlan,
  overlayUnavoidable: cropPlan.overlayUnavoidable,
  confidence: { overall: 0.7, subject: 0.7, overlay: 0.7, level: "medium", reasons: [] },
  analysis: { framesSampled: 7, framesAnalysed: 7, subjectSource: "face", framesWithFace: 7, framesWithPerson: 0, textRegions: 0, presetLogoRegions: 4, logoTemplateMatches: 0, warnings: ["preset_logo_corners"] },
  metrics: { totalMs: 5000, sampleMs: 2000, detectMs: 3000, planMs: 1, detectMsPerFrame: 400, rssPeakMb: 300 },
  retentionClass: "working",
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  tool: { profileVersion: REFRAME_ANALYZE_PROFILE_VERSION, ffmpegVersion: "ffmpeg version test", detectorRuntime: "onnxruntime-node@test", models: { face: "yunet@test" } },
  completedAt: new Date().toISOString(),
});

let mediaRootDir: string;
let previousMediaRoot: string | undefined;
beforeEach(async () => {
  mediaRootDir = await mkdtemp(join(tmpdir(), "lyonix-reframe-deriv-"));
  previousMediaRoot = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = mediaRootDir;
});
afterEach(async () => {
  if (previousMediaRoot === undefined) delete process.env.MEDIA_ROOT;
  else process.env.MEDIA_ROOT = previousMediaRoot;
  await rm(mediaRootDir, { recursive: true, force: true });
});

type AnalyzeBehavior = (job: ReframeAnalyzeJobInput) => ReframeAnalyzeResult | Error;
const setup = async (options: { analyze?: AnalyzeBehavior; policy?: Partial<ReframePolicy>; assets?: StoredAsset[] } = {}) => {
  const worker = await startStubMediaWorker();
  const store = mediaAssetStore(options.assets ?? [apifyVideo, pexelsVideo, apifyImage, uploadImage]);
  const analyzeJobs: ReframeAnalyzeJobInput[] = [];
  const analyzer: ReframeAnalyzer = {
    analyzeReframe: async (job) => {
      analyzeJobs.push(job);
      const behavior = options.analyze ?? ((j: ReframeAnalyzeJobInput) => analyzeOk(j, plan()));
      const result = behavior(job);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const reframe = new ReframeService(analyzer as never);
  reframe.fixedPolicy = { ...reframePolicyFromEnv({}), ...options.policy };
  const warnings: string[] = [];
  reframe.warn = (message) => warnings.push(message);
  const service = new ClipDerivativesService({ mediaAssetVersion: store } as never, worker.client, reframe);
  const logs: string[] = [];
  service.log = (message) => logs.push(message);
  return { worker, store, service, logs, warnings, analyzeJobs };
};
const videoRequest = (parent: StoredAsset, sceneId = "s1") => ({ sceneId, parentMediaAssetVersionId: parent.id, startMs: 2000, durationMs: 4000, stripAudio: true });
const imageRequest = (parent: StoredAsset, sceneId = "s1") => ({ sceneId, parentMediaAssetVersionId: parent.id, startMs: 0, durationMs: 0, stripAudio: true, mediaKind: "image" as const });

describe("reframePolicyFromEnv", () => {
  it("defaults: on, apify only, legacy fallback + auto swap on", () => {
    const policy = reframePolicyFromEnv({});
    expect([...policy.enabledOrigins]).toEqual(["apify"]);
    expect(policy).toMatchObject({ enabled: true, legacyFallback: true, autoSwapOnOverlay: true, analyzeTimeoutMs: 180_000 });
  });
  it("parses origin lists, all/none, kill switch and bad values", () => {
    expect([...reframePolicyFromEnv({ REFRAME_ENABLED_ORIGINS: "Apify, pexels,upload" }).enabledOrigins]).toEqual(["apify", "pexels", "upload"]);
    expect(reframePolicyFromEnv({ REFRAME_ENABLED_ORIGINS: "all" }).enabledOrigins.has("*")).toBe(true);
    expect(reframePolicyFromEnv({ REFRAME_ENABLED_ORIGINS: "none" }).enabledOrigins.size).toBe(0);
    expect(reframePolicyFromEnv({ REFRAME_ENABLED: "0" }).enabled).toBe(false);
    expect(reframePolicyFromEnv({ REFRAME_LEGACY_FALLBACK: "off", REFRAME_AUTO_SWAP_ON_OVERLAY: "false" })).toMatchObject({ legacyFallback: false, autoSwapOnOverlay: false });
    expect(reframePolicyFromEnv({ REFRAME_ANALYZE_TIMEOUT_MS: "5" }).analyzeTimeoutMs).toBe(180_000);
    expect(reframePolicyFromEnv({ REFRAME_ENABLED_ORIGINS: "bad origin!" }).enabledOrigins.size).toBe(0);
  });
});

describe("derivativeMatches / imageDerivativeMatches with crop lineage", () => {
  const crop = { planSha256: sha("1"), planVersion: "crop-plan.v1", mode: "static" as const, zoomPermille: 1000, overlayUnavoidable: false, residualOverlayPct: 0, subjectCoveragePct: 100, cropProfileVersion: "crop-apply.v1" };
  const range = { startMs: 1000, durationMs: 4000 };
  it("a derivative cut with a plan is reused only for the same plan; a plan-less one only when no plan applies", () => {
    const legacy = { range, stripAudio: true, tool: null, profileVersion: null };
    const cropped = { ...legacy, crop };
    expect(derivativeMatches(legacy, range, true)).toBe(true);
    expect(derivativeMatches(legacy, range, true, sha("1"))).toBe(false);
    expect(derivativeMatches(cropped, range, true)).toBe(false);
    expect(derivativeMatches(cropped, range, true, sha("1"))).toBe(true);
    expect(derivativeMatches(cropped, range, true, sha("2"))).toBe(false);
  });
  it("image derivatives match on the plan digest alone", () => {
    const image = { range: null, stripAudio: true, tool: null, profileVersion: null, crop };
    expect(imageDerivativeMatches(image, sha("1"))).toBe(true);
    expect(imageDerivativeMatches(image, sha("2"))).toBe(false);
    expect(imageDerivativeMatches({ ...image, crop: undefined } as never, sha("1"))).toBe(false);
  });
});

describe("ClipDerivativesService.prepare + reframe (VE2E-67)", () => {
  it("apify video: analyses the exact range, passes the cropPlan to clip.prepare and records the lineage", async () => {
    const { worker, store, service, analyzeJobs } = await setup();
    const outcome = await service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(analyzeJobs).toHaveLength(1);
    expect(analyzeJobs[0]).toMatchObject({ startMs: 2000, durationMs: 4000, origin: "apify", source: { kind: "video", mediaAssetVersionId: "v-apify", sourceSha256: sha("c") } });
    const expectedPlan = plan();
    expect(worker.jobs[0]!.cropPlan).toEqual(expectedPlan);
    expect(worker.jobs[0]!.jobKey).toBe(buildClipPrepareJobKey({ sourceMediaAssetVersionId: "v-apify", startMs: 2000, durationMs: 4000, stripAudio: true, cropPlan: expectedPlan }));
    expect(worker.jobs[0]!.jobKey).not.toBe(buildClipPrepareJobKey({ sourceMediaAssetVersionId: "v-apify", startMs: 2000, durationMs: 4000, stripAudio: true }));
    const row = store.rows.get(outcome.data.derivativeBySceneId.get("s1")!)!;
    expect((row.transform as any).crop).toMatchObject({ planSha256: cropPlanDigest(expectedPlan), planVersion: "crop-plan.v1", mode: "static", zoomPermille: 1000, overlayUnavoidable: false });
    expect((row.transform as any).range).toEqual({ startMs: 2000, durationMs: 4000 });
    const derivative = (row.provenance as any).derivative;
    expect(derivative.cropPlan).toEqual(expectedPlan);
    expect(derivative.reframe).toMatchObject({ status: "planned", analysisJobKey: analyzeJobsKey(analyzeJobs), cropProfileVersion: "crop-apply.v1", applied: "crop", outputSha256: sha("a"), tool: { models: { face: "yunet@test" } } });
    expect(row.checksumSha256).toBe(sha("a"));
    expect(outcome.data.items[0]!.reframe).toMatchObject({ status: "planned", overlayUnavoidable: false, zoomPermille: 1000, confidenceLevel: "medium" });
  });

  it("origins that are not enabled keep the legacy path: no analysis, legacy jobKey, no cropPlan", async () => {
    const { worker, service, analyzeJobs } = await setup();
    const outcome = await service.prepare(projectId, "user-1", [videoRequest(pexelsVideo)]);
    expect(outcome.ok).toBe(true);
    expect(analyzeJobs).toHaveLength(0);
    expect(worker.jobs[0]!.cropPlan).toBeUndefined();
    expect(worker.jobs[0]!.jobKey).toBe(buildClipPrepareJobKey({ sourceMediaAssetVersionId: "v-pexels", startMs: 2000, durationMs: 4000, stripAudio: true }));
    if (outcome.ok) expect(outcome.data.items[0]!.reframe).toMatchObject({ status: "skipped" });
  });

  it("can be enabled for another origin by config", async () => {
    const { analyzeJobs, service, worker } = await setup({ policy: { enabledOrigins: new Set(["apify", "pexels"]) } });
    await service.prepare(projectId, "user-1", [videoRequest(pexelsVideo)]);
    expect(analyzeJobs).toHaveLength(1);
    expect(worker.jobs[0]!.cropPlan).toBeDefined();
  });

  it("REFRAME_ENABLED off disables every origin", async () => {
    const { analyzeJobs, service } = await setup({ policy: { enabled: false } });
    await service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    expect(analyzeJobs).toHaveLength(0);
  });

  it("MODEL_NOT_AVAILABLE with the fallback allowed: LOUD warning, legacy cut, flag in the result and the provenance", async () => {
    const failure = (job: ReframeAnalyzeJobInput): ReframeAnalyzeResult => ({
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: REFRAME_ANALYZE_RESULT_TYPE,
      ok: false,
      jobKey: job.jobKey,
      error: { code: "MODEL_NOT_AVAILABLE", message: "run models:download", retryable: false, attempts: 1 },
      completedAt: new Date().toISOString(),
    });
    const { worker, store, service, warnings } = await setup({ analyze: failure });
    const outcome = await service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(worker.jobs[0]!.cropPlan).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/WARNING analysis unavailable.*MODEL_NOT_AVAILABLE.*legacy centre crop/);
    expect(outcome.data.items[0]!.reframe).toMatchObject({ status: "legacy_fallback", fallbackCode: "MODEL_NOT_AVAILABLE" });
    const row = store.rows.get(outcome.data.derivativeBySceneId.get("s1")!)!;
    expect((row.provenance as any).derivative.reframe).toMatchObject({ status: "legacy_fallback", fallbackCode: "MODEL_NOT_AVAILABLE" });
    expect((row.transform as any).crop).toBeUndefined();
  });

  it("a worker/timeout error behaves the same way (never silent)", async () => {
    const { service, warnings, worker } = await setup({ analyze: () => new MediaJobClientError("RESULT_TIMEOUT", "no answer") });
    const outcome = await service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    expect(outcome.ok).toBe(true);
    expect(worker.jobs).toHaveLength(1);
    expect(warnings.join("\n")).toContain("RESULT_TIMEOUT");
  });

  it("with the fallback switched off an analysis failure fails the preparation and nothing is cut", async () => {
    const { service, worker, warnings } = await setup({ analyze: () => new MediaJobClientError("BROKER_UNAVAILABLE", "down"), policy: { legacyFallback: false } });
    const outcome = await service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome).toMatchObject({ code: "MEDIA_PREPARE_FAILED", retryable: true });
    expect(worker.jobs).toHaveLength(0);
    expect(warnings.join("\n")).toContain("legacy fallback is disabled");
  });

  it("overlay_unavoidable: still cuts the best-effort plan but flags it (residualOverlayPct) for Studio", async () => {
    const flagged = plan({ overlayUnavoidable: true, residualOverlayPct: 27, zoomPermille: 1350 });
    const { service, store, warnings } = await setup({ analyze: (job) => analyzeOk(job, flagged) });
    const outcome = await service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.items[0]!.reframe).toMatchObject({ status: "planned", overlayUnavoidable: true, residualOverlayPct: 27, zoomPermille: 1350 });
    expect((store.rows.get(outcome.data.derivativeBySceneId.get("s1")!)!.transform as any).crop).toMatchObject({ overlayUnavoidable: true, residualOverlayPct: 27 });
    expect(warnings.join("\n")).toContain("overlay_unavoidable");
  });

  it("reuses a derivative for the same plan, cuts again for a different plan, and never reuses a plan-less legacy derivative for a plan", async () => {
    const ctx = await setup();
    const first = await ctx.service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    if (first.ok) await materialize(ctx.store.rows.get(first.data.derivativeBySceneId.get("s1")!)!);
    const second = await ctx.service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    expect(ctx.worker.jobs).toHaveLength(1);
    if (first.ok && second.ok) {
      expect(second.data.items[0]!.source).toBe("registry");
      expect(second.data.derivativeBySceneId.get("s1")).toBe(first.data.derivativeBySceneId.get("s1"));
    }
    const moved = await setup({ analyze: (job) => analyzeOk(job, plan({ keyframes: [{ tMs: 0, xPx: 700, yPx: 0, widthPx: 405, heightPx: 720 }] })), assets: [apifyVideo] });
    const legacyRow: StoredAsset = { ...apifyVideo, id: "legacy", parentMediaAssetVersionId: apifyVideo.id, bytes: 1234, relativePath: "working/media-jobs/legacy/clip.mp4", transform: { range: { startMs: 2000, durationMs: 4000 }, stripAudio: true, tool: null, profileVersion: null }, expiresAt: new Date(Date.now() + 5 * 24 * 3600 * 1000), createdAt: new Date() };
    moved.store.rows.set("legacy", legacyRow);
    await materialize(legacyRow);
    const fresh = await moved.service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    expect(fresh.ok && fresh.data.items[0]!.source).toBe("worker"); // legacy row (no crop) is not a match for a planned cut
  });

  it("apify image: optional reframe makes a cropped JPEG derivative (range null, crop lineage) and is not counted as a clip", async () => {
    const { worker, store, service } = await setup();
    const onReady = vi.fn(async () => undefined);
    const outcome = await service.prepare(projectId, "user-1", [imageRequest(apifyImage)], onReady);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(worker.jobs[0]).toMatchObject({ source: { kind: "image", mediaAssetVersionId: "i-apify" }, startMs: 0, durationMs: 0 });
    expect(worker.jobs[0]!.cropPlan).toBeDefined();
    const row = store.rows.get(outcome.data.derivativeBySceneId.get("s1")!)!;
    expect(row).toMatchObject({ kind: "image", mimeType: "image/jpeg", parentMediaAssetVersionId: "i-apify", durationMs: null });
    expect((row.transform as any).range).toBeNull();
    expect((row.transform as any).crop.planSha256).toBe(cropPlanDigest(plan()));
    expect(onReady).not.toHaveBeenCalled();
  });

  it("images of non-enabled origins, and images whose analysis failed, keep the original (no derivative, no error)", async () => {
    const upload = await setup();
    const a = await upload.service.prepare(projectId, "user-1", [imageRequest(uploadImage)]);
    expect(a.ok && a.data.derivativeBySceneId.size).toBe(0);
    expect(upload.analyzeJobs).toHaveLength(0);
    const failing = await setup({ analyze: () => new MediaJobClientError("MEDIA_WORKER_NOT_CONFIGURED", "no broker") });
    const b = await failing.service.prepare(projectId, "user-1", [imageRequest(apifyImage)]);
    expect(b.ok && b.data.derivativeBySceneId.size).toBe(0);
    expect(failing.worker.jobs).toHaveLength(0);
    expect(failing.warnings.join("\n")).toContain("MEDIA_WORKER_NOT_CONFIGURED");
  });

  it("without a ReframeService the behaviour is exactly the pre-VE2E-67 one", async () => {
    const worker = await startStubMediaWorker();
    const store = mediaAssetStore([apifyVideo]);
    const service = new ClipDerivativesService({ mediaAssetVersion: store } as never, worker.client);
    service.log = () => undefined;
    const outcome = await service.prepare(projectId, "user-1", [videoRequest(apifyVideo)]);
    expect(outcome.ok).toBe(true);
    expect(worker.jobs[0]!.cropPlan).toBeUndefined();
    if (outcome.ok) expect(outcome.data.items[0]!.reframe).toMatchObject({ status: "skipped" });
  });
});

/** Puts a file of the registered size where the derivative row points, so the registry reuse check (file on disk) can pass. */
const materialize = async (row: StoredAsset) => {
  await mkdir(join(mediaRootDir, row.relativePath, ".."), { recursive: true });
  await writeFile(join(mediaRootDir, row.relativePath), Buffer.alloc(row.bytes));
};
const analyzeJobsKey = (jobs: ReframeAnalyzeJobInput[]) => jobs[0]!.jobKey;
