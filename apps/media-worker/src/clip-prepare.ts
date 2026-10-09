import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { computeExpiresAt, resolveWithinRoot } from "@lyonix/domain";
import {
  CLIP_CROP_PROFILE_VERSION,
  CLIP_PREPARE_PROFILE_VERSION,
  CLIP_PREPARE_RESULT_TYPE,
  clipPrepareFingerprint,
  cropPlanDigest,
  MEDIA_JOB_SCHEMA_VERSION,
  validateClipPrepareJob,
  type ClipPrepareFailure,
  type ClipPrepareJob,
  type ClipPrepareReframe,
  type ClipPrepareResult,
  type ClipPrepareSuccess,
  type MediaJobErrorCode,
} from "@lyonix/media-jobs";
import {
  buildCopyArgs,
  buildCropdetectArgs,
  decideBarCrop,
  parseCropdetect,
  type BarCrop,
  buildImageCropArgs,
  buildKeyframeProbeArgs,
  buildProbeArgs,
  buildReencodeArgs,
  buildSmoothnessProbeArgs,
  checkRange,
  isFullFrameCropPlan,
  measureSmoothness,
  parseKeyframePackets,
  parseProbeJson,
  planClip,
  type ClipPlan,
  type ProbeInfo,
} from "./clip-plan.js";
import type { MediaWorkerConfig } from "./config.js";
import { lockOwner, lockOwnerGone } from "./compose/job-lock.js";
import { JobLockBusyError, MediaJobError } from "./job-errors.js";
import { resolveMediaSource } from "./media-source.js";
import { BinaryNotFoundError, ProcessTimeoutError, type ProcessRunner } from "./process.js";

export { JobLockBusyError, MediaJobError };

/** Relative (to MEDIA_ROOT) directory for clip.prepare outputs — `working` retention class, swept after 7 days. */
export const MEDIA_JOBS_DIR = "working/media-jobs";
const MANIFEST_FILE = "result.json";
const OUTPUT_FILE = "clip.mp4";
const IMAGE_OUTPUT_FILE = "clip.jpg";
const LOCK_FILE = ".lock";

type StoredManifest = { fingerprint: string; result: ClipPrepareSuccess };

export const jobDirName = (jobKey: string): string => createHash("sha256").update(jobKey).digest("hex").slice(0, 40);

export const sha256File = (path: string): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", rejectPromise)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });

const toPosix = (path: string) => path.split(sep).join("/");

export type ClipPrepareProcessorDeps = {
  config: Pick<MediaWorkerConfig, "mediaRoot" | "ffmpegPath" | "ffprobePath" | "copyToleranceMs" | "jobTimeoutMs" | "maxAttempts"> & Partial<Pick<MediaWorkerConfig, "ffmpegThreads" | "smoothCheck" | "barCrop">>;
  runner: ProcessRunner;
  ffmpegVersion: string;
  now?: () => Date;
  log?: (message: string) => void;
};

/**
 * Executes `clip.prepare` jobs. Idempotent by `jobKey`: the first successful run
 * stores `result.json` next to the output; later deliveries of the same job (same
 * fingerprint) return it with `reused: true` and never run FFmpeg again. Concurrent
 * deliveries of one key in this process share one promise; across processes a
 * lock file (`open wx`) serialises them.
 */
