import type { ComposeQcCheck, ComposeQcReport } from "@lyonix/media-jobs";
import { ComposeJobError } from "./errors.js";
import type { ProcessRunner } from "../process.js";
import { evaluateStructure, measurementsFromProbe, probeOutput, reportFromChecks, type ProbedOutput } from "./qc.js";

/**
 * VE2E-106: signal-level QC of a finished render (decodes the file): integrated loudness + true peak (EBU R128 `ebur128`), black frames
 * (`blackdetect`), frozen picture (`freezedetect`). Combined with the structural checks of `qc.ts` this is the full acceptance gate of
 * docs/plans/self-render-engine.md §3; a video only becomes `completed` when every check passes.
 */

export const QC_SIGNAL = {
  /** Integrated loudness must be within this many LU of the recipe target. */
  loudnessToleranceLu: 1,
  /** True peak ceiling (dBTP). */
  truePeakMaxDb: -1,
  /** Black segments at least this long (s) are a defect. */
  blackMinSec: 0.2,
  /** Pixel luma threshold (0..1) under which a pixel counts as black. */
  blackPixTh: 0.1,
  /** Frozen picture at least this long (s) is a defect. */
  freezeMinSec: 1,
  /** `freezedetect` noise tolerance. Slow zooms on smooth photos change a frame by only a few grey levels, so this is deliberately sensitive. */
  freezeNoiseDb: -55,
  /** Detectors run on a downscaled copy (the defects are large-area); keeps a 70 s check to a few seconds. */
  detectWidth: 360,
  detectHeight: 640,
} as const;

const num = (text: string | undefined): number | null => {
  if (text === undefined) return null;
  if (/^-?inf$/i.test(text)) return Number.NEGATIVE_INFINITY;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** Reads `I:` (LUFS) and `Peak:` (dBFS true peak) from the `ebur128=peak=true` summary FFmpeg prints at the end of a run. */
export function parseEbur128Summary(stderr: string): { integratedLufs: number | null; truePeakDbtp: number | null } | null {
  const integrated = /Integrated loudness:\s*\n\s*I:\s+(-?inf|-?[\d.]+)\s+LUFS/i.exec(stderr);
  const peaks = [...stderr.matchAll(/True peak:\s*\n\s*Peak:\s+(-?inf|-?[\d.]+)\s+dBFS/gi)];
  if (!integrated && peaks.length === 0) return null;
  return { integratedLufs: num(integrated?.[1]), truePeakDbtp: num(peaks.at(-1)?.[1]) };
}

/** Durations (s) of every `black_duration` FFmpeg reported. */
export const parseBlackdetect = (stderr: string): number[] => [...stderr.matchAll(/black_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]));

/**
 * Durations (s) of every frozen stretch. FFmpeg prints `freeze_start`, then `freeze_duration`/`freeze_end` when the picture moves again; a
 * freeze that lasts to the END of the video (e.g. a held last frame) only ever gets its `freeze_start`, so an unclosed start counts as
 * frozen until `videoDurationSec`.
 */
export function parseFreezedetect(stderr: string, videoDurationSec: number | null = null): number[] {
  const durations: number[] = [];
  let openStart: number | null = null;
  for (const match of stderr.matchAll(/freeze_(start|duration):\s*([\d.]+)/g)) {
    const value = Number(match[2]);
    if (match[1] === "start") openStart = value;
    else {
      durations.push(value);
      openStart = null;
    }
  }
  if (openStart !== null && videoDurationSec !== null && videoDurationSec > openStart) durations.push(videoDurationSec - openStart);
  return durations;
}

export type FullQcContext = {
  videoPath: string;
  expectedFrames: number;
  expectedDurationMs: number;
  /** Loudness target of the recipe (LUFS). */
  targetLufs: number;
  /** false when the picture is static by design (still images with the animation switched off): a frozen stretch is then intended. */
  freezeCheck: boolean;
  runner: ProcessRunner;
  ffmpegPath: string;
  ffprobePath: string;
  timeoutMs: number;
};

const check = (code: ComposeQcCheck["code"], ok: boolean, measured: ComposeQcCheck["measured"], expected: ComposeQcCheck["expected"], message: string): ComposeQcCheck => ({ code, ok, measured, expected, message });

