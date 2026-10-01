import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { computeExpiresAt, resolveWithinRoot } from "@lyonix/domain";
import {
  CLIP_PREPARE_PROFILE_VERSION,
  CLIP_PREPARE_RESULT_TYPE,
  clipPrepareFingerprint,
  MEDIA_JOB_SCHEMA_VERSION,
  validateClipPrepareJob,
  type ClipPrepareFailure,
  type ClipPrepareJob,
  type ClipPrepareResult,
  type ClipPrepareSuccess,
  type MediaJobErrorCode,
} from "@lyonix/media-jobs";
import {
  buildCopyArgs,
  buildKeyframeProbeArgs,
  buildProbeArgs,
  buildReencodeArgs,
  checkRange,
  parseKeyframePackets,
  parseProbeJson,
  planClip,
  type ClipPlan,
  type ProbeInfo,
} from "./clip-plan.js";
import type { MediaWorkerConfig } from "./config.js";
import { BinaryNotFoundError, ProcessTimeoutError, type ProcessRunner } from "./process.js";

/** Relative (to MEDIA_ROOT) directory for clip.prepare outputs — `working` retention class, swept after 7 days. */
export const MEDIA_JOBS_DIR = "working/media-jobs";
const MANIFEST_FILE = "result.json";
const OUTPUT_FILE = "clip.mp4";
const LOCK_FILE = ".lock";

export class MediaJobError extends Error {
  constructor(readonly code: MediaJobErrorCode, message: string, readonly retryable = false) {
    super(message);
    this.name = "MediaJobError";
  }
}

/** Another delivery/process holds the job lock; consumer should requeue with a delay. */
export class JobLockBusyError extends Error {
  constructor(readonly jobKey: string) {
    super(`clip.prepare ${jobKey} is being processed elsewhere`);
    this.name = "JobLockBusyError";
  }
}

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
  config: Pick<MediaWorkerConfig, "mediaRoot" | "ffmpegPath" | "ffprobePath" | "copyToleranceMs" | "jobTimeoutMs" | "maxAttempts"> & Partial<Pick<MediaWorkerConfig, "ffmpegThreads">>;
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
        await handle.writeFile(String(process.pid));
        await handle.close();
        return async () => {
          await rm(lockPath, { force: true });
        };
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

  private async resolveSource(relativePath: string): Promise<string> {
    const { mediaRoot } = this.deps.config;
    if (relativePath.startsWith("_quarantine/")) throw new MediaJobError("SOURCE_UNSAFE_PATH", "quarantined files cannot be used as clip sources");
    const resolved = resolveWithinRoot(mediaRoot, relativePath, resolve, relative);
    if (!resolved.ok) throw new MediaJobError("SOURCE_UNSAFE_PATH", `source path rejected (${resolved.reason})`);
    let real: string;
    let realRoot: string;
    try {
      real = await realpath(resolved.absolutePath);
      realRoot = await realpath(mediaRoot);
    } catch {
      throw new MediaJobError("SOURCE_NOT_FOUND", "source file does not exist under MEDIA_ROOT");
    }
    const rel = relative(realRoot, real);
    if (rel.startsWith("..") || rel.split(/[\\/]/)[0] === "..") throw new MediaJobError("SOURCE_UNSAFE_PATH", "source resolves outside MEDIA_ROOT");
    const info = await stat(real);
    if (!info.isFile()) throw new MediaJobError("SOURCE_NOT_FOUND", "source is not a regular file");
    return real;
  }

  private async probe(path: string): Promise<ProbeInfo> {
    const result = await this.deps.runner(this.deps.config.ffprobePath, buildProbeArgs(path), { timeoutMs: this.deps.config.jobTimeoutMs });
    if (result.exitCode !== 0) throw new MediaJobError("PROBE_FAILED", `ffprobe exited ${result.exitCode}: ${result.stderrTail.slice(-500)}`);
    const parsed = parseProbeJson(result.stdout);
    if (!parsed.ok) {
      if (parsed.reason === "no_video_stream") throw new MediaJobError("NO_VIDEO_STREAM", "source has no video stream");
      throw new MediaJobError("PROBE_FAILED", `ffprobe output unusable (${parsed.reason})`);
    }
    return parsed.probe;
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

  private async encode(args: string[]): Promise<void> {
    // VE2E-61: cap encoder threads (output option, inserted before the output path) so parallel jobs share the CPUs.
    const threads = this.deps.config.ffmpegThreads;
    const bounded = threads && threads > 0 && args.length > 0 ? [...args.slice(0, -1), "-threads", String(threads), args[args.length - 1]!] : args;
    const result = await this.deps.runner(this.deps.config.ffmpegPath, bounded, { timeoutMs: this.deps.config.jobTimeoutMs, maxStdoutBytes: 64 * 1024 });
    if (result.exitCode !== 0) throw new MediaJobError("FFMPEG_FAILED", `ffmpeg exited ${result.exitCode}: ${result.stderrTail.slice(-800)}`, true);
  }

  private async execute(job: ClipPrepareJob, jobDir: string, jobRel: string): Promise<ClipPrepareSuccess> {
    const { copyToleranceMs } = this.deps.config;
    const sourcePath = await this.resolveSource(job.source.relativePath);
    const probe = await this.probe(sourcePath);
    const range = checkRange(probe.durationMs, job.startMs, job.durationMs, copyToleranceMs);
    if (!range.ok) throw new MediaJobError("RANGE_OUT_OF_BOUNDS", range.message);

    const keyframes = await this.probeKeyframes(sourcePath, probe, job.startMs);
    let plan: ClipPlan = planClip({
      probe,
      keyframesMs: keyframes,
      startMs: job.startMs,
      durationMs: job.durationMs,
      stripAudio: job.stripAudio,
      target: job.target,
      toleranceMs: copyToleranceMs,
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
          : buildReencodeArgs(current, sourcePath, partialPath, job.stripAudio, job.target, probe.video.fps),
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
