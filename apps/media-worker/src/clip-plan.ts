import type { ClipPrepareMode, ClipTarget, ReframeCropPlan } from "@lyonix/media-jobs";

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
    /** `r_frame_rate` (the lowest rate that represents every timestamp); differs from `fps` (average) for variable-frame-rate sources. */
    rFps?: number | null;
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
        rFps: parseRate(video.r_frame_rate),
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

/** Average and nominal frame rates further apart than this are a variable-frame-rate source (typical of phone/TikTok clips). */
const VFR_TOLERANCE = 0.03;

/** True when the source's frame timestamps are not evenly spaced: stream copy would carry the unevenness into the clip (visible stutter). */
export const isVariableFrameRate = (video: Pick<ProbeInfo["video"], "fps" | "rFps">): boolean =>
  video.fps !== null && video.fps !== undefined && video.rFps !== null && video.rFps !== undefined && Math.abs(video.fps - video.rFps) / Math.max(video.fps, video.rFps) > VFR_TOLERANCE;

/** Static (range-independent) reasons a source cannot be stream-copied to the target. Empty => codec/size eligible. */
export const copyIneligibilityReasons = (probe: ProbeInfo, target: ClipTarget, stripAudio: boolean): string[] => {
  const reasons: string[] = [];
  if (probe.video.codec !== target.videoCodec) reasons.push(`video_codec_${probe.video.codec}`);
  const shortEdge = Math.min(probe.video.displayWidth, probe.video.displayHeight);
  const longEdge = Math.max(probe.video.displayWidth, probe.video.displayHeight);
  if (shortEdge > Math.min(target.width, target.height) || longEdge > Math.max(target.width, target.height)) {
    reasons.push("resolution_above_1080p");
  }
  if (isVariableFrameRate(probe.video)) reasons.push("variable_frame_rate");
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
  /** VE2E-67: a plan that removes pixels (not the whole frame) can never be stream-copied. */
  cropPlan?: ReframeCropPlan | null;
}): ClipPlan => {
  const { probe, startMs, durationMs, toleranceMs } = input;
  const reencode = (reasons: string[]): ClipPlan => {
    const cutDurationMs = Math.min(durationMs, probe.durationMs - startMs);
    return { mode: "reencode", reencodeReasons: reasons, cutStartMs: startMs, cutDurationMs, startDriftMs: 0, durationDriftMs: cutDurationMs - durationMs };
  };
  const staticReasons = copyIneligibilityReasons(probe, input.target, input.stripAudio);
  if (input.cropPlan && !isFullFrameCropPlan(input.cropPlan)) staticReasons.unshift("crop_plan");
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

/** True when every keyframe window is the whole source frame (nothing is cut away, stream copy stays legal). */
export const isFullFrameCropPlan = (plan: ReframeCropPlan): boolean =>
  plan.keyframes.every((k) => k.xPx === 0 && k.yPx === 0 && k.widthPx === plan.sourceWidthPx && k.heightPx === plan.sourceHeightPx);

/** Rounds seconds for filter expressions (ms precision; no exponent notation). */
const sec = (ms: number): string => String(Number((ms / 1000).toFixed(3)));

/**
 * ffmpeg expression of one crop axis over time `t` (seconds, relative to the cut start): linear interpolation between keyframes,
 * clamped to the first/last keyframe outside their range. Constant axes collapse to the number.
 */
export const buildAxisExpression = (frames: ReadonlyArray<{ tMs: number }>, values: readonly number[]): string => {
  if (values.every((value) => value === values[0])) return String(values[0]);
  let expression = String(values[values.length - 1]);
  for (let index = values.length - 2; index >= 0; index -= 1) {
    const t0 = frames[index]!.tMs;
    const t1 = frames[index + 1]!.tMs;
    const v0 = values[index]!;
    const v1 = values[index + 1]!;
    const segment = v0 === v1 ? String(v0) : `${v0}+(${v1 - v0})*(t-${sec(t0)})/${sec(t1 - t0)}`;
    expression = `if(lt(t,${sec(t1)}),${segment},${expression})`;
  }
  return expression;
};

/**
 * `crop=...` (+ lanczos scale to the target) for a crop plan. Window size is constant (validated by the contract), only x/y move.
 * Expressions are single-quoted so their commas are not filtergraph separators. Returns null for a full-frame plan.
 */
export const buildCropFilterParts = (plan: ReframeCropPlan, target: ClipTarget, options: { still?: boolean } = {}): string[] | null => {
  if (isFullFrameCropPlan(plan)) return null;
  const frames = options.still ? [plan.keyframes[0]!] : plan.keyframes;
  const first = frames[0]!;
  const xs = buildAxisExpression(frames, frames.map((k) => k.xPx));
  const ys = buildAxisExpression(frames, frames.map((k) => k.yPx));
  const quote = (value: string) => (/^\d+$/.test(value) ? value : `'${value}'`);
  const parts = [`crop=w=${first.widthPx}:h=${first.heightPx}:x=${quote(xs)}:y=${quote(ys)}`];
  if (first.widthPx !== target.width || first.heightPx !== target.height) parts.push(`scale=${target.width}:${target.height}:flags=lanczos`);
  parts.push("setsar=1");
  return parts;
};

/**
 * Constant output frame rate of a re-encoded clip (VE2E-90). Every re-encode is forced to CFR so the clip never carries the source's
 * uneven timestamps; the rate is the nearest of 24/25/30 and an even decimation of 50/60 fps (50 -> 25, 60 -> 30), so frames are never
 * duplicated or dropped unevenly (the cause of judder). Unknown rate -> 30.
 */
export const normalizedFps = (sourceFps: number | null): number => {
  if (sourceFps === null || !Number.isFinite(sourceFps) || sourceFps <= 0) return REENCODE_PROFILE.maxFps;
  if (sourceFps > 45) return sourceFps < 55 ? 25 : 30;
  return ([24, 25, 30] as const).reduce((best, candidate) => (Math.abs(candidate - sourceFps) <= Math.abs(best - sourceFps) ? candidate : best));
};

export const buildReencodeFilter = (target: ClipTarget, sourceFps: number | null, cropPlan?: ReframeCropPlan | null): string => {
  const parts = (cropPlan ? buildCropFilterParts(cropPlan, target) : null) ?? [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`,
    `crop=${target.width}:${target.height}`,
    "setsar=1",
  ];
  parts.push(`fps=${normalizedFps(sourceFps)}`);
  return parts.join(",");
};

export const buildReencodeArgs = (
  plan: ClipPlan,
  inputPath: string,
  outputPath: string,
  stripAudio: boolean,
  target: ClipTarget,
  sourceFps: number | null,
  cropPlan?: ReframeCropPlan | null,
): string[] => [
  ...commonHead(plan.cutStartMs, inputPath, plan.cutDurationMs),
  ...audioArgs(stripAudio, "reencode"),
  "-vf", buildReencodeFilter(target, sourceFps, cropPlan),
  "-c:v", "libx264", "-preset", REENCODE_PROFILE.preset, "-crf", String(REENCODE_PROFILE.crf),
  "-maxrate", REENCODE_PROFILE.maxrate, "-bufsize", REENCODE_PROFILE.bufsize,
  "-pix_fmt", "yuv420p", "-profile:v", "high",
  // CFR output + a keyframe at least every 2 s (clean seeking/cuts downstream, no GOP-length surprises).
  "-fps_mode", "cfr", "-g", String(normalizedFps(sourceFps) * 2), "-sc_threshold", "0",
  ...commonTail(outputPath),
];

/** VE2E-67: one 1080x1920 JPEG from a still image (crop plan window, else centre-cover). Never writes audio/metadata. */
export const buildImageCropArgs = (inputPath: string, outputPath: string, target: ClipTarget, cropPlan?: ReframeCropPlan | null): string[] => {
  const parts = (cropPlan ? buildCropFilterParts(cropPlan, target, { still: true }) : null) ?? [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`,
    `crop=${target.width}:${target.height}`,
    "setsar=1",
  ];
  return [
    "-hide_banner", "-nostdin", "-v", "error", "-y",
    "-i", inputPath, "-map", "0:v:0", "-frames:v", "1",
    "-vf", parts.join(","),
    "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj420p",
    "-an", "-sn", "-dn", "-map_metadata", "-1",
    "-f", "image2", "-update", "1", outputPath,
  ];
};

export type Smoothness = {
  frames: number;
  /** Median spacing between presentation timestamps. */
  medianDeltaMs: number;
  maxDeltaMs: number;
  /** Share of deltas that differ from the median by more than 20% (0 for a constant frame rate). */
  irregularPct: number;
  /** Frames repeated or missing against a perfect grid at the median rate (|expected - actual|). */
  gridErrorFrames: number;
  smooth: boolean;
};

/**
 * VE2E-90 automated smoothness check: parses `ffprobe -select_streams v:0 -show_entries packet=pts_time -of csv=p=0` of a clip and
 * reports timestamp regularity. A clip is smooth when (almost) every spacing equals the median (constant frame rate) and nothing
 * stalls for more than 2.5 frames.
 */
export const measureSmoothness = (csv: string, options: { trimEdgeFrames?: number } = {}): Smoothness | null => {
  const all = csv.split(/\r?\n/).map((line) => Number(line.trim().split(",")[0])).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  // A stream copy of an H.264 stream with B-frames leaves a one-frame hole at the first/last timestamps (reorder delay). That is not
  // mid-clip judder, so the copy check ignores the outermost frames.
  const trim = Math.max(0, options.trimEdgeFrames ?? 0);
  const times = trim > 0 ? all.slice(trim, all.length - trim) : all;
  if (times.length < 3) return null;
  const deltas = times.slice(1).map((time, index) => (time - times[index]!) * 1000);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const irregular = deltas.filter((delta) => Math.abs(delta - median) > median * 0.2).length;
  const max = Math.max(...deltas);
  const spanMs = (times[times.length - 1]! - times[0]!) * 1000;
  const gridErrorFrames = Math.abs(Math.round(spanMs / median) - (times.length - 1));
  const irregularPct = Math.round((irregular / deltas.length) * 1000) / 10;
  return { frames: times.length, medianDeltaMs: Math.round(median * 100) / 100, maxDeltaMs: Math.round(max * 100) / 100, irregularPct, gridErrorFrames, smooth: irregularPct <= 2 && max <= median * 2.5 && gridErrorFrames <= 1 };
};

export const buildSmoothnessProbeArgs = (path: string): string[] => ["-v", "error", "-hide_banner", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path];

export type SmoothnessReport = Smoothness & {
  /** Largest gap between consecutive keyframes (ms); null when the packets carry no keyframe flag. */
  maxKeyframeGapMs: number | null;
  keyframes: number;
};

/** `measureSmoothness` plus the keyframe interval, from the same `buildSmoothnessProbeArgs` output (`pts_time,flags`). */
export const analyzeSmoothness = (csv: string, options: { trimEdgeFrames?: number } = {}): SmoothnessReport | null => {
  const base = measureSmoothness(csv, options);
  if (!base) return null;
  const keys = csv
    .split(/\r?\n/)
    .map((line) => line.trim().split(","))
    .filter(([pts, flags]) => pts && flags?.includes("K") && Number.isFinite(Number(pts)))
    .map(([pts]) => Number(pts) * 1000)
    .sort((a, b) => a - b);
  let maxGap: number | null = null;
  for (let i = 1; i < keys.length; i += 1) maxGap = Math.max(maxGap ?? 0, keys[i]! - keys[i - 1]!);
  return { ...base, maxKeyframeGapMs: maxGap === null ? null : Math.round(maxGap), keyframes: keys.length };
};
