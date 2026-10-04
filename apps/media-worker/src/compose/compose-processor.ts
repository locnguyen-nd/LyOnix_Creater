import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeExpiresAt } from "@lyonix/domain";
import {
  COMPOSE_PROFILE_VERSION,
  composeFingerprint,
  MEDIA_JOB_SCHEMA_VERSION,
  validateVideoComposeJob,
  VIDEO_COMPOSE_RESULT_TYPE,
  type ComposeQcReport,
  type VideoComposeFailure,
  type VideoComposeJob,
  type VideoComposeProgress,
  type VideoComposeResult,
  type VideoComposeSuccess,
} from "@lyonix/media-jobs";
import { recipeRegistry, resolveRecipeParams, type RenderRecipe } from "@lyonix/render-recipes";
import { jobDirName, sha256File } from "../clip-prepare.js";
import type { MediaWorkerConfig } from "../config.js";
import { resolveMediaSource } from "../media-source.js";
import { BinaryNotFoundError, ProcessTimeoutError, type ProcessRunner } from "../process.js";
import { buildAudioGraph, parseLoudnormMeasurement, type LoudnormMeasurement } from "./audio-graph.js";
import type { ComposeConfig } from "./config.js";
import { ComposeJobError } from "./errors.js";
import { buildVideoGraph, filterComplexFileArgs, FPS, motionFor } from "./filtergraph.js";
import { buildOverlayDocuments } from "./overlays.js";
import { FfmpegProgressParser, progressPercent, type ProgressStage } from "./progress.js";
import { evaluateStructure, measurementsFromProbe, parseProbedOutput, probeOutput, reportFromChecks } from "./qc.js";
import { runFullQc, type FullQcContext } from "./qc-signal.js";
import { acquireJobLock } from "./job-lock.js";

/** Relative (to MEDIA_ROOT) directory for `video.compose` outputs - `working` retention class, swept after 7 days. */
export const RENDERS_DIR = "working/renders";
const MANIFEST_FILE = "result.json";
const VIDEO_FILE = "video.mp4";
const THUMB_FILE = "thumb.jpg";
const WORK_DIR = "work";

type StoredManifest = { fingerprint: string; result: VideoComposeSuccess };

export type RecipeLookup = { get(id: string, version: number): RenderRecipe | null };

/** Quality control hook run on the finished file (default: the full gate, `runFullQc`). Tests can swap it. */
export type ComposeQcRunner = (context: FullQcContext) => Promise<ComposeQcReport>;

export const structuralQc: ComposeQcRunner = async ({ videoPath, expectedFrames, expectedDurationMs, runner, ffprobePath, timeoutMs }) => {
  const probe = await probeOutput(runner, ffprobePath, videoPath, timeoutMs);
  return reportFromChecks(evaluateStructure(probe, expectedDurationMs, expectedFrames), measurementsFromProbe(probe));
};

export type ComposeProcessorDeps = {
  config: Pick<MediaWorkerConfig, "mediaRoot" | "ffmpegPath" | "ffprobePath" | "maxAttempts">;
  compose: ComposeConfig;
  runner: ProcessRunner;
  ffmpegVersion: string;
  recipes?: RecipeLookup;
  qc?: ComposeQcRunner;
  now?: () => Date;
  log?: (message: string) => void;
};

const toPosix = (path: string) => path.split(/[\\/]/).join("/");
const safeFileName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * VE2E-105: executes `video.compose` jobs - the internal `lyonix` render engine. Idempotent by `jobKey` (stored manifest + lock, like
 * `clip.prepare`). One job = audio pass 1 (loudness measure) -> audio pass 2 (linear normalise to AAC) -> one video FFmpeg run (all
 * scenes, transitions, overlays, captions; x264 CRF 18, 60 fps CFR) muxed with that audio -> thumbnail -> QC. FFmpeg runs only here.
 */
export class ComposeProcessor {
  private readonly inflight = new Map<string, Promise<VideoComposeResult>>();
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly recipes: RecipeLookup;
  private readonly qc: ComposeQcRunner;

  constructor(private readonly deps: ComposeProcessorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
    this.recipes = deps.recipes ?? recipeRegistry;
    this.qc = deps.qc ?? runFullQc;
  }

