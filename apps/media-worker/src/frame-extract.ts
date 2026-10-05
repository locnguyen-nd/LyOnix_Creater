import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeExpiresAt } from "@lyonix/domain";
import {
  FRAME_EXTRACT_PROFILE_VERSION,
  FRAME_EXTRACT_RESULT_TYPE,
  frameExtractFingerprint,
  MAX_FRAME_EXTRACT_BYTES,
  MEDIA_JOB_SCHEMA_VERSION,
  validateFrameExtractJob,
  type ExtractedFrame,
  type FrameExtractFailure,
  type FrameExtractJob,
  type FrameExtractResult,
  type FrameExtractSuccess,
} from "@lyonix/media-jobs";
import { buildProbeArgs, parseProbeJson, type ProbeInfo } from "./clip-plan.js";
import { jobDirName, MEDIA_JOBS_DIR, sha256File } from "./clip-prepare.js";
import type { MediaWorkerConfig } from "./config.js";
import { JobLockBusyError, MediaJobError } from "./job-errors.js";
import { resolveMediaSource } from "./media-source.js";
import { buildFrameArgs, FRAME_QUALITY_TIERS, readJpegSize, sampleTimesMs } from "./frame-plan.js";
import { BinaryNotFoundError, ProcessTimeoutError, type ProcessRunner } from "./process.js";

const MANIFEST_FILE = "result.json";
const LOCK_FILE = ".lock";

type StoredManifest = { fingerprint: string; result: FrameExtractSuccess };

export type FrameExtractProcessorDeps = {
  config: Pick<MediaWorkerConfig, "mediaRoot" | "ffmpegPath" | "ffprobePath" | "jobTimeoutMs" | "maxAttempts">;
  runner: ProcessRunner;
  ffmpegVersion: string;
  now?: () => Date;
  log?: (message: string) => void;
};

/**
 * Executes `frame.extract` jobs (VE2E-30): a few JPEG frames from a stored video, under `working/media-jobs/<key>/`
 * (7-day TTL, local disk only). Same guarantees as `ClipPrepareProcessor`: idempotent by `jobKey` (stored
 * `result.json` + fingerprint => `reused: true`, JOB_KEY_CONFLICT on a different input), cross-process lock file,
 * bounded retries, and every failure returned as `ok: false` (only a busy lock rejects).
 */
