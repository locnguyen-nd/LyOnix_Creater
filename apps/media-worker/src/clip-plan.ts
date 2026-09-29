import type { ClipPrepareMode, ClipTarget } from "@lyonix/media-jobs";

/**
 * VE2E-36 pure logic: ffprobe parsing, range validation, the hybrid copy-vs-reencode
 * decision (CR-JP-ONESHOT-MEDIA §3.2, DEC-2026-09-29 §3) and FFmpeg argument building.
 * No I/O here so every rule is unit-testable without FFmpeg.
 */

export type ProbeInfo = {
  formatName: string;
  durationMs: number;
  /** Container start offset; keyframe pts are absolute, `-ss` is relative to this. */
  startTimeMs: number;
  video: {
    codec: string;
    width: number;
    height: number;
    /** Width/height after applying rotation metadata (what a player shows). */
    displayWidth: number;
    displayHeight: number;
    rotation: number;
    pixFmt: string | null;
    fps: number | null;
  };
  audio: { codec: string } | null;
};

export type ProbeParse = { ok: true; probe: ProbeInfo } | { ok: false; reason: "no_video_stream" | "no_duration" | "malformed" };

const num = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const parseRate = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const [n, d] = value.split("/").map(Number);
  if (n === undefined || !Number.isFinite(n) || n <= 0) return null;
  if (d === undefined) return n;
  return Number.isFinite(d) && d > 0 ? n / d : null;
};

type RawStream = Record<string, unknown> & { side_data_list?: Array<Record<string, unknown>>; tags?: Record<string, unknown> };

const readRotation = (stream: RawStream): number => {
  const fromSideData = stream.side_data_list?.map((entry) => num(entry.rotation)).find((value) => value !== null);
  const raw = fromSideData ?? num(stream.tags?.rotate) ?? 0;
  return ((Math.round(raw) % 360) + 360) % 360;
};

/** Parses `ffprobe -print_format json -show_format -show_streams` output. */
export const parseProbeJson = (text: string): ProbeParse => {
  let data: { streams?: RawStream[]; format?: Record<string, unknown> };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const isAttachedPic = (s: RawStream) => (s.disposition as Record<string, unknown> | undefined)?.attached_pic === 1;
  const video = streams.find((s) => s.codec_type === "video" && !isAttachedPic(s));
  if (!video) return { ok: false, reason: "no_video_stream" };
  const audio = streams.find((s) => s.codec_type === "audio");
  const width = num(video.width) ?? 0;
  const height = num(video.height) ?? 0;
  if (width <= 0 || height <= 0) return { ok: false, reason: "malformed" };
  const durationSec = num(data.format?.duration) ?? num(video.duration);
  if (durationSec === null || durationSec <= 0) return { ok: false, reason: "no_duration" };
  const rotation = readRotation(video);
  const swapped = rotation === 90 || rotation === 270;
  return {
    ok: true,
    probe: {
      formatName: typeof data.format?.format_name === "string" ? data.format.format_name : "unknown",
      durationMs: Math.round(durationSec * 1000),
      startTimeMs: Math.round((num(data.format?.start_time) ?? 0) * 1000),
      video: {
        codec: typeof video.codec_name === "string" ? video.codec_name : "unknown",
        width,
        height,
        displayWidth: swapped ? height : width,
        displayHeight: swapped ? width : height,
        rotation,
        pixFmt: typeof video.pix_fmt === "string" ? video.pix_fmt : null,
        fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
      },
      audio: audio ? { codec: typeof audio.codec_name === "string" ? audio.codec_name : "unknown" } : null,
    },
  };
};

/**
 * Parses `ffprobe -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0`
 * into keyframe times in ms relative to the container start (same basis as `-ss`).
 */
export const parseKeyframePackets = (csv: string, startTimeMs: number): number[] => {
  const keyframes = new Set<number>();
  for (const line of csv.split(/\r?\n/)) {
    const [ptsRaw, flags] = line.trim().split(",");
    if (!ptsRaw || !flags || !flags.includes("K")) continue;
    const pts = Number(ptsRaw);
    if (!Number.isFinite(pts)) continue;
    // ceil (with float epsilon) so `-ss` never lands just before the keyframe and snaps to the previous GOP.
    const relative = Math.ceil(pts * 1000 - startTimeMs - 1e-6);
    if (relative >= 0) keyframes.add(relative);
  }
  return [...keyframes].sort((a, b) => a - b);
};