  /** Never rejects except with JobLockBusyError; every job failure is returned as `ok: false`. */
  handle(raw: unknown, onProgress?: (progress: VideoComposeProgress) => void): Promise<VideoComposeResult> {
    const validation = validateVideoComposeJob(raw);
    if (!validation.ok) {
      const jobKey = typeof (raw as { jobKey?: unknown } | null)?.jobKey === "string" ? (raw as { jobKey: string }).jobKey : "invalid";
      return Promise.resolve(this.failure(jobKey, new ComposeJobError("INVALID_JOB", validation.errors.join("; ")), 0));
    }
    const job = validation.value;
    const existing = this.inflight.get(job.jobKey);
    if (existing) return existing;
    const running = this.run(job, onProgress).finally(() => this.inflight.delete(job.jobKey));
    this.inflight.set(job.jobKey, running);
    return running;
  }

  private async run(job: VideoComposeJob, onProgress?: (progress: VideoComposeProgress) => void): Promise<VideoComposeResult> {
    const { mediaRoot } = this.deps.config;
    const jobRel = `${RENDERS_DIR}/${jobDirName(job.jobKey)}`;
    const jobDir = join(mediaRoot, jobRel);
    const fingerprint = composeFingerprint(job);

    const stored = await this.readStored(jobDir, fingerprint, job.jobKey);
    if (stored) return stored;

    await mkdir(jobDir, { recursive: true });
    const staleAfterMs = this.deps.compose.timeoutMs * (this.deps.config.maxAttempts + 1) * 3 + 60_000;
    const release = await acquireJobLock(jobDir, job.jobKey, staleAfterMs, this.now);
    try {
      const storedAfterLock = await this.readStored(jobDir, fingerprint, job.jobKey);
      if (storedAfterLock) return storedAfterLock;
      let attempts = 0;
      for (;;) {
        attempts += 1;
        try {
          const result = await this.execute(job, jobDir, jobRel, onProgress);
          const tmp = join(jobDir, `${MANIFEST_FILE}.tmp`);
          await writeFile(tmp, JSON.stringify({ fingerprint, result } satisfies StoredManifest, null, 2));
          await rename(tmp, join(jobDir, MANIFEST_FILE));
          return result;
        } catch (error) {
          const jobError = this.toJobError(error);
          await rm(join(jobDir, `${VIDEO_FILE}.partial`), { force: true }).catch(() => undefined);
          if (jobError.retryable && attempts < this.deps.config.maxAttempts) {
            this.log(`video.compose ${job.jobKey} attempt ${attempts} failed (${jobError.code}); retrying`);
            continue;
          }
          return this.failure(job.jobKey, jobError, attempts);
        } finally {
          await rm(join(jobDir, WORK_DIR), { recursive: true, force: true }).catch(() => undefined);
        }
      }
    } finally {
      await release();
    }
  }

  private async readStored(jobDir: string, fingerprint: string, jobKey: string): Promise<VideoComposeResult | null> {
    let manifest: StoredManifest;
    try {
      manifest = JSON.parse(await readFile(join(jobDir, MANIFEST_FILE), "utf8")) as StoredManifest;
    } catch {
      return null;
    }
    if (manifest.fingerprint !== fingerprint) return this.failure(jobKey, new ComposeJobError("JOB_KEY_CONFLICT", "jobKey was already used for a different video.compose input"), 0);
    const result = manifest.result;
    if (new Date(result.expiresAt).getTime() <= this.now().getTime()) return null;
    const outputPath = join(this.deps.config.mediaRoot, result.output.relativePath);
    const info = await stat(outputPath).catch(() => null);
    if (!info || info.size !== result.output.bytes) return null;
    if ((await sha256File(outputPath)) !== result.output.sha256) return null;
    return { ...result, reused: true };
  }

  private recipeFor(job: VideoComposeJob): RenderRecipe {
    const recipe = this.recipes.get(job.recipe.id, job.recipe.version);
    if (!recipe) throw new ComposeJobError("RECIPE_NOT_FOUND", `recipe ${job.recipe.id}@${job.recipe.version} is not available on this worker`);
    return recipe;
  }

