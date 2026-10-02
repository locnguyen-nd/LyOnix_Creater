import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeExpiresAt, type CropPlan } from "@lyonix/domain";
import {
  isSocialReframeOrigin,
  MEDIA_JOB_SCHEMA_VERSION,
  REFRAME_ANALYZE_PROFILE_VERSION,
  REFRAME_ANALYZE_RESULT_TYPE,
  reframeAnalyzeFingerprint,
  validateReframeAnalyzeJob,
  type ReframeAnalyzeFailure,
  type ReframeAnalyzeJob,
  type ReframeAnalyzeResult,
  type ReframeAnalyzeSuccess,
  type ReframeCropPlan,
} from "@lyonix/media-jobs";
import { buildProbeArgs, parseProbeJson, type ProbeInfo } from "./clip-plan.js";
import { jobDirName, MEDIA_JOBS_DIR } from "./clip-prepare.js";
import type { MediaWorkerConfig } from "./config.js";
import { JobLockBusyError, MediaJobError } from "./job-errors.js";
import { resolveMediaSource } from "./media-source.js";
import { FRAME_QUALITY_TIERS, readJpegSize, sampleTimesMs } from "./frame-plan.js";
import { BinaryNotFoundError, ProcessTimeoutError, type ProcessRunner } from "./process.js";
import { analyzeFrames, type AnalysisFrame } from "./reframe/analyze.js";
import type { ReframeConfig } from "./reframe/config.js";
import type { FrameDetector } from "./reframe/detector.js";
import { decodeJpegToRgb } from "./reframe/image-io.js";
import { reframeModelVersions } from "./reframe/models.js";
import { Semaphore } from "./reframe/semaphore.js";
import { scaleTemplate, TEMPLATE_WORK_WIDTH, type GreyImage } from "./reframe/template-match.js";

// Compile-time guard: the wire type in @lyonix/media-jobs must stay assignable from the domain CropPlan.
type _PlanCompatible = CropPlan extends ReframeCropPlan ? true : never;
const _planCompatible: _PlanCompatible = true;
void _planCompatible;

const MANIFEST_FILE = "result.json";
const LOCK_FILE = ".lock";
/** Hard cap on an analysis frame JPEG (they are ~20-60 KB at 448 px). */
const MAX_ANALYSIS_FRAME_BYTES = 2_200_000;

type StoredManifest = { fingerprint: string; configDigest: string; result: ReframeAnalyzeSuccess };

export type ReframeAnalyzeProcessorDeps = {
  config: Pick<MediaWorkerConfig, "mediaRoot" | "ffmpegPath" | "ffprobePath" | "jobTimeoutMs" | "maxAttempts">;
  reframe: ReframeConfig;
  runner: ProcessRunner;
  ffmpegVersion: string;
  detector: FrameDetector;
  /** Debug/CLI hook, called after a fresh analysis with the frames, subject tracks and exclusions that fed the planner. */
  onDebug?: (info: { job: ReframeAnalyzeJob; result: ReframeAnalyzeSuccess; debug: Awaited<ReturnType<typeof analyzeFrames>>["debug"] }) => void;
  now?: () => Date;
  log?: (message: string) => void;
};

/** ~1 frame / 1.5 s, >= 4, and >= 6 for clips of 8 s or more (spike VE2E-64 §4), capped by REFRAME_MAX_FRAMES. */
export const reframeFrameCount = (windowDurationMs: number, maxFrames: number): number => Math.min(maxFrames, Math.max(4, Math.ceil(windowDurationMs / 1500)));

/** One JPEG frame scaled DOWN so its long side is at most `longSide` (even dimensions); `atMs === null` = a still image. */
export function buildAnalysisFrameArgs(inputPath: string, atMs: number | null, outputPath: string, longSide: number, quality: number): string[] {
  const scale = `scale='if(gt(iw,ih),min(${longSide},iw),-2)':'if(gt(iw,ih),-2,min(${longSide},ih))'`;
  return [
    "-hide_banner", "-nostdin", "-v", "error", "-y",
    ...(atMs === null ? [] : ["-ss", (atMs / 1000).toFixed(3)]),
    "-i", inputPath,
    "-map", "0:v:0", "-frames:v", "1",
    "-vf", scale,
    "-pix_fmt", "yuvj420p", "-q:v", String(quality),
    "-an", "-sn", "-dn", "-map_metadata", "-1",
    "-f", "image2", "-c:v", "mjpeg", outputPath,
  ];
}