export function evaluateSignal(
  signal: { integratedLufs: number | null; truePeakDbtp: number | null; blackSegmentsSec: number[]; freezeSegmentsSec: number[] },
  targetLufs: number,
  freezeCheck: boolean,
): ComposeQcCheck[] {
  const { integratedLufs, truePeakDbtp } = signal;
  const loudnessOk = integratedLufs !== null && Number.isFinite(integratedLufs) && Math.abs(integratedLufs - targetLufs) <= QC_SIGNAL.loudnessToleranceLu;
  const peakOk = truePeakDbtp !== null && truePeakDbtp <= QC_SIGNAL.truePeakMaxDb;
  const black = signal.blackSegmentsSec.reduce((sum, s) => sum + s, 0);
  const freeze = Math.max(0, ...signal.freezeSegmentsSec);
  return [
    check("QC_LOUDNESS", loudnessOk, integratedLufs, `${targetLufs} ±${QC_SIGNAL.loudnessToleranceLu} LUFS`, "integrated loudness must be within ±1 LU of the target"),
    check("QC_TRUE_PEAK", peakOk, truePeakDbtp, `<= ${QC_SIGNAL.truePeakMaxDb} dBTP`, "true peak must not exceed -1 dBTP"),
    check("QC_BLACK_FRAMES", signal.blackSegmentsSec.length === 0, Math.round(black * 1000), `no black segment >= ${QC_SIGNAL.blackMinSec * 1000} ms`, `no unintended black picture longer than ${QC_SIGNAL.blackMinSec * 1000} ms`),
    check("QC_FREEZE", !freezeCheck || signal.freezeSegmentsSec.length === 0, freezeCheck ? Math.round(freeze * 1000) : "skipped (static by design)", `no frozen stretch >= ${QC_SIGNAL.freezeMinSec * 1000} ms`, "the picture must not stand still for a second or more"),
  ];
}

const runDetector = async (ctx: FullQcContext, args: string[]): Promise<string> => {
  const result = await ctx.runner(ctx.ffmpegPath, ["-hide_banner", "-nostdin", "-nostats", "-v", "info", ...args], { timeoutMs: ctx.timeoutMs });
  if (result.exitCode !== 0) throw new ComposeJobError("OUTPUT_INVALID", `QC decode failed: ${result.stderrTail.slice(-300)}`);
  return result.stderrTail;
};

/** The full gate: structural checks + loudness / true peak + black + freeze. Throws OUTPUT_INVALID only when the file cannot be decoded at all. */
export async function runFullQc(ctx: FullQcContext): Promise<ComposeQcReport> {
  const probe: ProbedOutput = await probeOutput(ctx.runner, ctx.ffprobePath, ctx.videoPath, ctx.timeoutMs);
  const checks = evaluateStructure(probe, ctx.expectedDurationMs, ctx.expectedFrames);
  const measured = measurementsFromProbe(probe);

  let integratedLufs: number | null = null;
  let truePeakDbtp: number | null = null;
  if (probe.audio) {
    const stderr = await runDetector(ctx, ["-i", ctx.videoPath, "-vn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
    const summary = parseEbur128Summary(stderr);
    integratedLufs = summary?.integratedLufs ?? null;
    truePeakDbtp = summary?.truePeakDbtp ?? null;
  }
  const videoStderr = await runDetector(ctx, [
    "-i", ctx.videoPath, "-an",
    "-vf", `scale=${QC_SIGNAL.detectWidth}:${QC_SIGNAL.detectHeight}:flags=fast_bilinear,blackdetect=d=${QC_SIGNAL.blackMinSec}:pix_th=${QC_SIGNAL.blackPixTh},freezedetect=n=${QC_SIGNAL.freezeNoiseDb}dB:d=${QC_SIGNAL.freezeMinSec}`,
    "-f", "null", "-",
  ]);
  const blackSegmentsSec = parseBlackdetect(videoStderr);
  const freezeSegmentsSec = parseFreezedetect(videoStderr, (probe.video?.durationMs ?? probe.formatDurationMs ?? 0) / 1000 || null);

  checks.push(...evaluateSignal({ integratedLufs, truePeakDbtp, blackSegmentsSec, freezeSegmentsSec }, ctx.targetLufs, ctx.freezeCheck));
  return reportFromChecks(checks, {
    ...measured,
    integratedLufs: integratedLufs !== null && Number.isFinite(integratedLufs) ? Math.round(integratedLufs * 10) / 10 : null,
    truePeakDbtp: truePeakDbtp !== null && Number.isFinite(truePeakDbtp) ? Math.round(truePeakDbtp * 10) / 10 : null,
    blackMs: Math.round(blackSegmentsSec.reduce((sum, s) => sum + s, 0) * 1000),
    freezeMs: freezeSegmentsSec.length ? Math.round(Math.max(...freezeSegmentsSec) * 1000) : 0,
  });
}