  private emit(job: VideoComposeJob, onProgress: ((progress: VideoComposeProgress) => void) | undefined, stage: ProgressStage, frame: number | null, speedX: number | null): void {
    onProgress?.({
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: "video.compose.progress",
      jobKey: job.jobKey,
      stage,
      percent: progressPercent(stage, frame, job.plan.totalFrames),
      frame,
      totalFrames: job.plan.totalFrames,
      speedX,
    });
  }

  /** Resolves one plan file to a real path inside MEDIA_ROOT and checks it has the stream type the plan needs. */
  private async resolveAndProbe(relativePath: string, need: "video" | "audio", label: string): Promise<string> {
    const path = await resolveMediaSource(this.deps.config.mediaRoot, relativePath);
    const result = await this.deps.runner(this.deps.config.ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new ComposeJobError("PROBE_FAILED", `${label}: ffprobe exited ${result.exitCode}: ${result.stderrTail.slice(-300)}`);
    const probe = parseProbedOutput(result.stdout);
    if (need === "video" && !probe?.video) throw new ComposeJobError("NO_VIDEO_STREAM", `${label} has no video stream`);
    if (need === "audio" && !probe?.audio) throw new ComposeJobError("INVALID_JOB", `${label} has no audio stream`);
    return path;
  }

  private async ffmpeg(args: string[], options: { cwd?: string; onLine?: (line: string) => void; timeoutMs?: number; sampleCpu?: boolean }): Promise<{ stderrTail: string; cpuSeconds: number | null }> {
    const result = await this.deps.runner(this.deps.config.ffmpegPath, ["-hide_banner", "-nostdin", ...args], {
      timeoutMs: options.timeoutMs ?? this.deps.compose.timeoutMs,
      maxStdoutBytes: 64 * 1024,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.onLine ? { onStdoutLine: options.onLine } : {}),
      ...(options.sampleCpu ? { sampleCpu: true } : {}),
    });
    if (result.exitCode !== 0) throw new ComposeJobError("FFMPEG_FAILED", `ffmpeg exited ${result.exitCode}: ${result.stderrTail.slice(-800)}`, true);
    return { stderrTail: result.stderrTail, cpuSeconds: result.cpuSeconds ?? null };
  }

  private async execute(job: VideoComposeJob, jobDir: string, jobRel: string, onProgress?: (progress: VideoComposeProgress) => void): Promise<VideoComposeSuccess> {
    const startedAt = performance.now();
    const { plan } = job;
    const recipe = this.recipeFor(job);
    this.emit(job, onProgress, "preparing", null, null);

    // 1. sources: real files inside MEDIA_ROOT with the right streams
    const mediaPaths: string[] = [];
    const voicePaths: string[] = [];
    for (const scene of plan.scenes) {
      mediaPaths.push(await this.resolveAndProbe(scene.media.relativePath, "video", `scene ${scene.sceneId} media`));
      voicePaths.push(await this.resolveAndProbe(scene.voice.relativePath, "audio", `scene ${scene.sceneId} voice`));
    }
    const musicPath = plan.music ? await this.resolveAndProbe(plan.music.relativePath, "audio", "music") : null;

    // 2. work directory: ASS overlays + graph files (FFmpeg runs with this as cwd so the graph only uses plain file names)
    const workDir = join(jobDir, WORK_DIR);
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    const overlays = buildOverlayDocuments(plan, recipe, plan.params);
    const layerAss: Record<string, string> = {};
    for (const layer of overlays.layers) {
      const file = `layer-${safeFileName(layer.layerId)}.ass`;
      await writeFile(join(workDir, file), layer.ass);
      layerAss[layer.layerId] = file;
    }
    if (overlays.captions) await writeFile(join(workDir, "captions.ass"), overlays.captions.ass);
    const params = resolveRecipeParams(recipe, plan.params);
    const video = buildVideoGraph({ plan, recipe, params: { ...plan.params, ...params }, mediaPaths, overlays: { layerAss, captionsAss: overlays.captions ? "captions.ass" : null }, fontsDir: this.deps.compose.fontsDir });
    await writeFile(join(workDir, "video-graph.txt"), video.filterComplex);

    // 3. audio: measure, then apply linearly -> AAC
    const audioInputs: string[] = voicePaths.flatMap((path) => ["-i", path]);
    const musicInputIndex = musicPath ? voicePaths.length : null;
    if (musicPath) audioInputs.push("-stream_loop", "-1", "-t", (plan.totalFrames / FPS + 1).toFixed(3), "-i", musicPath);
    const runAudio = async (loudnorm: "measure" | LoudnormMeasurement | "skip", output: string[]) => {
      const graph = buildAudioGraph({ plan, recipe, voiceInputOffset: 0, musicInputIndex, loudnorm });
      await writeFile(join(workDir, "audio-graph.txt"), graph.filterComplex);
      return this.ffmpeg(["-v", "info", "-nostats", "-y", ...audioInputs, ...filterComplexFileArgs("audio-graph.txt", this.deps.ffmpegVersion), "-map", "[aout]", ...output], { cwd: workDir, timeoutMs: 5 * 60_000, sampleCpu: true });
    };
    const measured = await runAudio("measure", ["-f", "null", "-"]);
    const measurement = parseLoudnormMeasurement(measured.stderrTail);
    if (!measurement) throw new ComposeJobError("QC_AUDIO", "the mixed audio is silent or could not be measured (loudnorm)");
    const audioPass = await runAudio(measurement, ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "audio.m4a"]);

