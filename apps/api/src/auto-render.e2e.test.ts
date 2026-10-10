import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@lyonix/db";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1 } from "@lyonix/render-recipes";
import type { VideoComposeJobInput, VideoComposeResult } from "@lyonix/media-jobs";
import { InternalRenderService } from "./internal-render.service.js";
import { RenderJobsService } from "./render-jobs.service.js";
import { WorkflowRunnerService } from "./workflow-runner.service.js";
import { MediaPlanService } from "./media-plan.service.js";
import type { VideoComposer } from "./media-jobs.gateway.js";

/**
 * VE2E-112: Auto end-to-end with the REAL FFmpeg. WorkflowRunnerService runs the Auto DAG (script/voice/stock-media providers are in-process
 * stubs - nothing paid is called), persists the timeline, and renders through the REAL RenderJobsService -> Render Router ->
 * InternalRenderService -> media-worker's ComposeProcessor (via scripts/compose-cli.ts, the same code the worker runs on lyonix.render) ->
 * real QC. Prints a per-step timing table. Skipped (with a message) when FFmpeg/tsx are not available.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
// tsx's own entry run by this Node (portable: Windows cannot spawn the `.bin/tsx.cmd` shim without a shell)
const tsx = join(repoRoot, "apps/media-worker/node_modules/tsx/dist/cli.mjs");
const cli = join(repoRoot, "apps/media-worker/scripts/compose-cli.ts");
// the FFmpeg the media-worker uses (FFMPEG_PATH), else the one on PATH
const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

const hasFfmpeg = (() => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-filters"], { encoding: "utf8" });
  return r.status === 0 && ["xfade", "ass", "loudnorm", "ebur128", "blackdetect", "freezedetect"].every((f) => new RegExp(`\\b${f}\\b`).test(r.stdout)) && /libx264/.test(spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "");
})();
const fontconfig = spawnSync("fc-list", [":", "family"], { encoding: "utf8" }).status === 0;
/** A Japanese-capable font family: fontconfig's pick, or `LYONIX_E2E_FONT` on a host without fontconfig tools (e.g. a Windows dev box). */
const hostFont = (() => {
  const configured = process.env.LYONIX_E2E_FONT?.trim();
  if (configured) return configured;
  const r = spawnSync("fc-match", ["-f", "%{family}", ":lang=ja"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(",")[0]!.trim() || null : null;
})();
const canRun = hasFfmpeg && existsSync(tsx) && Boolean(hostFont);
if (!canRun) console.warn("[api] SKIPPING Auto render E2E: needs ffmpeg (libx264, xfade, ass, loudnorm), a Japanese-capable font and apps/media-worker's tsx.");

const projectId = "project-1";
const userId = "user-1";
const LYONIX_ACCOUNT = "acct-lyonix";
const CM_ACCOUNT = "acct-creatomate";

type Row = Record<string, any>;
const matches = (row: Row, where: Row | undefined): boolean =>
  Object.entries(where ?? {}).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return (cond as any).in.includes(value);
      if ("notIn" in cond) return !(cond as any).notIn.includes(value);
      if ("gte" in cond) return value != null && value >= (cond as any).gte;
      if ("lt" in cond) return value != null && value < (cond as any).lt;
      if ("startsWith" in cond) return typeof value === "string" && value.startsWith((cond as any).startsWith);
      if ("not" in cond) return (cond as any).not === null ? value != null : value !== (cond as any).not;
    }
    return value === cond;
  });

const generate = (args: string[]) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};