/**
 * Executes `reframe.analyze` (VE2E-66): sample frames (FFmpeg) -> detect (local ONNX detectors) -> `planReframe` -> CropPlan.
 * Same guarantees as the other processors: idempotent by `jobKey` (stored `result.json` + fingerprint => `reused: true`,
 * JOB_KEY_CONFLICT on different inputs; a changed worker config recomputes), cross-process lock, bounded attempts, every failure returned
 * as `ok: false` (only a busy lock rejects). At most `reframe.concurrency` analyses run at once in this process.
 */
export class ReframeAnalyzeProcessor {
  private readonly inflight = new Map<string, Promise<ReframeAnalyzeResult>>();
  private readonly limiter: Semaphore;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private templates: Promise<GreyImage[]> | null = null;

  constructor(private readonly deps: ReframeAnalyzeProcessorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
    this.limiter = new Semaphore(deps.reframe.concurrency);
  }

  handle(raw: unknown): Promise<ReframeAnalyzeResult> {
    const validation = validateReframeAnalyzeJob(raw);
    if (!validation.ok) {
      const jobKey = typeof (raw as { jobKey?: unknown } | null)?.jobKey === "string" ? (raw as { jobKey: string }).jobKey : "invalid";
      return Promise.resolve(this.failure(jobKey, new MediaJobError("INVALID_JOB", validation.errors.join("; ")), 0));
    }
    const job = validation.value;
    const existing = this.inflight.get(job.jobKey);
    if (existing) return existing;
    const running = this.run(job).finally(() => this.inflight.delete(job.jobKey));
    this.inflight.set(job.jobKey, running);
    return running;
  }

  /** Digest of every worker setting (and model version) that changes the result: a mismatch recomputes instead of reusing. */
  private configDigest(): string {
    const { modelsDir: _modelsDir, concurrency: _concurrency, ortThreads: _ortThreads, ...rest } = this.deps.reframe;
    return createHash("sha256").update(JSON.stringify({ profile: REFRAME_ANALYZE_PROFILE_VERSION, rest, models: reframeModelVersions() })).digest("hex").slice(0, 32);
  }

  private async run(job: ReframeAnalyzeJob): Promise<ReframeAnalyzeResult> {
    const jobRel = `${MEDIA_JOBS_DIR}/${jobDirName(job.jobKey)}`;
    const jobDir = join(this.deps.config.mediaRoot, jobRel);
    const fingerprint = reframeAnalyzeFingerprint(job);
    const digest = this.configDigest();
    const stored = await this.readStored(jobDir, fingerprint, digest, job.jobKey);
    if (stored) return stored;

    await mkdir(jobDir, { recursive: true });
    const release = await this.acquireLock(jobDir, job.jobKey);
    try {
      const storedAfterLock = await this.readStored(jobDir, fingerprint, digest, job.jobKey);
      if (storedAfterLock) return storedAfterLock;
      let attempts = 0;
      for (;;) {
        attempts += 1;
        try {
          const result = await this.limiter.run(() => this.execute(job, jobDir));
          const tmp = join(jobDir, `${MANIFEST_FILE}.tmp`);
          await writeFile(tmp, JSON.stringify({ fingerprint, configDigest: digest, result } satisfies StoredManifest, null, 2));
          await rename(tmp, join(jobDir, MANIFEST_FILE));
          return result;
        } catch (error) {
          const jobError = this.toJobError(error);
          if (jobError.retryable && attempts < this.deps.config.maxAttempts) {
            this.log(`reframe.analyze ${job.jobKey} attempt ${attempts} failed (${jobError.code}); retrying`);
            continue;
          }
          return this.failure(job.jobKey, jobError, attempts);
        }
      }
    } finally {
      await release();
    }
  }

  private async readStored(jobDir: string, fingerprint: string, digest: string, jobKey: string): Promise<ReframeAnalyzeResult | null> {
    let manifest: StoredManifest;
    try {
      manifest = JSON.parse(await readFile(join(jobDir, MANIFEST_FILE), "utf8")) as StoredManifest;
    } catch {
      return null;
    }
    if (manifest.fingerprint !== fingerprint) {
      return this.failure(jobKey, new MediaJobError("JOB_KEY_CONFLICT", "jobKey was already used for a different reframe.analyze input"), 0);
    }
    if (manifest.configDigest !== digest) return null; // worker settings/models changed: recompute
    if (new Date(manifest.result.expiresAt).getTime() <= this.now().getTime()) return null;
    return { ...manifest.result, reused: true };
  }

