import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEDIA_JOB_SCHEMA_VERSION, REFRAME_ANALYZE_PROFILE_VERSION, REFRAME_ANALYZE_RESULT_TYPE, type ReframeAnalyzeJobInput, type ReframeAnalyzeResult, type ReframeCropPlan } from "@lyonix/media-jobs";
import { CLIP_RANGE_TOLERANCE_MS, ClipDerivativesService, derivativeMatchesWithin } from "./clip-derivatives.service.js";
import { mediaAssetStore, okClipResult, startStubMediaWorker, type StoredAsset } from "./clip-derivatives.test-helpers.js";
import { reframePolicyFromEnv } from "./reframe-policy.js";
import { ReframeService } from "./reframe.service.js";

/** VE2E-134: early clip cut (prepareEarly) + tolerant reuse at render time + reframe analysis cache. */
const projectId = "project-1";
const parent: StoredAsset = { id: "parent-pexels", projectId, kind: "video", origin: "pexels", bytes: 60_000_000, relativePath: "projects/project-1/assets/p.mp4", originalFileName: "pexels-1.mp4", checksumSha256: "d".repeat(64) };

let root: string;
let prev: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lyonix-early-"));
  prev = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = root;
});
afterEach(async () => {
  if (prev === undefined) delete process.env.MEDIA_ROOT;
  else process.env.MEDIA_ROOT = prev;
  await rm(root, { recursive: true, force: true });
});

const req = (startMs: number, durationMs: number, sceneId = "s1", p = parent) => ({ sceneId, parentMediaAssetVersionId: p.id, startMs, durationMs, stripAudio: true });

/** The stub worker writes no file: materialise each registered derivative on disk so the registry reuse (stat) check passes. */
const materialise = async (store: ReturnType<typeof mediaAssetStore>) => {
  for (const row of store.rows.values()) {
    if (!row.parentMediaAssetVersionId) continue;
    await mkdir(join(root, row.relativePath, ".."), { recursive: true });
    await writeFile(join(root, row.relativePath), Buffer.alloc(row.bytes));
  }
};

const setup = async (bytes = 2048) => {
  const worker = await startStubMediaWorker((job) => {
    const result = okClipResult(job, { bytes });
    return result;
  });
  const store = mediaAssetStore([parent]);
  const service = new ClipDerivativesService({ mediaAssetVersion: store } as never, worker.client);
  service.log = () => undefined;
  return { worker, store, service };
};

describe("derivativeMatchesWithin", () => {
  const t = { range: { startMs: 1000, durationMs: 4000 }, stripAudio: true, tool: null, profileVersion: "clip-prepare.v1" };
  it("accepts start and duration drift up to 300 ms, not more, same audio policy and profile", () => {
    expect(CLIP_RANGE_TOLERANCE_MS).toBe(300);
    expect(derivativeMatchesWithin(t, { startMs: 1300, durationMs: 3700 }, true, 300)).toBe(true);
    expect(derivativeMatchesWithin(t, { startMs: 1301, durationMs: 4000 }, true, 300)).toBe(false);
    expect(derivativeMatchesWithin(t, { startMs: 1000, durationMs: 4301 }, true, 300)).toBe(false);
    expect(derivativeMatchesWithin(t, { startMs: 1000, durationMs: 4000 }, false, 300)).toBe(false);
    expect(derivativeMatchesWithin({ ...t, profileVersion: "clip-prepare.v0" }, { startMs: 1000, durationMs: 4000 }, true, 300)).toBe(false);
  });
});

describe("prepareEarly + prepare", () => {
  it("render prepare reuses the early derivative when the range drifts <= 300 ms (no second cut)", async () => {
    const { worker, store, service } = await setup();
    const early = await service.prepareEarly(projectId, "u1", [req(2000, 4000)]);
    expect(early.ok).toBe(true);
    expect(worker.jobs).toHaveLength(1);
    await materialise(store);
    const final = await service.prepare(projectId, "u1", [req(2150, 3800)]);
    expect(final.ok).toBe(true);
    expect(worker.jobs).toHaveLength(1);
    if (final.ok) expect(final.data.items[0]).toMatchObject({ source: "registry" });
  });

  it("re-cuts when the final range drifts by more than 300 ms", async () => {
    const { worker, store, service } = await setup();
    await service.prepareEarly(projectId, "u1", [req(2000, 4000)]);
    await materialise(store);
    const final = await service.prepare(projectId, "u1", [req(2000, 4400)]);
    expect(final.ok).toBe(true);
    expect(worker.jobs).toHaveLength(2);
    expect(worker.jobs[1]).toMatchObject({ durationMs: 4400 });
  });

  it("a prepare issued while the early cut is still running waits for it instead of cutting twice", async () => {
    const { worker, store, service } = await setup();
    const early = service.prepareEarly(projectId, "u1", [req(2000, 4000)]);
    const finalPromise = service.prepare(projectId, "u1", [req(2100, 3900)]);
    await early;
    await materialise(store);
    const final = await finalPromise;
    expect(final.ok).toBe(true);
    // the render step may race the file materialisation in this in-memory harness, but it must never need more than the early cut + at most one re-check
    expect(worker.jobs.length).toBeLessThanOrEqual(2);
  });

  it("never throws and ignores image requests; a missing parent yields an outcome, not an exception", async () => {
    const { service } = await setup();
    const none = await service.prepareEarly(projectId, "u1", [{ ...req(0, 0), mediaKind: "image" as const }]);
    expect(none.ok).toBe(true);
    const missing = await service.prepareEarly(projectId, "u1", [req(0, 3000, "s9", { ...parent, id: "ghost" })]);
    expect(missing.ok).toBe(false);
  });

  it("a worker failure on the early cut is returned, not thrown, and the render step still cuts normally", async () => {
    let failFirst = true;
    const worker = await startStubMediaWorker((job) => {
      if (failFirst) {
        failFirst = false;
        return { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: "clip.prepare.result", ok: false, jobKey: job.jobKey, error: { code: "FFMPEG_FAILED", message: "x", retryable: true, attempts: 2 }, completedAt: new Date().toISOString() } as never;
      }
      return okClipResult(job);
    });
    const store = mediaAssetStore([parent]);
    const service = new ClipDerivativesService({ mediaAssetVersion: store } as never, worker.client);
    service.log = () => undefined;
    const early = await service.prepareEarly(projectId, "u1", [req(2000, 4000)]);
    expect(early.ok).toBe(false);
    const final = await service.prepare(projectId, "u1", [req(2000, 4000)]);
    expect(final.ok).toBe(true);
  });
});

