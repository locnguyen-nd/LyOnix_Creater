import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaJobClientError, COMPOSE_PROFILE_VERSION, MEDIA_JOB_SCHEMA_VERSION, VIDEO_COMPOSE_RESULT_TYPE, type VideoComposeJobInput, type VideoComposeResult } from "@lyonix/media-jobs";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1 } from "@lyonix/render-recipes";
import { InternalRenderService, loadRouterConfig, localUsdPerCpuHour } from "./internal-render.service.js";
import type { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import type { VideoComposer } from "./media-jobs.gateway.js";

const projectId = "project-1";
const LYONIX_ACCOUNT = "acct-lyonix";
const CM_ACCOUNT = "acct-creatomate";

type Row = Record<string, any>;

const matches = (row: Row, where: Row | undefined): boolean =>
  Object.entries(where ?? {}).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return (cond as any).in.includes(value);
      if ("notIn" in cond) return !(cond as any).notIn.includes(value);
      if ("gte" in cond) return value != null && value >= (cond as any).gte;
      if ("lt" in cond) return value != null && value < (cond as any).lt;
      if ("not" in cond) return (cond as any).not === null ? value != null : value !== (cond as any).not;
    }
    return value === cond;
  });

const fakeDb = () => {
  const jobs = new Map<string, Row>();
  let seq = 0;
  const stored = {
    timelineVersion: [] as Row[],
    templateSnapshot: [] as Row[],
    providerAccount: [{ id: CM_ACCOUNT, provider: "creatomate", role: "render" }] as Row[],
    audioVersion: [] as Row[],
    subtitleVersion: [] as Row[],
    mediaAssetVersion: [] as Row[],
  };
  const prisma: any = {
    timelineVersion: { findUnique: async ({ where }: any) => stored.timelineVersion.find((r) => r.id === where.id) ?? null },
    templateSnapshot: {
      findUnique: async ({ where }: any) => stored.templateSnapshot.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: any) => stored.templateSnapshot.filter((r) => where.id.in.includes(r.id)),
    },
    providerAccount: { findFirst: async ({ where }: any) => stored.providerAccount.find((r) => matches(r, where)) ?? null },
    audioVersion: { findMany: async ({ where }: any) => stored.audioVersion.filter((r) => where.id.in.includes(r.id)) },
    subtitleVersion: { findMany: async ({ where }: any) => stored.subtitleVersion.filter((r) => where.audioVersionId.in.includes(r.audioVersionId)).sort((a, b) => b.version - a.version) },
    sceneDraftVersion: { findMany: async () => [] },
    mediaAssetVersion: { findMany: async ({ where }: any) => stored.mediaAssetVersion.filter((r) => where.id.in.includes(r.id) && r.projectId === where.projectId && !r.deletedAt) },
    renderJob: {
      create: vi.fn(async ({ data, select }: any) => {
        if ([...jobs.values()].some((j) => j.requestFingerprint === data.requestFingerprint)) {
          const { Prisma } = await import("@lyonix/db");
          throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6.19.3" });
        }
        const id = `job-${++seq}`;
        const row = { id, attempts: 1, progress: null, resultUrl: null, snapshotUrl: null, resultExpiresAt: null, costAmount: null, costCurrency: null, renderDurationMs: null, lastError: null, externalJobId: null, routeReason: null, fallbackOfJobId: null, clipsTotal: 0, clipsReady: 0, createdAt: new Date(), updatedAt: new Date(), completedAt: null, preparationLeaseUntil: null, ...data };
        jobs.set(id, row);
        return select ? { id } : row;
      }),
      findUnique: async ({ where }: any) => (where.id ? jobs.get(where.id) : [...jobs.values()].find((j) => j.requestFingerprint === where.requestFingerprint)) ?? null,
      findFirst: async ({ where }: any) => [...jobs.values()].find((j) => matches(j, where)) ?? null,
      findMany: async ({ where, take }: any) => [...jobs.values()].filter((j) => matches(j, where)).slice(0, take ?? 99),
      count: async ({ where }: any) => [...jobs.values()].filter((j) => matches(j, where)).length,
      aggregate: async ({ where }: any) => ({ _sum: { costAmount: [...jobs.values()].filter((j) => matches(j, where) && j.costAmount != null).reduce((s, j) => s + Number(j.costAmount), 0) } }),
      update: async ({ where, data }: any) => {
        const row = jobs.get(where.id)!;
        const next: Row = { ...row, updatedAt: new Date() };
        for (const [k, v] of Object.entries(data)) next[k] = v && typeof v === "object" && "increment" in (v as any) ? (row[k] ?? 0) + (v as any).increment : v;
        jobs.set(row.id, next);
        return next;
      },
      updateMany: vi.fn(async ({ where, data }: any) => {
        const found = [...jobs.values()].filter((j) => matches(j, where));
        for (const row of found) {
          const next: Row = { ...row, updatedAt: new Date() };
          for (const [k, v] of Object.entries(data)) next[k] = v;
          jobs.set(row.id, next);
        }
        return { count: found.length };
      }),
    },
  };
  return { prisma, jobs, stored };
};