  private async acquireLock(jobDir: string, jobKey: string): Promise<() => Promise<void>> {
    const lockPath = join(jobDir, LOCK_FILE);
    const staleAfterMs = this.deps.config.jobTimeoutMs * (this.deps.config.maxAttempts + 1) * 3 + 60_000;
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        return async () => { await rm(lockPath, { force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await stat(lockPath).catch(() => null);
        if (info && this.now().getTime() - info.mtimeMs > staleAfterMs) {
          await rm(lockPath, { force: true });
          continue;
        }
        throw new JobLockBusyError(jobKey);
      }
    }
    throw new JobLockBusyError(jobKey);
  }

  private async probe(path: string, isImage: boolean): Promise<ProbeInfo> {
    const result = await this.deps.runner(this.deps.config.ffprobePath, buildProbeArgs(path), { timeoutMs: this.deps.config.jobTimeoutMs });
    if (result.exitCode !== 0) throw new MediaJobError("PROBE_FAILED", `ffprobe exited ${result.exitCode}: ${result.stderrTail.slice(-500)}`);
    let text = result.stdout;
    if (isImage) {
      // ffprobe reports no duration for stills; give the shared parser a nominal one.
      try {
        const json = JSON.parse(text) as { format?: Record<string, unknown> };
        json.format = { ...(json.format ?? {}), duration: "0.04" };
        text = JSON.stringify(json);
      } catch {
        throw new MediaJobError("PROBE_FAILED", "ffprobe output unusable (malformed)");
      }
    }
    const parsed = parseProbeJson(text);
    if (!parsed.ok) {
      if (parsed.reason === "no_video_stream") throw new MediaJobError("NO_VIDEO_STREAM", "source has no video stream");
      throw new MediaJobError("PROBE_FAILED", `ffprobe output unusable (${parsed.reason})`);
    }
    return parsed.probe;
  }

  /** One analysis frame at the best JPEG quality under the byte cap; null past the last decodable frame. */
  private async extractOne(sourcePath: string, atMs: number | null, outPath: string): Promise<boolean> {
    for (const quality of FRAME_QUALITY_TIERS) {
      await rm(outPath, { force: true });
      const result = await this.deps.runner(this.deps.config.ffmpegPath, buildAnalysisFrameArgs(sourcePath, atMs, outPath, this.deps.reframe.analysisLongSide, quality), { timeoutMs: this.deps.config.jobTimeoutMs, maxStdoutBytes: 64 * 1024 });
      if (result.exitCode !== 0) throw new MediaJobError("FFMPEG_FAILED", `ffmpeg exited ${result.exitCode}: ${result.stderrTail.slice(-800)}`, true);
      const info = await stat(outPath).catch(() => null);
      if (!info || info.size === 0) return false;
      if (info.size > MAX_ANALYSIS_FRAME_BYTES) continue;
      if (!readJpegSize(await readFile(outPath))) throw new MediaJobError("OUTPUT_INVALID", "extracted frame is not a readable JPEG");
      return true;
    }
    await rm(outPath, { force: true });
    return false;
  }

  private loadTemplates(): Promise<GreyImage[]> {
    if (!this.templates) {
      this.templates = (async () => {
        const out: GreyImage[] = [];
        for (const path of this.deps.reframe.logoTemplates) {
          let buffer: Buffer;
          try {
            buffer = await readFile(path);
          } catch {
            throw new MediaJobError("MODEL_NOT_AVAILABLE", `configured logo template not readable: ${path}`);
          }
          try {
            out.push(scaleTemplate(decodeJpegToRgb(buffer), TEMPLATE_WORK_WIDTH, this.deps.reframe.logoTemplateWidthPct));
          } catch {
            throw new MediaJobError("MODEL_NOT_AVAILABLE", `logo template is not a decodable JPEG: ${path}`);
          }
        }
        return out;
      })();
      this.templates.catch(() => { this.templates = null; });
    }
    return this.templates;
  }

  private async execute(job: ReframeAnalyzeJob, jobDir: string): Promise<ReframeAnalyzeSuccess> {
    const startedAt = performance.now();
    const isImage = job.source.kind === "image";
    const sourcePath = await resolveMediaSource(this.deps.config.mediaRoot, job.source.relativePath);
    const probe = await this.probe(sourcePath, isImage);
    const width = probe.video.displayWidth;
    const height = probe.video.displayHeight;
    const cfg = this.deps.reframe;

    // Window (video only). Times in `frames` are relative to the window start.
    let windowStartMs = 0;
    let windowDurationMs = 0;
    let times: number[] = [0];
    if (!isImage) {
      const hasWindow = job.startMs !== null || job.durationMs !== null;
      if ((job.startMs ?? 0) >= probe.durationMs) throw new MediaJobError("RANGE_OUT_OF_BOUNDS", `startMs ${job.startMs} is beyond the source duration ${probe.durationMs}ms`);
      windowStartMs = job.startMs ?? 0;
      windowDurationMs = Math.min(job.durationMs ?? probe.durationMs - windowStartMs, probe.durationMs - windowStartMs);
      const frameCount = reframeFrameCount(windowDurationMs, cfg.maxFrames);
      times = sampleTimesMs({ sourceDurationMs: probe.durationMs, frameCount, windowStartMs: hasWindow ? windowStartMs : null, windowDurationMs: hasWindow ? windowDurationMs : null });
    }

    const sampleStarted = performance.now();
    const frames: AnalysisFrame[] = [];
    for (const [index, atMs] of times.entries()) {
      const outPath = join(jobDir, `frame-${index}.jpg`);
      const produced = await this.extractOne(sourcePath, isImage ? null : atMs, outPath);
      if (!produced) continue;
      frames.push({ tMs: isImage ? 0 : Math.max(0, atMs - windowStartMs), image: decodeJpegToRgb(await readFile(outPath)) });
    }
    if (frames.length === 0) throw new MediaJobError("OUTPUT_INVALID", "no analysis frame could be extracted");
    const sampleMs = performance.now() - sampleStarted;

    const templates = await this.loadTemplates();
    const analysed = await analyzeFrames({
      frames,
      sourceWidth: width,
      sourceHeight: height,
      windowDurationMs,
      isImage,
      social: isSocialReframeOrigin(job.origin),
      preferredSubject: job.preferredSubject,
      detector: this.deps.detector,
      deadlineAt: Date.now() + this.deps.config.jobTimeoutMs,
      settings: {
        presetMargins: cfg.presetMargins,
        textMaxFrames: cfg.textMaxFrames,
        textTopPct: cfg.textTopPct,
        textBottomPct: cfg.textBottomPct,
        templates,
        templateThreshold: cfg.logoTemplateThreshold,
        plan: cfg.plan,
      },
    });
    const analysis = { ...analysed.analysis, framesSampled: times.length };
    if (isSocialReframeOrigin(job.origin) && !isImage && probe.durationMs > 0 && windowStartMs + windowDurationMs > probe.durationMs - 2000) analysis.warnings.push("window_overlaps_possible_tiktok_end_card");

    const completedAt = this.now();
    const expiresAt = computeExpiresAt("working", completedAt);
    if (!expiresAt) throw new MediaJobError("INTERNAL", "working retention must expire");
    const totalMs = performance.now() - startedAt;
    const result: ReframeAnalyzeSuccess = {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: REFRAME_ANALYZE_RESULT_TYPE,
      ok: true,
      jobKey: job.jobKey,
      reused: false,
      source: { relativePath: job.source.relativePath, mediaAssetVersionId: job.source.mediaAssetVersionId ?? null, kind: job.source.kind, durationMs: isImage ? 0 : probe.durationMs, width, height },
      window: { startMs: windowStartMs, durationMs: windowDurationMs },
      cropPlan: analysed.cropPlan,
      overlayUnavoidable: analysed.cropPlan.overlayUnavoidable,
      confidence: analysed.confidence,
      analysis,
      metrics: {
        totalMs: Math.round(totalMs),
        sampleMs: Math.round(sampleMs),
        detectMs: Math.round(analysed.detectMs),
        planMs: Math.round(analysed.planMs),
        detectMsPerFrame: Math.round(analysed.detectMs / frames.length),
        rssPeakMb: analysed.rssPeakMb,
      },
      retentionClass: "working",
      expiresAt: expiresAt.toISOString(),
      tool: { profileVersion: REFRAME_ANALYZE_PROFILE_VERSION, ffmpegVersion: this.deps.ffmpegVersion, detectorRuntime: this.deps.detector.runtime, models: reframeModelVersions() },
      completedAt: completedAt.toISOString(),
    };
    this.deps.onDebug?.({ job, result, debug: analysed.debug });
    return result;
  }

  private toJobError(error: unknown): MediaJobError {
    if (error instanceof MediaJobError) return error;
    if (error instanceof ProcessTimeoutError) return new MediaJobError("FFMPEG_TIMEOUT", error.message, true);
    if (error instanceof BinaryNotFoundError) return new MediaJobError("INTERNAL", `${error.binary} is not installed or not on PATH (set FFMPEG_PATH/FFPROBE_PATH)`);
    return new MediaJobError("INTERNAL", error instanceof Error ? error.message : "unknown error");
  }

  private failure(jobKey: string, error: MediaJobError, attempts: number): ReframeAnalyzeFailure {
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: REFRAME_ANALYZE_RESULT_TYPE,
      ok: false,
      jobKey,
      error: { code: error.code, message: error.message, retryable: error.retryable, attempts },
      completedAt: this.now().toISOString(),
    };
  }
}
