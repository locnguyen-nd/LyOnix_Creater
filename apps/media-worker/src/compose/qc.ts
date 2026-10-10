import type { ComposeQcCheck, ComposeQcMeasurements, ComposeQcReport } from "@lyonix/media-jobs";
import { ComposeJobError } from "./errors.js";
import type { ProcessRunner } from "../process.js";

/**
 * VE2E-105/106: quality control of a finished render. This file holds the structural half (ffprobe: size, fps, codec, audio format,
 * duration); loudness / black-frame / freeze detection are layered on top in `qc-signal.ts`. Every check yields a stable `QC_*` code.
 */

export const QC_TOLERANCES = {
  /** |actual - expected| duration (ms). */
  durationMs: 100,
  fps: 60,
  width: 1080,
  height: 1920,
  sampleRate: 48_000,
} as const;

export type ProbedOutput = {
  video: {
    codec: string | null;
    profile: string | null;
    pixFmt: string | null;
    width: number | null;
    height: number | null;
    rFrameRate: string | null;
    avgFrameRate: string | null;
    nbFrames: number | null;
    durationMs: number | null;
    colorRange: string | null;
    colorSpace: string | null;
  } | null;
  audio: { codec: string | null; sampleRate: number | null; channels: number | null; durationMs: number | null } | null;
  formatDurationMs: number | null;
};

type RawStream = Record<string, unknown>;

const toNumber = (value: unknown): number | null => {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const toMs = (value: unknown): number | null => {
  const seconds = toNumber(value);
  return seconds === null ? null : Math.round(seconds * 1000);
};
const toStr = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

export const buildQcProbeArgs = (path: string): string[] => ["-v", "error", "-show_streams", "-show_format", "-of", "json", path];

export function parseProbedOutput(stdout: string): ProbedOutput | null {
  let json: { streams?: RawStream[]; format?: RawStream };
  try {
    json = JSON.parse(stdout) as typeof json;
  } catch {
    return null;
  }
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  return {
    video: video
      ? {
          codec: toStr(video.codec_name),
          profile: toStr(video.profile),
          pixFmt: toStr(video.pix_fmt),
          width: toNumber(video.width),
          height: toNumber(video.height),
          rFrameRate: toStr(video.r_frame_rate),
          avgFrameRate: toStr(video.avg_frame_rate),
          nbFrames: toNumber(video.nb_frames),
          durationMs: toMs(video.duration),
          colorRange: toStr(video.color_range),
          colorSpace: toStr(video.color_space),
        }
      : null,
    audio: audio ? { codec: toStr(audio.codec_name), sampleRate: toNumber(audio.sample_rate), channels: toNumber(audio.channels), durationMs: toMs(audio.duration) } : null,
    formatDurationMs: toMs(json.format?.duration),
  };
}

export async function probeOutput(runner: ProcessRunner, ffprobePath: string, path: string, timeoutMs: number): Promise<ProbedOutput> {
  const result = await runner(ffprobePath, buildQcProbeArgs(path), { timeoutMs });
  if (result.exitCode !== 0) throw new ComposeJobError("OUTPUT_INVALID", `ffprobe of the render failed: ${result.stderrTail.slice(-300)}`);
  const parsed = parseProbedOutput(result.stdout);
  if (!parsed?.video) throw new ComposeJobError("OUTPUT_INVALID", "render has no video stream");
  return parsed;
}

const rate = (value: string | null): number | null => {
  if (!value) return null;
  const [num, den] = value.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  return Number.isFinite(n) && Number.isFinite(d) && d !== 0 ? n / d : null;
};

const check = (code: ComposeQcCheck["code"], ok: boolean, measured: ComposeQcCheck["measured"], expected: ComposeQcCheck["expected"], message: string): ComposeQcCheck => ({ code, ok, measured, expected, message });

/** Structural checks (no decode): size, CFR 60 fps, codec/profile/pixel format, audio format, duration. */
export function evaluateStructure(probe: ProbedOutput, expectedDurationMs: number, expectedFrames: number): ComposeQcCheck[] {
  const v = probe.video!;
  const checks: ComposeQcCheck[] = [];
  checks.push(
    check("QC_RESOLUTION", v.width === QC_TOLERANCES.width && v.height === QC_TOLERANCES.height, `${v.width}x${v.height}`, `${QC_TOLERANCES.width}x${QC_TOLERANCES.height}`, "output must be 1080x1920"),
  );
  const r = rate(v.rFrameRate);
  const avg = rate(v.avgFrameRate);
  const cfr = r !== null && avg !== null && Math.abs(r - QC_TOLERANCES.fps) < 0.001 && Math.abs(avg - QC_TOLERANCES.fps) < 0.01;
  checks.push(check("QC_FPS", cfr && (v.nbFrames === null || v.nbFrames === expectedFrames), `r=${v.rFrameRate} avg=${v.avgFrameRate} frames=${v.nbFrames ?? "?"}`, `60/1 CFR, ${expectedFrames} frames`, "output must be 60 fps constant frame rate with exactly the planned number of frames"));
  const codecOk = v.codec === "h264" && v.profile === "High" && v.pixFmt === "yuv420p";
  checks.push(check("QC_CODEC", codecOk, `${v.codec}/${v.profile}/${v.pixFmt}`, "h264/High/yuv420p", "video must be H.264 High, yuv420p"));
  const durationMs = v.durationMs ?? probe.formatDurationMs;
  checks.push(
    check("QC_DURATION", durationMs !== null && Math.abs(durationMs - expectedDurationMs) <= QC_TOLERANCES.durationMs, durationMs, expectedDurationMs, `duration must be within ${QC_TOLERANCES.durationMs} ms of voice total + padding`),
  );
  const a = probe.audio;
  const audioOk = a !== null && a.codec === "aac" && a.sampleRate === QC_TOLERANCES.sampleRate && a.channels === 2;
  checks.push(check("QC_AUDIO", audioOk, a ? `${a.codec}/${a.sampleRate}/${a.channels}ch` : "none", "aac/48000/2ch", "audio must be AAC-LC 48 kHz stereo"));
  return checks;
}

export const emptyMeasurements = (): ComposeQcMeasurements => ({
  width: null,
  height: null,
  fps: null,
  videoCodec: null,
  profile: null,
  pixFmt: null,
  durationMs: null,
  audioCodec: null,
  sampleRate: null,
  channels: null,
  integratedLufs: null,
  truePeakDbtp: null,
  blackMs: null,
  whiteMs: null,
  freezeMs: null,
});

export function measurementsFromProbe(probe: ProbedOutput): ComposeQcMeasurements {
  const v = probe.video;
  const a = probe.audio;
  return {
    ...emptyMeasurements(),
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: rate(v?.avgFrameRate ?? null),
    videoCodec: v?.codec ?? null,
    profile: v?.profile ?? null,
    pixFmt: v?.pixFmt ?? null,
    durationMs: v?.durationMs ?? probe.formatDurationMs,
    audioCodec: a?.codec ?? null,
    sampleRate: a?.sampleRate ?? null,
    channels: a?.channels ?? null,
  };
}

export const reportFromChecks = (checks: ComposeQcCheck[], measured: ComposeQcMeasurements): ComposeQcReport => ({ passed: checks.every((c) => c.ok), checks, measured });