const scenesJson = [
  { sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "m1", audioVersionId: "a1", subtitleVersionId: null, screenTextOverride: null },
  { sceneId: "s2", orderIndex: 1, mediaAssetVersionId: "m2", audioVersionId: "a2", subtitleVersionId: null, screenTextOverride: "手入力" },
];

const seed = (db: ReturnType<typeof fakeDb>, over: { rolloutPercent?: number; fallback?: boolean } = {}) => {
  const { stored } = db;
  stored.providerAccount.push({ id: LYONIX_ACCOUNT, provider: "lyonix", role: "render" });
  stored.templateSnapshot.push(
    { id: "snap-lyonix", providerAccountId: LYONIX_ACCOUNT, engine: "lyonix", rolloutPercent: over.rolloutPercent ?? 100, fallbackSnapshotIds: over.fallback === false ? [] : ["snap-cm"], rawTemplate: NEWS_RECAP_BROADCAST_TELOP_JP_V1 },
    { id: "snap-cm", providerAccountId: CM_ACCOUNT, engine: "creatomate", rolloutPercent: 0, fallbackSnapshotIds: [], rawTemplate: {} },
  );
  stored.timelineVersion.push({ id: "tl-1", projectId, status: "approved", templateSnapshotId: "snap-lyonix", scenes: scenesJson, optionValues: { headline: "経済対策" } });
  stored.audioVersion.push(
    { id: "a1", mediaAssetVersionId: "au1", durationMs: 3000, alignment: { characters: Array.from("こんにちは"), characterStartTimesSeconds: [0, 0.3, 0.6, 0.9, 1.2], characterEndTimesSeconds: [0.3, 0.6, 0.9, 1.2, 1.5] } },
    { id: "a2", mediaAssetVersionId: "au2", durationMs: 2500, alignment: null },
  );
  stored.subtitleVersion.push({ audioVersionId: "a1", version: 1, segments: [{ text: "こんにちは", startMs: 0, endMs: 1500 }] });
  for (const [id, kind, path, ms] of [["m1", "image", "projects/p/m1.jpg", null], ["m2", "video", "projects/p/m2.mp4", 10_000], ["au1", "audio", "projects/p/au1.mp3", 3000], ["au2", "audio", "projects/p/au2.mp3", 2500]] as const) {
    stored.mediaAssetVersion.push({ id, projectId, kind, durationMs: ms, relativePath: path, checksumSha256: `${id}`.padEnd(64, "0"), deletedAt: null });
  }
};