export class FrameExtractProcessor {
  private readonly inflight = new Map<string, Promise<FrameExtractResult>>();
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: FrameExtractProcessorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  handle(raw: unknown): Promise<FrameExtractResult> {
    const validation = validateFrameExtractJob(raw);
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

  private async run(job: FrameExtractJob): Promise<FrameExtractResult> {
    const jobRel = `${MEDIA_JOBS_DIR}/${jobDirName(job.jobKey)}`;
    const jobDir = join(this.deps.config.mediaRoot, jobRel);
    const fingerprint = frameExtractFingerprint(job);
    const stored = await this.readStored(jobDir, fingerprint, job.jobKey);
    if (stored) return stored;

    await mkdir(jobDir, { recursive: true });
    const release = await this.acquireLock(jobDir, job.jobKey);
    try {
      const storedAfterLock = await this.readStored(jobDir, fingerprint, job.jobKey);
      if (storedAfterLock) return storedAfterLock;
      let attempts = 0;
      for (;;) {
        attempts += 1;
        try {
          const result = await this.execute(job, jobDir, jobRel);
          const tmp = join(jobDir, `${MANIFEST_FILE}.tmp`);
          await writeFile(tmp, JSON.stringify({ fingerprint, result } satisfies StoredManifest, null, 2));
          await rename(tmp, join(jobDir, MANIFEST_FILE));
          return result;
        } catch (error) {
          const jobError = this.toJobError(error);
          if (jobError.retryable && attempts < this.deps.config.maxAttempts) {
            this.log(`frame.extract ${job.jobKey} attempt ${attempts} failed (${jobError.code}); retrying`);
            continue;
          }
          return this.failure(job.jobKey, jobError, attempts);
        }
      }
    } finally {
      await release();
    }
  }

  private async readStored(jobDir: string, fingerprint: string, jobKey: string): Promise<FrameExtractResult | null> {
    let manifest: StoredManifest;
    try {
      manifest = JSON.parse(await readFile(join(jobDir, MANIFEST_FILE), "utf8")) as StoredManifest;
    } catch {
      return null;
    }
    if (manifest.fingerprint !== fingerprint) {
      return this.failure(jobKey, new MediaJobError("JOB_KEY_CONFLICT", "jobKey was already used for a different frame.extract input"), 0);
    }
    const result = manifest.result;
    if (new Date(result.expiresAt).getTime() <= this.now().getTime()) return null;
    for (const frame of result.frames) {
      const info = await stat(join(this.deps.config.mediaRoot, frame.relativePath)).catch(() => null);
      if (!info || info.size !== frame.bytes) return null;
    }
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

  /** One frame, at the best JPEG quality that fits the byte cap; null when even the worst tier is too big. */
  private async extractOne(sourcePath: string, atMs: number, maxWidth: number, outPath: string): Promise<{ bytes: number; width: number; height: number } | null> {
    for (const quality of FRAME_QUALITY_TIERS) {
      await rm(outPath, { force: true });
      const result = await this.deps.runner(this.deps.config.ffmpegPath, buildFrameArgs(sourcePath, atMs, outPath, maxWidth, quality), { timeoutMs: this.deps.config.jobTimeoutMs, maxStdoutBytes: 64 * 1024 });
      if (result.exitCode !== 0) throw new MediaJobError("FFMPEG_FAILED", `ffmpeg exited ${result.exitCode}: ${result.stderrTail.slice(-800)}`, true);
      const info = await stat(outPath).catch(() => null);
      if (!info || info.size === 0) return null; // past the last decodable frame: nothing to extract here
      if (info.size > MAX_FRAME_EXTRACT_BYTES) continue;
      const size = readJpegSize(await readFile(outPath));
      if (!size) throw new MediaJobError("OUTPUT_INVALID", "extracted frame is not a readable JPEG");
      return { bytes: info.size, ...size };
    }
    await rm(outPath, { force: true });
    return null;
  }

  private async execute(job: FrameExtractJob, jobDir: string, jobRel: string): Promise<FrameExtractSuccess> {
    const sourcePath = await resolveMediaSource(this.deps.config.mediaRoot, job.source.relativePath);
    const probe = await this.probe(sourcePath);
    const times = sampleTimesMs({ sourceDurationMs: probe.durationMs, frameCount: job.frameCount, windowStartMs: job.windowStartMs, windowDurationMs: job.windowDurationMs });
    const frames: ExtractedFrame[] = [];
    let skipped = 0;
    for (const [index, atMs] of times.entries()) {
      const fileName = `frame-${index}.jpg`;
      const outPath = join(jobDir, fileName);
      const produced = await this.extractOne(sourcePath, atMs, job.maxWidth, outPath);
      if (!produced) { skipped += 1; continue; }
      frames.push({
        relativePath: `${jobRel}/${fileName}`,
        mimeType: "image/jpeg",
        atMs,
        width: produced.width,
        height: produced.height,
        bytes: produced.bytes,
        sha256: await sha256File(outPath),
      });
    }
    if (frames.length === 0) throw new MediaJobError("OUTPUT_INVALID", "no frame could be extracted within the size cap");
    const completedAt = this.now();
    const expiresAt = computeExpiresAt("working", completedAt);
    if (!expiresAt) throw new MediaJobError("INTERNAL", "working retention must expire");
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: FRAME_EXTRACT_RESULT_TYPE,
      ok: true,
      jobKey: job.jobKey,
      reused: false,
      source: { relativePath: job.source.relativePath, mediaAssetVersionId: job.source.mediaAssetVersionId ?? null, durationMs: probe.durationMs, width: probe.video.displayWidth, height: probe.video.displayHeight },
      frames,
      skippedFrames: skipped,
      retentionClass: "working",
      expiresAt: expiresAt.toISOString(),
      tool: { profileVersion: FRAME_EXTRACT_PROFILE_VERSION, ffmpegVersion: this.deps.ffmpegVersion },
      completedAt: completedAt.toISOString(),
    };
  }

  private toJobError(error: unknown): MediaJobError {
    if (error instanceof MediaJobError) return error;
    if (error instanceof ProcessTimeoutError) return new MediaJobError("FFMPEG_TIMEOUT", error.message, true);
    if (error instanceof BinaryNotFoundError) return new MediaJobError("INTERNAL", `${error.binary} is not installed or not on PATH (set FFMPEG_PATH/FFPROBE_PATH)`);
    return new MediaJobError("INTERNAL", error instanceof Error ? error.message : "unknown error");
  }

  private failure(jobKey: string, error: MediaJobError, attempts: number): FrameExtractFailure {
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: FRAME_EXTRACT_RESULT_TYPE,
      ok: false,
      jobKey,
      error: { code: error.code, message: error.message, retryable: error.retryable, attempts },
      completedAt: this.now().toISOString(),
    };
  }
}