export type RangeCheck = { ok: true; availableDurationMs: number } | { ok: false; message: string };

/** The requested range must start inside the source; running past the end is tolerated only within `toleranceMs`. */
export const checkRange = (sourceDurationMs: number, startMs: number, durationMs: number, toleranceMs: number): RangeCheck => {
  if (startMs >= sourceDurationMs) {
    return { ok: false, message: `startMs ${startMs} is beyond source duration ${sourceDurationMs}ms` };
  }
  const overflow = startMs + durationMs - sourceDurationMs;
  if (overflow > toleranceMs) {
    return { ok: false, message: `range ${startMs}+${durationMs}ms exceeds source duration ${sourceDurationMs}ms by ${overflow}ms (tolerance ${toleranceMs}ms)` };
  }
  return { ok: true, availableDurationMs: Math.min(durationMs, sourceDurationMs - startMs) };
};

/** Audio codecs that can be stream-copied into MP4 without surprises. */
const MP4_COPY_AUDIO_CODECS = new Set(["aac", "mp3"]);
const COPY_PIX_FMTS = new Set(["yuv420p", "yuvj420p"]);

/** Static (range-independent) reasons a source cannot be stream-copied to the target. Empty => codec/size eligible. */
export const copyIneligibilityReasons = (probe: ProbeInfo, target: ClipTarget, stripAudio: boolean): string[] => {
  const reasons: string[] = [];
  if (probe.video.codec !== target.videoCodec) reasons.push(`video_codec_${probe.video.codec}`);
  const shortEdge = Math.min(probe.video.displayWidth, probe.video.displayHeight);
  const longEdge = Math.max(probe.video.displayWidth, probe.video.displayHeight);
  if (shortEdge > Math.min(target.width, target.height) || longEdge > Math.max(target.width, target.height)) {
    reasons.push("resolution_above_1080p");
  }
  if (probe.video.pixFmt !== null && !COPY_PIX_FMTS.has(probe.video.pixFmt)) reasons.push(`pix_fmt_${probe.video.pixFmt}`);
  if (!stripAudio && probe.audio && !MP4_COPY_AUDIO_CODECS.has(probe.audio.codec)) reasons.push(`audio_codec_${probe.audio.codec}`);
  return reasons;
};

export type ClipPlan = {
  mode: ClipPrepareMode;
  reencodeReasons: string[];
  cutStartMs: number;
  cutDurationMs: number;
  /** actual - requested */
  startDriftMs: number;
  durationDriftMs: number;
};

/**
 * Hybrid decision. Stream copy can only start on a keyframe, so pick the keyframe
 * nearest the requested start; copy only when the source is already <=1080p H.264
 * AND both |start drift| and |duration drift| are within `toleranceMs`. Otherwise
 * re-encode with an accurate seek (drift 0 except for clamping at source end).
 */
export const planClip = (input: {
  probe: ProbeInfo;
  keyframesMs: readonly number[] | null;
  startMs: number;
  durationMs: number;
  stripAudio: boolean;
  target: ClipTarget;
  toleranceMs: number;
}): ClipPlan => {
  const { probe, startMs, durationMs, toleranceMs } = input;
  const reencode = (reasons: string[]): ClipPlan => {
    const cutDurationMs = Math.min(durationMs, probe.durationMs - startMs);
    return { mode: "reencode", reencodeReasons: reasons, cutStartMs: startMs, cutDurationMs, startDriftMs: 0, durationDriftMs: cutDurationMs - durationMs };
  };
  const staticReasons = copyIneligibilityReasons(probe, input.target, input.stripAudio);
  if (staticReasons.length > 0) return reencode(staticReasons);
  const keyframes = input.keyframesMs ?? [];
  if (keyframes.length === 0) return reencode(["no_keyframe_index"]);
  let before: number | null = null;
  let after: number | null = null;
  for (const keyframe of keyframes) {
    if (keyframe <= startMs) before = keyframe;
    else if (keyframe < probe.durationMs) {
      after = keyframe;
      break;
    }
  }
  const candidates = [before, after].filter((value): value is number => value !== null);
  if (candidates.length === 0) return reencode(["no_keyframe_near_start"]);
  // nearest keyframe; ties go to the earlier one (never skip requested content)
  const cutStartMs = candidates.reduce((best, value) => (Math.abs(value - startMs) < Math.abs(best - startMs) ? value : best));
  const cutDurationMs = Math.min(durationMs, probe.durationMs - cutStartMs);
  const startDriftMs = cutStartMs - startMs;
  const durationDriftMs = cutDurationMs - durationMs;
  const reasons: string[] = [];
  if (Math.abs(startDriftMs) > toleranceMs) reasons.push("keyframe_start_drift_exceeds_tolerance");
  if (Math.abs(durationDriftMs) > toleranceMs) reasons.push("duration_drift_exceeds_tolerance");
  if (reasons.length > 0) return reencode(reasons);
  return { mode: "copy", reencodeReasons: [], cutStartMs, cutDurationMs, startDriftMs, durationDriftMs };
};