    // 4. video: one FFmpeg run, progress from -progress pipe:1
    const partial = join(jobDir, `${VIDEO_FILE}.partial`);
    await rm(partial, { force: true });
    const audioIndex = plan.scenes.length;
    const parser = new FfmpegProgressParser();
    let lastEmit = 0;
    const threads = this.deps.compose.x264Threads;
    const videoArgs = [
      "-v", "error", "-nostats", "-y", "-progress", "pipe:1",
      ...video.inputArgs, "-i", join(workDir, "audio.m4a"),
      ...filterComplexFileArgs("video-graph.txt", this.deps.ffmpegVersion),
      "-map", "[v]", "-map", `${audioIndex}:a`,
      "-c:v", "libx264", "-preset", this.deps.compose.x264Preset, "-crf", "18", "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p",
      // the fastest presets drop CABAC/8x8dct and silently fall back to Constrained Baseline: keep the stream High whatever the preset
      "-x264-params", "cabac=1:8x8dct=1",
      "-r", String(FPS), "-fps_mode", "cfr", "-frames:v", String(plan.totalFrames),
      "-g", String(FPS * 2), "-keyint_min", String(FPS * 2), "-sc_threshold", "0",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-c:a", "copy", "-movflags", "+faststart", ...(threads > 0 ? ["-threads", String(threads), "-filter_complex_threads", String(threads)] : []),
      "-f", "mp4", partial,
    ];
    const encoded = await this.ffmpeg(videoArgs, {
      cwd: workDir,
      sampleCpu: true,
      onLine: (line) => {
        const snapshot = parser.push(line);
        const nowMs = performance.now();
        if (snapshot && (nowMs - lastEmit > 1000 || snapshot.ended)) {
          lastEmit = nowMs;
          this.emit(job, onProgress, "encoding", snapshot.frame, snapshot.speedX);
        }
      },
    });

    // 5. finalize files, thumbnail, QC
    const videoPath = join(jobDir, VIDEO_FILE);
    await rename(partial, videoPath);
    const thumbPath = join(jobDir, THUMB_FILE);
    const thumbAt = Math.min(plan.padStartFrames / FPS + 0.8, Math.max(0, plan.totalFrames / FPS - 0.1));
    await this.ffmpeg(["-v", "error", "-y", "-ss", thumbAt.toFixed(3), "-i", videoPath, "-frames:v", "1", "-vf", "scale=in_range=tv:out_range=pc,format=yuvj420p", "-q:v", "2", thumbPath], { timeoutMs: 60_000 });