const okResult = (job: VideoComposeJobInput, over: Record<string, unknown> = {}): VideoComposeResult => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: VIDEO_COMPOSE_RESULT_TYPE,
  ok: true,
  jobKey: job.jobKey,
  reused: false,
  output: { relativePath: "working/renders/abc/video.mp4", mimeType: "video/mp4", sha256: "f".repeat(64), bytes: 12345, durationMs: 5500, width: 1080, height: 1920, fps: 60 },
  thumbnail: { relativePath: "working/renders/abc/thumb.jpg", mimeType: "image/jpeg", sha256: "e".repeat(64), bytes: 99, width: 1080, height: 1920 },
  qc: { passed: true, checks: [{ code: "QC_FPS", ok: true, measured: "60", expected: "60", message: "m" }], measured: {} as never },
  metrics: { renderMs: 80_000, cpuSeconds: 200, x264Preset: "faster", x264Threads: 4 },
  retentionClass: "working",
  expiresAt: "2026-10-11T00:00:00.000Z",
  tool: { profileVersion: COMPOSE_PROFILE_VERSION, ffmpegVersion: "ffmpeg 6", recipe: job.recipe },
  completedAt: "2026-10-04T00:00:00.000Z",
  ...over,
});

const failResult = (job: VideoComposeJobInput, code: string, qc: unknown = null): VideoComposeResult =>
  ({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_RESULT_TYPE, ok: false, jobKey: job.jobKey, error: { code, message: `${code} happened`, retryable: false, attempts: 1 }, ...(qc ? { qc } : {}), completedAt: "x" }) as never;