/** Seconds with ms precision for FFmpeg time arguments. */
export const toSeconds = (ms: number): string => (ms / 1000).toFixed(3);

/** Window (seconds) passed to ffprobe `-read_intervals` so keyframe scanning stays bounded on long sources. */
export const keyframeScanWindow = (startMs: number, toleranceMs: number): { fromSec: string; toSec: string } => {
  const margin = toleranceMs + 10_000;
  return { fromSec: toSeconds(Math.max(0, startMs - margin)), toSec: toSeconds(startMs + margin) };
};

export const buildProbeArgs = (inputPath: string): string[] => [
  "-v", "error", "-hide_banner", "-print_format", "json", "-show_format", "-show_streams", inputPath,
];

export const buildKeyframeProbeArgs = (inputPath: string, startMs: number, toleranceMs: number): string[] => {
  const window = keyframeScanWindow(startMs, toleranceMs);
  return [
    "-v", "error", "-hide_banner", "-select_streams", "v:0",
    "-read_intervals", `${window.fromSec}%${window.toSec}`,
    "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", inputPath,
  ];
};

const audioArgs = (stripAudio: boolean, mode: ClipPrepareMode): string[] => {
  if (stripAudio) return ["-an"];
  return mode === "copy" ? ["-map", "0:a:0?"] : ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2"];
};

const commonHead = (cutStartMs: number, inputPath: string, cutDurationMs: number): string[] => [
  "-hide_banner", "-nostdin", "-v", "error", "-y",
  "-ss", toSeconds(cutStartMs), "-i", inputPath, "-t", toSeconds(cutDurationMs),
  "-map", "0:v:0",
];

const commonTail = (outputPath: string): string[] => ["-sn", "-dn", "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4", outputPath];

/** Encode profile constants (bump CLIP_PREPARE_PROFILE_VERSION when changed). */
export const REENCODE_PROFILE = { preset: "veryfast", crf: 23, maxrate: "4M", bufsize: "8M", maxFps: 30 } as const;

export const buildCopyArgs = (plan: ClipPlan, inputPath: string, outputPath: string, stripAudio: boolean): string[] => [
  ...commonHead(plan.cutStartMs, inputPath, plan.cutDurationMs),
  ...audioArgs(stripAudio, "copy"),
  "-c", "copy",
  "-avoid_negative_ts", "make_zero",
  ...commonTail(outputPath),
];

export const buildReencodeFilter = (target: ClipTarget, sourceFps: number | null): string => {
  const parts = [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`,
    `crop=${target.width}:${target.height}`,
    "setsar=1",
  ];
  if (sourceFps !== null && sourceFps > REENCODE_PROFILE.maxFps + 0.5) parts.push(`fps=${REENCODE_PROFILE.maxFps}`);
  return parts.join(",");
};

export const buildReencodeArgs = (
  plan: ClipPlan,
  inputPath: string,
  outputPath: string,
  stripAudio: boolean,
  target: ClipTarget,
  sourceFps: number | null,
): string[] => [
  ...commonHead(plan.cutStartMs, inputPath, plan.cutDurationMs),
  ...audioArgs(stripAudio, "reencode"),
  "-vf", buildReencodeFilter(target, sourceFps),
  "-c:v", "libx264", "-preset", REENCODE_PROFILE.preset, "-crf", String(REENCODE_PROFILE.crf),
  "-maxrate", REENCODE_PROFILE.maxrate, "-bufsize", REENCODE_PROFILE.bufsize,
  "-pix_fmt", "yuv420p", "-profile:v", "high",
  ...commonTail(outputPath),
];