export class ClipPrepareProcessor {
  private readonly inflight = new Map<string, Promise<ClipPrepareResult>>();
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: ClipPrepareProcessorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  /** Never rejects except with JobLockBusyError; all job failures are returned as `ok: false` results. */
  handle(raw: unknown): Promise<ClipPrepareResult> {
    const validation = validateClipPrepareJob(raw);
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

  private async run(job: ClipPrepareJob): Promise<ClipPrepareResult> {
    const { mediaRoot } = this.deps.config;
    const jobRel = `${MEDIA_JOBS_DIR}/${jobDirName(job.jobKey)}`;
    const jobDir = join(mediaRoot, jobRel);
    const fingerprint = clipPrepareFingerprint(job);

    const stored = await this.readStored(jobDir, fingerprint, job.jobKey);
    if (stored) return stored;

    await mkdir(jobDir, { recursive: true });
    const release = await this.acquireLock(jobDir, job.jobKey);
    try {
      // Re-check after acquiring the lock: another process may have finished meanwhile.
      const storedAfterLock = await this.readStored(jobDir, fingerprint, job.jobKey);
      if (storedAfterLock) return storedAfterLock;
      let attempts = 0;
      for (;;) {
        attempts += 1;
        try {
          const result = await this.execute(job, jobDir, jobRel);
          const manifest: StoredManifest = { fingerprint, result };
          const tmpManifest = join(jobDir, `${MANIFEST_FILE}.tmp`);
          await writeFile(tmpManifest, JSON.stringify(manifest, null, 2));
          await rename(tmpManifest, join(jobDir, MANIFEST_FILE));
          return result;
        } catch (error) {
          const jobError = this.toJobError(error);
          await rm(join(jobDir, `${OUTPUT_FILE}.partial`), { force: true }).catch(() => undefined);
          if (jobError.retryable && attempts < this.deps.config.maxAttempts) {
            this.log(`clip.prepare ${job.jobKey} attempt ${attempts} failed (${jobError.code}); retrying`);
            continue;
          }
          return this.failure(job.jobKey, jobError, attempts);
        }
      }
    } finally {
      await release();
    }
  }

  private async readStored(jobDir: string, fingerprint: string, jobKey: string): Promise<ClipPrepareResult | null> {
    let manifest: StoredManifest;
    try {
      manifest = JSON.parse(await readFile(join(jobDir, MANIFEST_FILE), "utf8")) as StoredManifest;
    } catch {
      return null;
    }
    if (manifest.fingerprint !== fingerprint) {
      return this.failure(jobKey, new MediaJobError("JOB_KEY_CONFLICT", "jobKey was already used for a different clip.prepare input"), 0);
    }
    const result = manifest.result;
    if (new Date(result.output.expiresAt).getTime() <= this.now().getTime()) return null; // expired: redo
    const outputPath = join(this.deps.config.mediaRoot, result.output.relativePath);
    const info = await stat(outputPath).catch(() => null);
    if (!info || info.size !== result.output.bytes) return null;
    if ((await sha256File(outputPath)) !== result.output.sha256) return null;
    return { ...result, reused: true };
  }

  private async acquireLock(jobDir: string, jobKey: string): Promise<() => Promise<void>> {
    const lockPath = join(jobDir, LOCK_FILE);
    const staleAfterMs = this.deps.config.jobTimeoutMs * (this.deps.config.maxAttempts + 1) * 3 + 60_000;
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(lockOwner());
        await handle.close();
        return async () => {
          await rm(lockPath, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await stat(lockPath).catch(() => null);
        // a lock left by a worker process that died on this host is taken over at once (see compose/job-lock.ts)
        if ((info && this.now().getTime() - info.mtimeMs > staleAfterMs) || (await lockOwnerGone(lockPath))) {
          await rm(lockPath, { force: true });
          continue;
        }
        throw new JobLockBusyError(jobKey);
      }
    }
    throw new JobLockBusyError(jobKey);
  }

  private resolveSource(relativePath: string): Promise<string> {
    return resolveMediaSource(this.deps.config.mediaRoot, relativePath);
  }

  private async probe(path: string, isImage = false): Promise<ProbeInfo> {
    const result = await this.deps.runner(this.deps.config.ffprobePath, buildProbeArgs(path), { timeoutMs: this.deps.config.jobTimeoutMs });
    if (result.exitCode !== 0) throw new MediaJobError("PROBE_FAILED", `ffprobe exited ${result.exitCode}: ${result.stderrTail.slice(-500)}`);
    let text = result.stdout;
    if (isImage) {
      // ffprobe reports no duration for stills; give the shared parser a nominal one (same trick as reframe.analyze).
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

  /** VE2E-143: cropdetect on 2 s of the cut. Best effort: any failure means "no bars". */
  private async detectBarCrop(path: string, probe: ProbeInfo, startMs: number): Promise<BarCrop | null> {
    if (this.deps.config.barCrop !== true) return null; // opt-in at the processor level (config loader enables it by default)
    try {
      const sampleStart = Math.min(startMs, Math.max(0, probe.durationMs - 3500));
      const result = await this.deps.runner(this.deps.config.ffmpegPath, buildCropdetectArgs(path, sampleStart), { timeoutMs: Math.min(this.deps.config.jobTimeoutMs, 20_000), maxStdoutBytes: 64 * 1024 });
      if (result.exitCode !== 0) return null;
      return decideBarCrop(probe.video, parseCropdetect(result.stderrTail));
    } catch (error) {
      if (error instanceof BinaryNotFoundError) throw error;
      return null;
    }
  }

  private async probeKeyframes(path: string, probe: ProbeInfo, startMs: number): Promise<number[] | null> {
    try {
      const result = await this.deps.runner(
        this.deps.config.ffprobePath,
        buildKeyframeProbeArgs(path, startMs, this.deps.config.copyToleranceMs),
        { timeoutMs: this.deps.config.jobTimeoutMs },
      );
      if (result.exitCode !== 0) return null;
      return parseKeyframePackets(result.stdout, probe.startTimeMs);
    } catch (error) {
      if (error instanceof BinaryNotFoundError) throw error;
      return null; // keyframe index is an optimisation; without it we just re-encode
    }
  }

  /**
   * VE2E-90: timestamp regularity of an output clip. Returns null when the check is disabled, ffprobe fails or the clip has too few
   * frames to judge (never fails the job). `trimEdgeFrames` ignores the reorder hole a stream copy leaves at its ends.
   */
  private async checkSmooth(path: string, trimEdgeFrames: number): Promise<{ smooth: boolean; detail: string } | null> {
    if (this.deps.config.smoothCheck === false) return null;
    try {
      const result = await this.deps.runner(this.deps.config.ffprobePath, buildSmoothnessProbeArgs(path), { timeoutMs: this.deps.config.jobTimeoutMs });
      if (result.exitCode !== 0) return null;
      const report = measureSmoothness(result.stdout, { trimEdgeFrames });
      if (!report) return null;
      return { smooth: report.smooth, detail: `median ${report.medianDeltaMs}ms max ${report.maxDeltaMs}ms irregular ${report.irregularPct}% gridError ${report.gridErrorFrames}` };
    } catch (error) {
      if (error instanceof BinaryNotFoundError) throw error;
      return null;
    }
  }

  private async encode(args: string[]): Promise<void> {
    // VE2E-61: cap encoder threads (output option, inserted before the output path) so parallel jobs share the CPUs.
    const threads = this.deps.config.ffmpegThreads;
    const bounded = threads && threads > 0 && args.length > 0 ? [...args.slice(0, -1), "-threads", String(threads), args[args.length - 1]!] : args;
    const result = await this.deps.runner(this.deps.config.ffmpegPath, bounded, { timeoutMs: this.deps.config.jobTimeoutMs, maxStdoutBytes: 64 * 1024 });
    if (result.exitCode !== 0) throw new MediaJobError("FFMPEG_FAILED", `ffmpeg exited ${result.exitCode}: ${result.stderrTail.slice(-800)}`, true);
  }

  /** The plan was computed on the displayed size of the source; applying it to another size would cut the wrong area (never guess). */
  private assertCropPlanFits(job: ClipPrepareJob, probe: ProbeInfo): void {
    const plan = job.cropPlan;
    if (!plan) return;
    if (plan.sourceWidthPx !== probe.video.displayWidth || plan.sourceHeightPx !== probe.video.displayHeight) {
      throw new MediaJobError(
        "INVALID_JOB",
        `cropPlan was computed for a ${plan.sourceWidthPx}x${plan.sourceHeightPx} source but the file is ${probe.video.displayWidth}x${probe.video.displayHeight}`,
      );
    }
  }

  private reframeLineage(job: ClipPrepareJob): ClipPrepareReframe | null {
    const plan = job.cropPlan;
    if (!plan) return null;
    return {
      applied: isFullFrameCropPlan(plan) ? "full_frame" : "crop",
      planVersion: plan.version,
      mode: plan.mode,
      zoomPermille: plan.zoomPermille,
      cropPlanSha256: cropPlanDigest(plan),
      primarySubjectId: plan.primarySubjectId,
      overlayUnavoidable: plan.overlayUnavoidable,
      residualOverlayPct: plan.residualOverlayPct,
      subjectCoveragePct: plan.subjectCoveragePct,
      cropProfileVersion: CLIP_CROP_PROFILE_VERSION,
    };
  }

  /** VE2E-67: still image -> one 1080x1920 JPEG (crop-plan window, else centre-cover). */
  private async executeImage(job: ClipPrepareJob, jobDir: string, jobRel: string): Promise<ClipPrepareSuccess> {
    const sourcePath = await this.resolveSource(job.source.relativePath);
    const probe = await this.probe(sourcePath, true);
    this.assertCropPlanFits(job, probe);
    const partialPath = join(jobDir, `${IMAGE_OUTPUT_FILE}.partial`);
    await rm(partialPath, { force: true });
    await this.encode(buildImageCropArgs(sourcePath, partialPath, job.target, job.cropPlan ?? null));
    const outputProbe = await this.probe(partialPath, true).catch((error: unknown) => {
      throw new MediaJobError("OUTPUT_INVALID", `output probe failed: ${error instanceof Error ? error.message : "unknown"}`);
    });
    if (outputProbe.video.displayWidth !== job.target.width || outputProbe.video.displayHeight !== job.target.height) {
      throw new MediaJobError("OUTPUT_INVALID", `image output is ${outputProbe.video.displayWidth}x${outputProbe.video.displayHeight}, expected ${job.target.width}x${job.target.height}`);
    }
    const finalPath = join(jobDir, IMAGE_OUTPUT_FILE);
    await rename(partialPath, finalPath);
    const info = await stat(finalPath);
    const sha256 = await sha256File(finalPath);
    const completedAt = this.now();
    const expiresAt = computeExpiresAt("working", completedAt);
    if (!expiresAt) throw new MediaJobError("INTERNAL", "working retention must expire");
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: CLIP_PREPARE_RESULT_TYPE,
      ok: true,
      jobKey: job.jobKey,
      reused: false,
      mode: "reencode",
      reencodeReasons: [job.cropPlan ? "still_image_crop" : "still_image_cover"],
      cut: { startMs: 0, durationMs: 0 },
      drift: { startMs: 0, durationMs: 0 },
      toleranceMs: this.deps.config.copyToleranceMs,
      source: {
        relativePath: job.source.relativePath,
        mediaAssetVersionId: job.source.mediaAssetVersionId ?? null,
        durationMs: 0,
        width: probe.video.displayWidth,
        height: probe.video.displayHeight,
        videoCodec: probe.video.codec,
        audioCodec: null,
        kind: "image",
      },
      output: {
        relativePath: toPosix(`${jobRel}/${IMAGE_OUTPUT_FILE}`),
        mimeType: "image/jpeg",
        sha256,
        bytes: info.size,
        durationMs: 0,
        width: outputProbe.video.displayWidth,
        height: outputProbe.video.displayHeight,
        videoCodec: outputProbe.video.codec,
        hasAudio: false,
        retentionClass: "working",
        expiresAt: expiresAt.toISOString(),
      },
      ...(job.cropPlan ? { reframe: this.reframeLineage(job) } : {}),
      tool: { profileVersion: CLIP_PREPARE_PROFILE_VERSION, ffmpegVersion: this.deps.ffmpegVersion },
      completedAt: completedAt.toISOString(),
    };
  }

  private async execute(job: ClipPrepareJob, jobDir: string, jobRel: string): Promise<ClipPrepareSuccess> {
    if (job.source.kind === "image") return this.executeImage(job, jobDir, jobRel);
    const { copyToleranceMs } = this.deps.config;
    const sourcePath = await this.resolveSource(job.source.relativePath);
    const probe = await this.probe(sourcePath);
    this.assertCropPlanFits(job, probe);
    const range = checkRange(probe.durationMs, job.startMs, job.durationMs, copyToleranceMs);
    if (!range.ok) throw new MediaJobError("RANGE_OUT_OF_BOUNDS", range.message);

    const keyframes = await this.probeKeyframes(sourcePath, probe, job.startMs);
    // VE2E-143: a reframe crop plan already decides the window; otherwise remove baked-in letterbox bars before the cover-crop.
    const barCrop = job.cropPlan ? null : await this.detectBarCrop(sourcePath, probe, job.startMs);
    let plan: ClipPlan = planClip({
      probe,
      keyframesMs: keyframes,
      startMs: job.startMs,
      durationMs: job.durationMs,
      stripAudio: job.stripAudio,
      target: job.target,
      toleranceMs: copyToleranceMs,
      cropPlan: job.cropPlan ?? null,
      barCrop,
    });

    const partialPath = join(jobDir, `${OUTPUT_FILE}.partial`);
    const reencodePlan = (reasons: string[]): ClipPlan => {
      const cutDurationMs = Math.min(job.durationMs, probe.durationMs - job.startMs);
      return { mode: "reencode", reencodeReasons: reasons, cutStartMs: job.startMs, cutDurationMs, startDriftMs: 0, durationDriftMs: cutDurationMs - job.durationMs };
    };
    const runPlan = async (current: ClipPlan) => {
      await rm(partialPath, { force: true });
      await this.encode(
        current.mode === "copy"
          ? buildCopyArgs(current, sourcePath, partialPath, job.stripAudio)
          : buildReencodeArgs(current, sourcePath, partialPath, job.stripAudio, job.target, probe.video.fps, job.cropPlan ?? null, barCrop),
      );
      return this.probe(partialPath).catch((error: unknown) => {
        throw new MediaJobError("OUTPUT_INVALID", `output probe failed: ${error instanceof Error ? error.message : "unknown"}`);
      });
    };

    let outputProbe = await runPlan(plan);
    if (plan.mode === "copy" && Math.abs(outputProbe.durationMs - job.durationMs) > copyToleranceMs) {
      // Container/GOP quirks can make a copy cut longer/shorter than planned; honour the tolerance by re-encoding.
      this.log(`clip.prepare ${job.jobKey}: copy output ${outputProbe.durationMs}ms outside tolerance; re-encoding`);
      plan = reencodePlan(["copy_output_duration_drift"]);
      outputProbe = await runPlan(plan);
    }

    if (plan.mode === "copy") {
      const copySmooth = await this.checkSmooth(partialPath, 2);
      if (copySmooth && !copySmooth.smooth) {
        // Stream copy carried source judder into the clip: redo it as a CFR re-encode instead of failing the job.
        this.log(`clip.prepare ${job.jobKey}: copy output not smooth (${copySmooth.detail}); re-encoding`);
        plan = reencodePlan(["copy_output_not_smooth"]);
        outputProbe = await runPlan(plan);
      }
    }
    if (plan.mode === "reencode") {
      const encoded = await this.checkSmooth(partialPath, 0);
      if (encoded && !encoded.smooth) this.log(`clip.prepare ${job.jobKey}: WARNING re-encoded output not smooth (${encoded.detail})`);
    }

    if (job.stripAudio && outputProbe.audio) throw new MediaJobError("OUTPUT_INVALID", "stripAudio requested but output still has an audio track");
    if (outputProbe.video.codec !== "h264") throw new MediaJobError("OUTPUT_INVALID", `output codec ${outputProbe.video.codec} is not h264`);
    if (outputProbe.durationMs < Math.min(job.durationMs, plan.cutDurationMs) / 2) {
      throw new MediaJobError("OUTPUT_INVALID", `output duration ${outputProbe.durationMs}ms is far below requested ${job.durationMs}ms`);
    }

    const finalPath = join(jobDir, OUTPUT_FILE);
    await rename(partialPath, finalPath);
    const info = await stat(finalPath);
    const sha256 = await sha256File(finalPath);
    const completedAt = this.now();
    const expiresAt = computeExpiresAt("working", completedAt);
    if (!expiresAt) throw new MediaJobError("INTERNAL", "working retention must expire");
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: CLIP_PREPARE_RESULT_TYPE,
      ok: true,
      jobKey: job.jobKey,
      reused: false,
      mode: plan.mode,
      reencodeReasons: plan.reencodeReasons,
      cut: { startMs: plan.cutStartMs, durationMs: plan.cutDurationMs },
      drift: { startMs: plan.startDriftMs, durationMs: outputProbe.durationMs - job.durationMs },
      toleranceMs: copyToleranceMs,
      source: {
        relativePath: job.source.relativePath,
        mediaAssetVersionId: job.source.mediaAssetVersionId ?? null,
        durationMs: probe.durationMs,
        width: probe.video.displayWidth,
        height: probe.video.displayHeight,
        videoCodec: probe.video.codec,
        audioCodec: probe.audio?.codec ?? null,
      },
      output: {
        relativePath: toPosix(`${jobRel}/${OUTPUT_FILE}`),
        mimeType: "video/mp4",
        sha256,
        bytes: info.size,
        durationMs: outputProbe.durationMs,
        width: outputProbe.video.displayWidth,
        height: outputProbe.video.displayHeight,
        videoCodec: outputProbe.video.codec,
        hasAudio: outputProbe.audio !== null,
        retentionClass: "working",
        expiresAt: expiresAt.toISOString(),
      },
      ...(job.cropPlan ? { reframe: this.reframeLineage(job) } : {}),
      tool: { profileVersion: CLIP_PREPARE_PROFILE_VERSION, ffmpegVersion: this.deps.ffmpegVersion },
      completedAt: completedAt.toISOString(),
    };
  }

  private toJobError(error: unknown): MediaJobError {
    if (error instanceof MediaJobError) return error;
    if (error instanceof ProcessTimeoutError) return new MediaJobError("FFMPEG_TIMEOUT", error.message, true);
    if (error instanceof BinaryNotFoundError) return new MediaJobError("INTERNAL", `${error.binary} is not installed or not on PATH (set FFMPEG_PATH/FFPROBE_PATH)`);
    return new MediaJobError("INTERNAL", error instanceof Error ? error.message : "unknown error");
  }

  private failure(jobKey: string, error: MediaJobError, attempts: number): ClipPrepareFailure {
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: CLIP_PREPARE_RESULT_TYPE,
      ok: false,
      jobKey,
      error: { code: error.code, message: error.message, retryable: error.retryable, attempts },
      completedAt: this.now().toISOString(),
    };
  }
}