describe("InternalRenderService (VE2E-110)", () => {
  let db: ReturnType<typeof fakeDb>;
  let composer: VideoComposer & { composeVideo: ReturnType<typeof vi.fn>; renderQueueStatus: ReturnType<typeof vi.fn> };
  let service: InternalRenderService;
  const templates = { usableAccount: vi.fn(async (id: string) => (id === CM_ACCOUNT ? { ok: true, data: { id, encryptedSecret: "x", provider: "creatomate" } } : { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "no" })) } as unknown as CreatomateTemplatesService;

  const build = (over: { rolloutPercent?: number; fallback?: boolean } = {}) => {
    db = fakeDb();
    seed(db, over);
    composer = { composeVideo: vi.fn(async (job: VideoComposeJobInput) => okResult(job)), renderQueueStatus: vi.fn(async () => ({ consumers: 1, queued: 0 })) } as never;
    // clip.prepare stand-in: every requested cut/reframe becomes a derivative asset under working/media-jobs
    const clips = {
      prepare: vi.fn(async (_projectId: string, _userId: string, requests: Array<{ sceneId: string; parentMediaAssetVersionId: string; mediaKind?: string }>, onReady?: (r: unknown) => Promise<void>) => {
        const derivativeBySceneId = new Map<string, string>();
        for (const request of requests) {
          if (request.mediaKind === "image") continue; // image reframing is off for this origin: the service drops those requests
          const id = `${request.parentMediaAssetVersionId}-cut`;
          db.stored.mediaAssetVersion.push({ id, projectId, kind: "video", durationMs: 2500, relativePath: `working/media-jobs/${id}/clip.mp4`, checksumSha256: "c".repeat(64), deletedAt: null });
          derivativeBySceneId.set(request.sceneId, id);
          await onReady?.(request);
        }
        return { ok: true, data: { derivativeBySceneId } };
      }),
    };
    service = new InternalRenderService(db.prisma, templates, clips as never, composer);
    service.routerConfig = { overflowEnabled: false, overflowSlaMs: 600_000, fallbackDailyUsd: 50, fallbackMonthlyUsd: null };
    service.cpuHourUsd = 0;
  };

  const enqueue = async (over: Record<string, unknown> = {}, role: "admin" | "staff" = "staff", workflowRunId?: string) => {
    const outcome = await service.enqueue({ projectId, timelineVersionId: "tl-1", userId: "user-1", role, input: { providerAccountId: LYONIX_ACCOUNT, ...over } as never, ...(workflowRunId ? { workflowRunId } : {}) });
    if (!outcome.ok) throw new Error(`enqueue failed: ${outcome.code} ${outcome.message}`);
    return outcome.data;
  };
  const run = async (id: string) => {
    await service.processJob(db.jobs.get(id)! as never);
    await service.settle();
    return db.jobs.get(id)!;
  };

  beforeEach(() => build());

  it("enqueues an internal job (engine lyonix, preparing_clips) and dedupes an identical request", async () => {
    const first = await enqueue();
    expect(first).toMatchObject({ status: "preparing_clips", engine: "lyonix" });
    const again = await enqueue();
    expect(again.id).toBe(first.id);
    expect(db.jobs.size).toBe(1);
  });

  it("rejects bad requests clearly: unapproved timeline, a provider snapshot, no renderable scene, staff forcing an engine", async () => {
    db.stored.timelineVersion[0]!.status = "draft";
    expect(await service.enqueue({ projectId, timelineVersionId: "tl-1", userId: "u", role: "staff", input: { providerAccountId: LYONIX_ACCOUNT } })).toMatchObject({ ok: false, code: "INVALID_STATE" });
    db.stored.timelineVersion[0]!.status = "approved";
    db.stored.timelineVersion[0]!.templateSnapshotId = "snap-cm";
    expect(await service.enqueue({ projectId, timelineVersionId: "tl-1", userId: "u", role: "staff", input: { providerAccountId: LYONIX_ACCOUNT } })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    db.stored.timelineVersion[0]!.templateSnapshotId = "snap-lyonix";
    expect(await service.enqueue({ projectId, timelineVersionId: "tl-1", userId: "u", role: "staff", input: { providerAccountId: LYONIX_ACCOUNT, forceEngine: "creatomate" } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    db.stored.audioVersion.length = 0;
    expect(await service.enqueue({ projectId, timelineVersionId: "tl-1", userId: "u", role: "admin", input: { providerAccountId: LYONIX_ACCOUNT } })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });

  it("renders internally: sends a frame-exact plan with real paths + hashes + alignment timing, then completes with cost, duration, hash, profile and QC", async () => {
    const queued = await enqueue({}, "staff", "run-1");
    const done = await run(queued.id);
    expect(composer.composeVideo).toHaveBeenCalledTimes(1);
    const sent = composer.composeVideo.mock.calls[0]![0] as VideoComposeJobInput;
    expect(sent.recipe).toEqual({ id: "news-recap-broadcast-telop-jp", version: 1 });
    expect(sent.jobKey).toMatch(/^compose:[0-9a-f]{40}$/);
    const [s1, s2] = sent.plan.scenes;
    expect(s1).toMatchObject({ sceneId: "s1", startFrame: 18, durationFrames: 180, media: { relativePath: "projects/p/m1.jpg", kind: "image" }, voice: { relativePath: "projects/p/au1.mp3", durationMs: 3000 } });
    expect(s1!.media.sha256).toBe("m1".padEnd(64, "0"));
    expect(s1!.captionCues[0]!.charTimings).toHaveLength(5); // per-character timing mapped from the TTS alignment
    expect(s2).toMatchObject({ sceneId: "s2", startFrame: 198, durationFrames: 150, text: "手入力", captionCues: [] }); // Studio override = one static block
    expect(s2!.transitionIn).toEqual({ kind: "wipe", durationMs: 400 });
    // the 10 s source was cut to the scene: the plan carries the derivative (already trimmed: no source range), not the original
    expect(s2!.media).toMatchObject({ relativePath: "working/media-jobs/m2-cut/clip.mp4", kind: "video", sourceStartMs: null, sourceDurationMs: null });
    expect(done.clipsReady).toBe(1);
    expect(sent.plan.totalFrames).toBe(18 + 180 + 150 + 48);
    expect(sent.plan.params).toEqual({ headline: "経済対策" });
    expect(sent.plan.fps).toBe(60);

    expect(done).toMatchObject({
      status: "completed",
      engine: "lyonix",
      routeReason: "default",
      progress: 100,
      renderDurationMs: 80_000,
      outputSha256: "f".repeat(64),
      outputBytes: 12345,
      outputProfileVersion: "compose.v1",
      outputRelativePath: "working/renders/abc/video.mp4",
      thumbnailRelativePath: "working/renders/abc/thumb.jpg",
      costCurrency: "USD",
      outputWidth: 1080,
      outputHeight: 1920,
    });
    expect(String(done.costAmount)).toBe("0");
    expect(done.resultUrl).toBe(`/api/v1/render-jobs/${queued.id}/file`);
    expect(done.qcReport.passed).toBe(true);
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(db.jobs.size).toBe(1); // no fallback job
  });

  it("records the cost of an internal render from CPU-seconds x the configured rate (and wall time when CPU is unknown)", async () => {
    service.cpuHourUsd = 0.05;
    const done = await run((await enqueue()).id);
    expect(String(done.costAmount)).toBe("0.0028"); // 200 CPU-s = 0.0556 h x 0.05
    build();
    service.cpuHourUsd = 0.05;
    composer.composeVideo.mockImplementation(async (job: VideoComposeJobInput) => okResult(job, { metrics: { renderMs: 3_600_000, cpuSeconds: null, x264Preset: "faster", x264Threads: 0 } }));
    const wall = await run((await enqueue()).id);
    expect(String(wall.costAmount)).toBe("0.05");
  });

  it("canary holdout (rollout 0, the default): converts the job to the linked Creatomate snapshot without touching the media worker", async () => {
    build({ rolloutPercent: 0 });
    const queued = await enqueue();
    const converted = await run(queued.id);
    expect(composer.composeVideo).not.toHaveBeenCalled();
    expect(converted).toMatchObject({ engine: "creatomate", templateSnapshotId: "snap-cm", providerAccountId: CM_ACCOUNT, routeReason: "canary_holdout", status: "preparing_clips", preparationLeaseUntil: null });
    expect(converted.modificationsPayload.mode).toBe("dynamic");
  });

  it("an unhealthy engine (no render worker attached, or no broker) falls back with local_unhealthy", async () => {
    composer.renderQueueStatus.mockResolvedValue({ consumers: 0, queued: 0 });
    const converted = await run((await enqueue()).id);
    expect(converted).toMatchObject({ engine: "creatomate", routeReason: "local_unhealthy" });
    expect(composer.composeVideo).not.toHaveBeenCalled();

    build();
    composer.renderQueueStatus.mockResolvedValue(null);
    expect(await run((await enqueue()).id)).toMatchObject({ routeReason: "local_unhealthy" });
  });

  it("overflow is off by default; enabled, a queue longer than the SLA sends the job to the provider", async () => {
    composer.renderQueueStatus.mockResolvedValue({ consumers: 1, queued: 50 });
    expect(await run((await enqueue()).id)).toMatchObject({ engine: "lyonix", status: "completed" });
    build();
    service.routerConfig = { ...service.routerConfig, overflowEnabled: true };
    composer.renderQueueStatus.mockResolvedValue({ consumers: 1, queued: 50 });
    expect(await run((await enqueue()).id)).toMatchObject({ engine: "creatomate", routeReason: "overflow" });
  });

  it("an admin can force the provider engine (reason forced); with nothing to fall back to the job fails clearly", async () => {
    const forced = await run((await enqueue({ forceEngine: "creatomate" }, "admin")).id);
    expect(forced).toMatchObject({ engine: "creatomate", routeReason: "forced", templateSnapshotId: "snap-cm" });
    build({ rolloutPercent: 0, fallback: false });
    const failed = await run((await enqueue()).id);
    expect(failed).toMatchObject({ status: "failed", lastError: { code: "PROVIDER_NOT_CONFIGURED" } });
  });

  it("QC failure -> exactly ONE Creatomate fallback job (fallbackOfJobId, fallback_after_error, same run) and the original is failed with its QC report", async () => {
    const qc = { passed: false, checks: [{ code: "QC_LOUDNESS", ok: false, measured: -20, expected: "-14", message: "x" }, { code: "QC_FPS", ok: true, measured: 60, expected: 60, message: "y" }], measured: {} };
    composer.composeVideo.mockImplementation(async (job: VideoComposeJobInput) => failResult(job, "QC_LOUDNESS", qc));
    const queued = await enqueue({}, "staff", "run-1");
    const original = await run(queued.id);
    expect(original).toMatchObject({ status: "failed", lastError: { code: "QC_LOUDNESS" }, qcReport: qc });
    const fallback = [...db.jobs.values()].find((j) => j.fallbackOfJobId === queued.id)!;
    expect(fallback).toMatchObject({ engine: "creatomate", routeReason: "fallback_after_error", status: "preparing_clips", templateSnapshotId: "snap-cm", providerAccountId: CM_ACCOUNT, workflowRunId: "run-1", requestFingerprint: `fallback:${queued.id}` });
    expect(original.lastError.fallbackJobId).toBe(fallback.id);
    expect(fallback.createdAt.getTime()).toBeGreaterThanOrEqual(db.jobs.get(queued.id)!.createdAt.getTime()); // newest job = what an Auto run follows
    expect(db.jobs.size).toBe(2);
    // the response of the original job exposes the failed QC codes
    expect(await service["handleFailure"](queued.id, { code: "QC_LOUDNESS", message: "again", qc })).toBeUndefined(); // already failed: no second fallback
    expect(db.jobs.size).toBe(2);
  });

  it("a worker/transport failure is technical too (fallback), but an input-data error is not", async () => {
    composer.composeVideo.mockRejectedValue(new MediaJobClientError("BROKER_UNAVAILABLE", "rabbit down"));
    const original = await run((await enqueue()).id);
    expect(original.status).toBe("failed");
    expect([...db.jobs.values()].filter((j) => j.fallbackOfJobId)).toHaveLength(1);

    build();
    composer.composeVideo.mockImplementation(async (job: VideoComposeJobInput) => failResult(job, "SOURCE_NOT_FOUND"));
    const input = await run((await enqueue()).id);
    expect(input).toMatchObject({ status: "failed", lastError: { code: "SOURCE_NOT_FOUND" } });
    expect(db.jobs.size).toBe(1); // no fallback: the provider would get the same bad file

    build();
    composer.composeVideo.mockRejectedValue(new MediaJobClientError("RESULT_TIMEOUT", "no progress"));
    const timeout = await run((await enqueue()).id);
    expect(timeout.lastError.code).toBe("FFMPEG_TIMEOUT");
    expect(db.jobs.size).toBe(2);
  });

  it("spend ceiling: no provider is called once the day's fallback budget is gone (budget_exhausted), neither for canary nor after an error", async () => {
    service.routerConfig = { ...service.routerConfig, fallbackDailyUsd: 0.05 };
    // an already-spent fallback today
    db.jobs.set("spent", { id: "spent", engine: "creatomate", routeReason: "overflow", costAmount: 0.05, status: "completed", createdAt: new Date() });
    composer.composeVideo.mockImplementation(async (job: VideoComposeJobInput) => failResult(job, "FFMPEG_FAILED"));
    const afterError = await run((await enqueue()).id);
    expect(afterError).toMatchObject({ status: "failed", routeReason: "budget_exhausted", lastError: { code: "RENDER_BUDGET_EXHAUSTED", cause: "FFMPEG_FAILED" } });
    expect([...db.jobs.values()].filter((j) => j.fallbackOfJobId)).toHaveLength(0);

    build({ rolloutPercent: 0 });
    service.routerConfig = { ...service.routerConfig, fallbackDailyUsd: 0.05 };
    db.jobs.set("spent", { id: "spent", engine: "creatomate", routeReason: "canary_holdout", costAmount: 0.05, status: "completed", createdAt: new Date() });
    const canary = await run((await enqueue()).id);
    expect(canary).toMatchObject({ status: "failed", routeReason: "budget_exhausted", lastError: { code: "RENDER_BUDGET_EXHAUSTED" } });
    expect(canary.engine).toBe("lyonix"); // never converted to a provider
  });

  it("counts running fallbacks (no cost yet) at their estimate, and ignores spend from provider-owned templates", async () => {
    service.routerConfig = { ...service.routerConfig, fallbackDailyUsd: 0.6 };
    db.jobs.set("running", { id: "running", engine: "creatomate", routeReason: "overflow", costAmount: null, status: "rendering", createdAt: new Date() });
    db.jobs.set("direct", { id: "direct", engine: "creatomate", routeReason: "template_requires_provider", costAmount: 40, status: "completed", createdAt: new Date() });
    composer.composeVideo.mockImplementation(async (job: VideoComposeJobInput) => failResult(job, "QC_DURATION"));
    // estimate for a 5.5 s 1080p60 job is tiny; one running fallback + this one fits in 0.6 USD
    const result = await run((await enqueue()).id);
    expect([...db.jobs.values()].filter((j) => j.fallbackOfJobId)).toHaveLength(1);
    expect(result.status).toBe("failed");
  });

  it("recovers a render whose API process died: expired lease -> back to preparing_clips; live (in-flight) renders are left alone", async () => {
    const queued = await enqueue();
    db.jobs.set(queued.id, { ...db.jobs.get(queued.id)!, status: "rendering", preparationLeaseUntil: new Date(Date.now() - 1000), progress: 40 });
    expect(await service.recoverStale()).toBe(true);
    expect(db.jobs.get(queued.id)).toMatchObject({ status: "preparing_clips", preparationLeaseUntil: null, progress: null });
    expect(await service.recoverStale()).toBe(false);

    db.jobs.set(queued.id, { ...db.jobs.get(queued.id)!, status: "rendering", preparationLeaseUntil: new Date(Date.now() + 60_000) });
    expect(await service.recoverStale()).toBe(false); // lease still valid
  });

  it("a recipe the release does not know fails the job with RECIPE_NOT_FOUND instead of guessing", async () => {
    db.stored.templateSnapshot[0]!.rawTemplate = { id: "ghost", version: 9 };
    const failed = await run((await enqueue()).id);
    expect(failed).toMatchObject({ status: "failed", lastError: { code: "RECIPE_NOT_FOUND" } });
    expect(composer.composeVideo).not.toHaveBeenCalled();
  });
});

describe("router config from env", () => {
  it("defaults to overflow OFF and a 50 USD/day fallback ceiling; reads overrides; ignores junk", () => {
    expect(loadRouterConfig({})).toMatchObject({ overflowEnabled: false, fallbackDailyUsd: 50, fallbackMonthlyUsd: null });
    expect(loadRouterConfig({ RENDER_OVERFLOW_ENABLED: "true", RENDER_FALLBACK_DAILY_USD: "12.5", RENDER_FALLBACK_MONTHLY_USD: "300", RENDER_OVERFLOW_SLA_MS: "60000" })).toEqual({ overflowEnabled: true, overflowSlaMs: 60000, fallbackDailyUsd: 12.5, fallbackMonthlyUsd: 300 });
    expect(loadRouterConfig({ RENDER_FALLBACK_DAILY_USD: "abc", RENDER_OVERFLOW_ENABLED: "no" })).toMatchObject({ overflowEnabled: false, fallbackDailyUsd: 50 });
    expect(localUsdPerCpuHour({})).toBe(0);
    expect(localUsdPerCpuHour({ RENDER_LOCAL_USD_PER_CPU_HOUR: "0.04" })).toBe(0.04);
    expect(localUsdPerCpuHour({ RENDER_LOCAL_USD_PER_CPU_HOUR: "-1" })).toBe(0);
  });
});