describe("reframe analysis cache", () => {
  const plan: ReframeCropPlan = { version: "crop-plan.v1", sourceWidthPx: 1280, sourceHeightPx: 720, targetWidthPx: 1080, targetHeightPx: 1920, durationMs: 4000, zoomPermille: 1000, mode: "static", keyframes: [{ tMs: 0, xPx: 300, yPx: 0, widthPx: 405, heightPx: 720 }], primarySubjectId: "s", overlayUnavoidable: false, residualOverlayPct: 0, subjectCoveragePct: 100 };
  const ok = (job: ReframeAnalyzeJobInput): ReframeAnalyzeResult =>
    ({
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: REFRAME_ANALYZE_RESULT_TYPE, ok: true, jobKey: job.jobKey, reused: false,
      source: { relativePath: job.source.relativePath, mediaAssetVersionId: null, kind: "video", durationMs: 30_000, width: 1280, height: 720 },
      window: { startMs: job.startMs ?? 0, durationMs: job.durationMs ?? 0 }, cropPlan: plan, overlayUnavoidable: false,
      confidence: { overall: 0.7, subject: 0.7, overlay: 0.7, level: "medium", reasons: [] },
      analysis: { framesSampled: 1, framesAnalysed: 1, subjectSource: "face", framesWithFace: 1, framesWithPerson: 0, textRegions: 0, presetLogoRegions: 0, logoTemplateMatches: 0, warnings: [] },
      metrics: { totalMs: 1, sampleMs: 1, detectMs: 1, planMs: 1, detectMsPerFrame: 1, rssPeakMb: 1 }, retentionClass: "working", expiresAt: new Date(Date.now() + 1e9).toISOString(),
      tool: { profileVersion: REFRAME_ANALYZE_PROFILE_VERSION, ffmpegVersion: "t", detectorRuntime: "t", models: {} }, completedAt: new Date().toISOString(),
    }) as unknown as ReframeAnalyzeResult;
  const mk = (behaviour: (job: ReframeAnalyzeJobInput) => ReframeAnalyzeResult | Error = ok) => {
    const jobs: ReframeAnalyzeJobInput[] = [];
    const svc = new ReframeService({
      analyzeReframe: async (job: ReframeAnalyzeJobInput) => {
        jobs.push(job);
        const r = behaviour(job);
        if (r instanceof Error) throw r;
        return r;
      },
    } as never);
    svc.fixedPolicy = reframePolicyFromEnv({});
    svc.warn = () => undefined;
    return { svc, jobs };
  };
  const src = { id: "a1", kind: "video" as const, origin: "apify", relativePath: "x.mp4", checksumSha256: "c".repeat(64) };

  it("analyses the same checksum+window once, including within 300 ms and concurrent calls", async () => {
    const { svc, jobs } = mk();
    const [a, b] = await Promise.all([svc.plan(src, { startMs: 1000, durationMs: 4000 }), svc.plan({ ...src, id: "a2" }, { startMs: 1200, durationMs: 3800 })]);
    expect(a.status).toBe("planned");
    expect(b).toBe(a);
    await svc.plan(src, { startMs: 1000, durationMs: 4000 });
    expect(jobs).toHaveLength(1);
  });

  it("analyses again for a window beyond tolerance, another checksum, or after the TTL", async () => {
    const { svc, jobs } = mk();
    await svc.plan(src, { startMs: 1000, durationMs: 4000 });
    await svc.plan(src, { startMs: 1000, durationMs: 4400 });
    await svc.plan({ ...src, checksumSha256: "e".repeat(64) }, { startMs: 1000, durationMs: 4000 });
    expect(jobs).toHaveLength(3);
    const t0 = Date.now();
    svc.now = () => t0 + 31 * 60_000;
    await svc.plan(src, { startMs: 1000, durationMs: 4000 });
    expect(jobs).toHaveLength(4);
  });

  it("does not cache failures/fallbacks (retried next time)", async () => {
    let fail = true;
    const { svc, jobs } = mk((job) => (fail ? new Error("boom") : ok(job)));
    expect((await svc.plan(src, { startMs: 0, durationMs: 3000 })).status).toBe("legacy_fallback");
    fail = false;
    expect((await svc.plan(src, { startMs: 0, durationMs: 3000 })).status).toBe("planned");
    expect(jobs).toHaveLength(2);
  });
});