describe.skipIf(!canRun)("Auto render end-to-end with real FFmpeg (VE2E-112)", () => {
  let mediaDir: string;
  let previousRoot: string | undefined;
  const timings: Array<[string, number]> = [];

  beforeAll(async () => {
    mediaDir = await mkdtemp(join(tmpdir(), "lyonix-auto-e2e-"));
    previousRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = mediaDir;
    const dir = join(mediaDir, "projects/p");
    spawnSync("mkdir", ["-p", dir]);
    generate(["-f", "lavfi", "-i", "gradients=size=1920x1080:rate=1:duration=1:seed=3:n=4", "-frames:v", "1", join(dir, "m1.jpg")]);
    generate(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(dir, "m2.mp4")]);
    for (const [name, seconds, freq] of [["au1", 3, 220], ["au2", 2.5, 280]] as const) {
      generate(["-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=44100:duration=${seconds}`, "-af", "volume=0.5", "-c:a", "libmp3lame", join(dir, `${name}.mp3`)]);
    }
  }, 120_000);

  afterAll(async () => {
    if (previousRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = previousRoot;
    if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
    console.info(`[auto-e2e] step timings (ms):\n${timings.map(([name, ms]) => `  ${name.padEnd(34)} ${ms.toFixed(0).padStart(7)}`).join("\n")}`);
  });

  /** Everything the run touches, in memory. */
  const build = async (opts: { font: string; title?: string }) => {
    const jobs = new Map<string, Row>();
    const runs: Row[] = [{ id: "run-1", projectId, mode: "auto", automationProfileVersionId: "profile-1", sourceVersionId: "source-1", status: "draft", requestFingerprint: "fp-1", correlationId: "c", attempts: 1, lastError: null, createdByUserId: userId, createdAt: new Date(), updatedAt: new Date() }];
    const stepRuns: Row[] = [];
    const timelines: Row[] = [];
    const media: Row[] = [
      { id: "m1", projectId, kind: "image", durationMs: null, relativePath: "projects/p/m1.jpg", checksumSha256: "1".repeat(64), deletedAt: null, sceneId: "scene-1" },
      { id: "m2", projectId, kind: "video", durationMs: 6000, relativePath: "projects/p/m2.mp4", checksumSha256: "2".repeat(64), deletedAt: null, sceneId: "scene-2" },
      { id: "au1", projectId, kind: "audio", durationMs: 3000, relativePath: "projects/p/au1.mp3", checksumSha256: "3".repeat(64), deletedAt: null },
      { id: "au2", projectId, kind: "audio", durationMs: 2500, relativePath: "projects/p/au2.mp3", checksumSha256: "4".repeat(64), deletedAt: null },
    ];
    const audio: Row[] = [
      { id: "a1", mediaAssetVersionId: "au1", durationMs: 3000, alignment: { characters: Array.from("政府は新しい"), characterStartTimesSeconds: [0, 0.4, 0.8, 1.2, 1.6, 2.0], characterEndTimesSeconds: [0.4, 0.8, 1.2, 1.6, 2.0, 2.4] } },
      { id: "a2", mediaAssetVersionId: "au2", durationMs: 2500, alignment: null },
    ];
    const subtitles: Row[] = [{ audioVersionId: "a1", version: 1, segments: [{ text: "政府は新しい", startMs: 0, endMs: 2400 }] }];
    const snapshots: Row[] = [
      { id: "snap-lyonix", providerAccountId: LYONIX_ACCOUNT, engine: "lyonix", rolloutPercent: 100, fallbackSnapshotIds: ["snap-cm"], modifications: NEWS_RECAP_BROADCAST_TELOP_JP_V1.slots, rawTemplate: NEWS_RECAP_BROADCAST_TELOP_JP_V1 },
      { id: "snap-cm", providerAccountId: CM_ACCOUNT, engine: "creatomate", rolloutPercent: 0, fallbackSnapshotIds: [], modifications: [], rawTemplate: {} },
    ];
    // the Auto profile's media account (a switched-on Pexels account: the job checks a media source is on before sourcing)
    const accounts: Row[] = [{ id: LYONIX_ACCOUNT, provider: "lyonix", role: "render", deletedAt: null }, { id: CM_ACCOUNT, provider: "creatomate", role: "render", deletedAt: null }, { id: "media-acc", provider: "pexels", role: "visual", deletedAt: null, enabled: true }];
    let seq = 0;
    const orderIt = (rows: Row[], orderBy: Row | undefined) => (orderBy?.createdAt === "desc" ? [...rows].sort((a, b) => +b.createdAt - +a.createdAt) : [...rows].sort((a, b) => +a.createdAt - +b.createdAt));
    const prisma: any = {
      user: { findUnique: vi.fn(async () => ({ id: userId, role: "staff" })) },
      project: { findUnique: async () => ({ id: projectId }) },
      automationProfileVersion: { findUnique: async () => ({ id: "profile-1", projectId, version: 1, locale: "ja", durationSec: 30, sceneCount: 2, contentConfig: { providerAccountId: "content-acc" }, voiceConfig: { providerAccountId: "voice-acc", voiceId: "v1" }, mediaConfig: { providerAccountId: "media-acc" }, renderConfig: { providerAccountId: LYONIX_ACCOUNT, templateSnapshotId: "snap-lyonix" }, retryPolicy: {} }) },
      sourceVersion: { findUnique: async () => ({ id: "source-1", projectId, type: "topic", fetchStatus: "extracted" }) },
      templateSnapshot: { findUnique: async ({ where }: any) => snapshots.find((s) => s.id === where.id) ?? null, findMany: async ({ where }: any) => snapshots.filter((s) => where.id.in.includes(s.id)) },
      providerAccount: { findFirst: async ({ where }: any) => accounts.find((a) => matches(a, where)) ?? null },
      mediaAssetVersion: {
        findFirst: async ({ where }: any) => media.find((m) => m.projectId === where.projectId && m.sceneId === where.sceneId) ?? null,
        findMany: async ({ where }: any) => media.filter((m) => where.id.in.includes(m.id) && m.projectId === where.projectId && !m.deletedAt),
      },
      audioVersion: { findFirst: async () => null, findMany: async ({ where }: any) => audio.filter((a) => where.id.in.includes(a.id)) },
      subtitleVersion: { findMany: async ({ where }: any) => subtitles.filter((s) => where.audioVersionId.in.includes(s.audioVersionId)) },
      sceneDraftVersion: { findMany: async () => [] },
      timelineVersion: { findUnique: async ({ where }: any) => timelines.find((t) => t.id === where.id) ?? null },
      workflowRun: {
        findFirst: async ({ where }: any) => (where.status === "draft" ? runs.find((r) => r.status === "draft") ?? null : null),
        findMany: async ({ where }: any) => runs.filter((r) => where.status.in.includes(r.status)),
        updateMany: async ({ where, data }: any) => {
          const row = runs.find((r) => r.id === where.id && r.status === where.status);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
        update: async ({ where, data }: any) => {
          const row = runs.find((r) => r.id === where.id)!;
          const { attempts, ...rest } = data;
          Object.assign(row, rest);
          if (attempts && typeof attempts === "object" && "increment" in attempts) row.attempts += attempts.increment;
          return row;
        },
      },
      stepRun: {
        upsert: async ({ create, update }: any) => {
          const existing = stepRuns.find((s) => s.workflowRunId === create.workflowRunId && s.stepKey === create.stepKey && s.attempt === create.attempt);
          if (existing) return Object.assign(existing, update);
          const row = { id: `step-${stepRuns.length + 1}`, ...create };
          stepRuns.push(row);
          return row;
        },
        findUnique: async ({ where }: any) => {
          const k = where.workflowRunId_stepKey_attempt;
          return stepRuns.find((s) => s.workflowRunId === k.workflowRunId && s.stepKey === k.stepKey && s.attempt === k.attempt) ?? null;
        },
        update: async ({ where, data }: any) => Object.assign(stepRuns.find((s) => s.id === where.id)!, data),
      },
      providerOperation: { create: async ({ data }: any) => ({ id: `op-${++seq}`, ...data }), update: async () => ({}) },
      renderJob: {
        create: async ({ data, select }: any) => {
          if ([...jobs.values()].some((j) => j.requestFingerprint === data.requestFingerprint)) throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6.19.3" });
          const id = `job-${++seq}`;
          const row = { id, attempts: 1, progress: null, resultUrl: null, snapshotUrl: null, resultExpiresAt: null, costAmount: null, costCurrency: null, renderDurationMs: null, lastError: null, externalJobId: null, routeReason: null, fallbackOfJobId: null, clipsTotal: 0, clipsReady: 0, clipFailures: null, submittedAt: null, completedAt: null, preparationLeaseUntil: null, createdAt: new Date(Date.now() + seq), updatedAt: new Date(), ...data };
          jobs.set(id, row);
          return select ? { id } : row;
        },
        findUnique: async ({ where }: any) => (where.id ? jobs.get(where.id) : [...jobs.values()].find((j) => j.requestFingerprint === where.requestFingerprint)) ?? null,
        findFirst: async ({ where, orderBy }: any) => orderIt([...jobs.values()].filter((j) => matches(j, where)), orderBy)[0] ?? null,
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
        updateMany: async ({ where, data }: any) => {
          const found = [...jobs.values()].filter((j) => matches(j, where));
          for (const row of found) jobs.set(row.id, { ...row, ...data, updatedAt: new Date() });
          return { count: found.length };
        },
      },
    };

    // the composer runs the media-worker's real ComposeProcessor through the dev CLI (real FFmpeg + real QC)
    const composer: VideoComposer = {
      renderQueueStatus: async () => ({ consumers: 1, queued: 0 }),
      composeVideo: async (job: VideoComposeJobInput): Promise<VideoComposeResult> => {
        const jobFile = join(mediaDir, `job-${job.jobKey.replace(/\W/g, "_")}.json`);
        await writeFile(jobFile, JSON.stringify({ schemaVersion: "media-job.v1", type: "video.compose", ...job }));
        return await new Promise((resolveResult, reject) => {
          const child = spawn(process.execPath, [tsx, cli, "--media-root", mediaDir, "--job", jobFile, "--font", opts.font, "--preset", "veryfast"], { cwd: join(repoRoot, "apps/media-worker") });
          let out = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.on("error", reject);
          child.on("close", () => {
            try {
              resolveResult(JSON.parse(out.trim().split("\n").at(-1)!) as VideoComposeResult);
            } catch {
              reject(new Error(`compose CLI produced no result: ${out.slice(-300)}`));
            }
          });
        });
      },
    };
    const templates = { usableAccount: async (id: string) => (id === CM_ACCOUNT ? { ok: true, data: { id, encryptedSecret: "x", provider: "creatomate" } } : { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "n/a" }) } as never;
    // clip.prepare stand-in: the Auto media plan gives video scenes a source range, so the render cuts a real derivative with the real FFmpeg
    const clips = {
      prepare: async (_p: string, _u: string, requests: Array<{ sceneId: string; parentMediaAssetVersionId: string; startMs: number; durationMs: number; mediaKind?: string }>, onReady?: (r: unknown) => Promise<void>) => {
        const derivativeBySceneId = new Map<string, string>();
        for (const request of requests) {
          if (request.mediaKind === "image") continue;
          const parent = media.find((m) => m.id === request.parentMediaAssetVersionId)!;
          const id = `${parent.id}-cut-${request.startMs}`;
          const relativePath = `working/media-jobs/${id}/clip.mp4`;
          spawnSync("mkdir", ["-p", join(mediaDir, "working/media-jobs", id)]);
          generate(["-ss", String(request.startMs / 1000), "-t", String(request.durationMs / 1000), "-i", join(mediaDir, parent.relativePath), "-an", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(mediaDir, relativePath)]);
          media.push({ id, projectId, kind: "video", durationMs: request.durationMs, relativePath, checksumSha256: "9".repeat(64), deletedAt: null });
          derivativeBySceneId.set(request.sceneId, id);
          await onReady?.(request);
        }
        return { ok: true, data: { derivativeBySceneId } };
      },
    };
    const internal = new InternalRenderService(prisma, templates, clips as never, composer);
    internal.cpuHourUsd = 0.04;
    const grants = { forUser: async () => ({ teamIds: [], projectIds: [projectId], channelIds: [] }) };
    const renderJobs = new RenderJobsService(prisma, grants as never, templates, {} as never, undefined, internal);

    // provider stubs (nothing paid): script, voice, stock media, timeline persistence
    const scenes = [
      { id: "scene-db-1", sceneId: "scene-1", orderIndex: 0, narration: "政府は新しい経済対策を発表しました。", screenText: "x", visualQuery: "a", durationHintMs: 3000 },
      { id: "scene-db-2", sceneId: "scene-2", orderIndex: 1, narration: "物価高への対応を急ぐ方針です。", screenText: "y", visualQuery: "b", durationHintMs: 2500 },
    ];
    const approved = { id: "script-1", sourceVersionId: "source-1", version: 1, status: "approved", language: "ja", title: opts.title ?? "経済対策を発表", hook: "h", body: "b", cta: "c", caption: "cap", providerPin: { accountId: "content-acc", provider: "openai", modelId: "m", configVersion: 1, promptTemplateVersion: "v1" }, supersedesId: null, createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(), scenes };
    const pexels = { autoImportForScene: async (_p: string, _u: string, _r: string, input: any) => ({ ok: true, data: { asset: input.sceneId === "scene-1" ? { id: "m1", kind: "image", durationMs: null } : { id: "m2", kind: "video", durationMs: 6000 }, externalId: `ext-${input.sceneId}` } }) };
    const runner = new WorkflowRunnerService(
      prisma,
      { extractArticle: vi.fn() } as never,
      { generate: async () => ({ ok: true, response: { sourceId: "source-1", draft: { schemaVersion: "script-draft.v2", language: "ja", title: "t", hook: "h", body: "b", cta: "c", caption: "cap", scenes: [] }, providerPin: approved.providerPin } }) } as never,
      { getApprovedForSource: async () => ({ ok: true, data: null }), create: async () => ({ ok: true, data: { ...approved, id: "draft-1", status: "draft" } }), approve: async () => ({ ok: true, data: approved }) } as never,
      { generateForWorkflowRun: async (sceneDraftVersionId: string) => ({ ok: true, data: { id: sceneDraftVersionId === "scene-db-1" ? "a1" : "a2", mediaAssetVersionId: sceneDraftVersionId === "scene-db-1" ? "au1" : "au2", subtitleVersion: { id: `sub-${sceneDraftVersionId}` } } }) } as never,
      new MediaPlanService(prisma, { forUser: async () => ({ teamIds: [], projectIds: [], channelIds: [] }) } as never, pexels as never),
      renderJobs,
      {
        persistApprovedForWorkflowRun: async (runId: string, project: string, _u: string, _r: string, input: any) => {
          timelines.push({ id: "tl-1", projectId: project, status: "approved", workflowRunId: runId, templateSnapshotId: input.templateSnapshotId, scenes: input.scenes.map((s: any, i: number) => ({ ...s, orderIndex: i })), optionValues: input.optionValues, segments: input.segments });
          return { ok: true, data: { id: "tl-1", status: "approved" } };
        },
      } as never,
    );
    return { prisma, jobs, runs, runner, renderJobs, internal };
  };

  const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      timings.push([label, performance.now() - start]);
    }
  };

  const ffprobe = (path: string) => JSON.parse(spawnSync(process.env.FFPROBE_PATH?.trim() || "ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }).stdout) as { streams: Array<Record<string, string>>; format: Record<string, string> };

  it("Auto DAG -> Router -> internal engine -> real FFmpeg -> QC: the run completes with a 1080x1920 60 fps CFR MP4 served from the job", async () => {
    const { jobs, runs, runner, renderJobs, internal } = await build({ font: hostFont! });
    await timed("auto DAG (script..timeline, stubs)", () => runner.processNext());
    expect(runs[0], JSON.stringify(runs[0]?.lastError)).toMatchObject({ status: "render_queued" });
    const [queued] = [...jobs.values()];
    expect(queued).toMatchObject({ engine: "lyonix", status: "preparing_clips", workflowRunId: "run-1", templateSnapshotId: "snap-lyonix" });

    await timed("route + prepare + compose (FFmpeg)", async () => {
      expect(await renderJobs.processNextPreparation()).toBe(true);
      await internal.settle();
    });
    const job = jobs.get(queued!.id)!;
    expect(job).toMatchObject({ status: "completed", engine: "lyonix", routeReason: "default", progress: 100, outputProfileVersion: "compose.v2", costCurrency: "USD" });
    expect(job.renderDurationMs).toBeGreaterThan(0);
    expect(Number(job.costAmount)).toBeGreaterThanOrEqual(0);
    expect(job.qcReport.passed).toBe(true);
    expect(job.resultUrl).toBe(`/api/v1/render-jobs/${job.id}/file`);

    await timed("reconcile run", async () => {
      expect(await runner.processNext()).toBe(true);
    });
    expect(runs[0]).toMatchObject({ status: "completed" });

    // the stored file, served by the same resolver the HTTP endpoint uses
    const file = await renderJobs.resolveInternalOutput(job.id, userId, "staff", "video");
    if (!file.ok) throw new Error(file.message);
    const probed = ffprobe(file.data.absolutePath);
    const v = probed.streams.find((s) => s.codec_type === "video")!;
    const a = probed.streams.find((s) => s.codec_type === "audio")!;
    expect([v.width, v.height].map(Number)).toEqual([1080, 1920]);
    expect(v.r_frame_rate).toBe("60/1");
    expect(v.avg_frame_rate).toBe("60/1");
    expect(v.profile).toBe("High");
    expect(a.sample_rate).toBe("48000");
    // voice 3.0 s + 2.5 s + the recipe's 0.3 s / 0.8 s padding
    expect(Math.abs(Number(probed.format.duration) - (3 + 2.5 + 0.3 + 0.8))).toBeLessThan(0.1);
    expect(Number(v.nb_read_frames)).toBe(Math.round((3 + 2.5 + 0.3 + 0.8) * 60));
    expect(file.data.bytes).toBe(job.outputBytes);
    const cover = await renderJobs.resolveInternalOutput(job.id, userId, "staff", "thumbnail");
    expect(cover).toMatchObject({ ok: true, data: { mimeType: "image/jpeg" } });
  }, 300_000);

  it.skipIf(!fontconfig)("a font missing on the render host is a technical failure: ONE Creatomate fallback job is queued for the same run (nothing paid is called) and the run keeps following the newest job", async () => {
    const { jobs, runs, runner, renderJobs, internal } = await build({ font: "Definitely Not Installed Font", title: "別の見出し（フォント欠落の検証）" });
    await runner.processNext();
    const [queued] = [...jobs.values()];
    await timed("route + compose attempt (FONT_MISSING)", async () => {
      await renderJobs.processNextPreparation();
      await internal.settle();
    });
    const original = jobs.get(queued!.id)!;
    expect(original).toMatchObject({ status: "failed", lastError: { code: "FONT_MISSING" } });
    const fallback = [...jobs.values()].find((j) => j.fallbackOfJobId === original.id)!;
    expect(fallback).toMatchObject({ engine: "creatomate", routeReason: "fallback_after_error", status: "preparing_clips", templateSnapshotId: "snap-cm", providerAccountId: CM_ACCOUNT, workflowRunId: "run-1" });
    expect(jobs.size).toBe(2);

    await runner.processNext(); // reconcile: the newest job (the fallback) is still pending -> the run is NOT failed
    expect(runs[0]!.status).toBe("render_queued");
  }, 300_000);

  it("an input-data failure (a missing voice file) fails the run without a fallback", async () => {
    const { jobs, runs, runner, renderJobs, internal, prisma } = await build({ font: hostFont! });
    await runner.processNext();
    // the voice file vanished from the store after the timeline was approved
    (await prisma.mediaAssetVersion.findMany({ where: { id: { in: ["au2"] }, projectId } }))[0]!.relativePath = "projects/p/gone.mp3";
    await renderJobs.processNextPreparation();
    await internal.settle();
    const [job] = [...jobs.values()];
    expect(job).toMatchObject({ status: "failed", lastError: { code: "SOURCE_NOT_FOUND" } });
    expect(jobs.size).toBe(1);
    await runner.processNext();
    expect(runs[0]).toMatchObject({ status: "failed", lastError: { code: "SOURCE_NOT_FOUND", stepKey: "render" } });
  }, 300_000);
});