    this.emit(job, onProgress, "qc", plan.totalFrames, null);
    const expectedDurationMs = (plan.totalFrames * 1000) / FPS;
    const qc = await this.qc({
      videoPath,
      expectedFrames: plan.totalFrames,
      expectedDurationMs,
      targetLufs: recipe.audio.loudnessLufs,
      // a still image with the zoom switched off is static by design: a frozen stretch is then intended, not a defect
      freezeCheck: !(plan.scenes.some((scene) => scene.media.kind === "image") && motionFor("image", 0, recipe, { ...plan.params, ...params }) === null),
      runner: this.deps.runner,
      ffmpegPath: this.deps.config.ffmpegPath,
      ffprobePath: this.deps.config.ffprobePath,
      timeoutMs: 120_000,
    });
    if (!qc.passed) {
      const failed = qc.checks.filter((check) => !check.ok);
      const first = failed[0]!;
      throw new ComposeJobError(first.code, `QC failed: ${failed.map((check) => `${check.code} (${check.message}; measured ${String(check.measured)}, expected ${String(check.expected)})`).join("; ")}`, false, qc);
    }

    this.emit(job, onProgress, "finalizing", plan.totalFrames, null);
    const [videoInfo, thumbInfo, videoSha, thumbSha] = await Promise.all([stat(videoPath), stat(thumbPath), sha256File(videoPath), sha256File(thumbPath)]);
    const completedAt = this.now();
    const expiresAt = computeExpiresAt("working", completedAt);
    if (!expiresAt) throw new ComposeJobError("INTERNAL", "working retention must expire");
    // the video run dominates; a pass shorter than the sampling interval reports null and counts as 0
    const cpu = encoded.cpuSeconds === null ? null : encoded.cpuSeconds + (audioPass.cpuSeconds ?? 0) + (measured.cpuSeconds ?? 0);
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: VIDEO_COMPOSE_RESULT_TYPE,
      ok: true,
      jobKey: job.jobKey,
      reused: false,
      output: {
        relativePath: toPosix(`${jobRel}/${VIDEO_FILE}`),
        mimeType: "video/mp4",
        sha256: videoSha,
        bytes: videoInfo.size,
        durationMs: Math.round(expectedDurationMs),
        width: 1080,
        height: 1920,
        fps: FPS,
      },
      thumbnail: { relativePath: toPosix(`${jobRel}/${THUMB_FILE}`), mimeType: "image/jpeg", sha256: thumbSha, bytes: thumbInfo.size, width: 1080, height: 1920 },
      qc,
      metrics: { renderMs: Math.round(performance.now() - startedAt), cpuSeconds: cpu === null ? null : Math.round(cpu * 10) / 10, x264Preset: this.deps.compose.x264Preset, x264Threads: threads },
      retentionClass: "working",
      expiresAt: expiresAt.toISOString(),
      tool: { profileVersion: COMPOSE_PROFILE_VERSION, ffmpegVersion: this.deps.ffmpegVersion, recipe: { id: recipe.id, version: recipe.version } },
      completedAt: completedAt.toISOString(),
    };
  }

  private toJobError(error: unknown): ComposeJobError {
    if (error instanceof ComposeJobError) return error;
    if (error instanceof ProcessTimeoutError) return new ComposeJobError("FFMPEG_TIMEOUT", error.message, false);
    if (error instanceof BinaryNotFoundError) return new ComposeJobError("INTERNAL", `${error.binary} is not installed or not on PATH (set FFMPEG_PATH/FFPROBE_PATH)`);
    // MediaJobError from the shared source resolver (SOURCE_NOT_FOUND / SOURCE_UNSAFE_PATH) keeps its code
    const coded = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (error instanceof Error && typeof coded.code === "string" && error.name === "MediaJobError") {
      return new ComposeJobError(coded.code as ComposeJobError["code"], error.message, coded.retryable === true);
    }
    return new ComposeJobError("INTERNAL", error instanceof Error ? error.message : "unknown error");
  }

  private failure(jobKey: string, error: ComposeJobError, attempts: number): VideoComposeFailure {
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: VIDEO_COMPOSE_RESULT_TYPE,
      ok: false,
      jobKey,
      error: { code: error.code, message: error.message, retryable: error.retryable, attempts },
      ...(error.qc ? { qc: error.qc } : {}),
      completedAt: this.now().toISOString(),
    };
  }
}

