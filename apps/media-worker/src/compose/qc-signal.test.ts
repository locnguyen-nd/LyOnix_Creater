import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess } from "../process.js";
import { evaluateStructure, parseProbedOutput, type ProbedOutput } from "./qc.js";
import { evaluateSignal, parseBlackdetect, parseEbur128Summary, parseFreezedetect, runFullQc, type FullQcContext } from "./qc-signal.js";
import { detectFfmpeg, ffmpegPath, ffprobePath, generate } from "./test-fixtures.js";

const SUMMARY = `
[Parsed_ebur128_0 @ 0x55] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.3 LUFS

  Loudness range:
    LRA:         2.1 LU

  True peak:
    Peak:       -1.6 dBFS
`;

describe("signal parsers", () => {
  it("reads integrated loudness and true peak from the ebur128 summary (incl. silence)", () => {
    expect(parseEbur128Summary(SUMMARY)).toEqual({ integratedLufs: -14.2, truePeakDbtp: -1.6 });
    expect(parseEbur128Summary(SUMMARY.replace("-14.2", "-inf"))?.integratedLufs).toBe(Number.NEGATIVE_INFINITY);
    expect(parseEbur128Summary("nothing")).toBeNull();
  });
  it("collects black and freeze durations", () => {
    const text = "[blackdetect @ 0x1] black_start:1 black_end:2.5 black_duration:1.5\n[blackdetect @ 0x1] black_start:5 black_end:5.3 black_duration:0.3";
    expect(parseBlackdetect(text)).toEqual([1.5, 0.3]);
    expect(parseFreezedetect("[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 2.25\nlavfi.freezedetect.freeze_start: 1")).toEqual([2.25]);
    expect(parseBlackdetect("")).toEqual([]);
    // a freeze that runs to the end of the video only gets a start line: it counts until the end
    expect(parseFreezedetect("lavfi.freezedetect.freeze_start: 1.5", 4)).toEqual([2.5]);
    expect(parseFreezedetect("freeze_start: 0.5\nfreeze_duration: 1.2\nfreeze_end: 1.7\nfreeze_start: 3", 4)).toEqual([1.2, 1]);
    expect(parseFreezedetect("lavfi.freezedetect.freeze_start: 1.5")).toEqual([]); // unknown length: cannot count it
  });
});

describe("evaluateSignal", () => {
  const good = { integratedLufs: -14.3, truePeakDbtp: -1.4, blackSegmentsSec: [], freezeSegmentsSec: [] };
  const failing = (signal: Parameters<typeof evaluateSignal>[0], freezeCheck = true) => evaluateSignal(signal, -14, freezeCheck).filter((c) => !c.ok).map((c) => c.code);
  it("passes a compliant signal and fails each defect with its own code", () => {
    expect(failing(good)).toEqual([]);
    expect(failing({ ...good, integratedLufs: -16.5 })).toEqual(["QC_LOUDNESS"]);
    expect(failing({ ...good, integratedLufs: -12.9 })).toEqual(["QC_LOUDNESS"]);
    expect(failing({ ...good, integratedLufs: -14.99 })).toEqual([]); // within ±1 LU
    expect(failing({ ...good, truePeakDbtp: -0.5 })).toEqual(["QC_TRUE_PEAK"]);
    expect(failing({ ...good, truePeakDbtp: -1 })).toEqual([]);
    expect(failing({ ...good, blackSegmentsSec: [0.4] })).toEqual(["QC_BLACK_FRAMES"]);
    expect(failing({ ...good, freezeSegmentsSec: [1.2] })).toEqual(["QC_FREEZE"]);
    expect(failing({ ...good, integratedLufs: Number.NEGATIVE_INFINITY })).toEqual(["QC_LOUDNESS"]);
    expect(failing({ ...good, integratedLufs: null, truePeakDbtp: null })).toEqual(["QC_LOUDNESS", "QC_TRUE_PEAK"]);
  });
  it("skips the freeze check only when the picture is static by design", () => {
    expect(failing({ ...good, freezeSegmentsSec: [3] }, false)).toEqual([]);
  });
});

describe("evaluateStructure", () => {
  const probe = (over: Partial<NonNullable<ProbedOutput["video"]>> = {}, audio: ProbedOutput["audio"] = { codec: "aac", sampleRate: 48000, channels: 2, durationMs: 4000 }): ProbedOutput => ({
    video: { codec: "h264", profile: "High", pixFmt: "yuv420p", width: 1080, height: 1920, rFrameRate: "60/1", avgFrameRate: "60/1", nbFrames: 240, durationMs: 4000, colorRange: "tv", colorSpace: "bt709", ...over },
    audio,
    formatDurationMs: 4000,
  });
  const failing = (p: ProbedOutput, ms = 4000, frames = 240) => evaluateStructure(p, ms, frames).filter((c) => !c.ok).map((c) => c.code);
  it("accepts the standard and rejects each deviation with its code", () => {
    expect(failing(probe())).toEqual([]);
    expect(failing(probe({ width: 720, height: 1280 }))).toEqual(["QC_RESOLUTION"]);
    expect(failing(probe({ rFrameRate: "30/1", avgFrameRate: "30/1" }))).toEqual(["QC_FPS"]);
    expect(failing(probe({ avgFrameRate: "59/1" }))).toEqual(["QC_FPS"]); // variable frame rate
    expect(failing(probe({ nbFrames: 239 }))).toEqual(["QC_FPS"]); // dropped frame
    expect(failing(probe({ profile: "Constrained Baseline" }))).toEqual(["QC_CODEC"]);
    expect(failing(probe({ pixFmt: "yuv444p" }))).toEqual(["QC_CODEC"]);
    expect(failing(probe(), 4150)).toEqual(["QC_DURATION"]);
    expect(failing(probe(), 4090)).toEqual([]); // within 100 ms
    expect(failing(probe({}, { codec: "aac", sampleRate: 44100, channels: 2, durationMs: 4000 }))).toEqual(["QC_AUDIO"]);
    expect(failing(probe({}, { codec: "aac", sampleRate: 48000, channels: 1, durationMs: 4000 }))).toEqual(["QC_AUDIO"]);
    expect(failing(probe({}, null))).toEqual(["QC_AUDIO"]);
  });
  it("parses ffprobe JSON and rejects garbage", () => {
    expect(parseProbedOutput("not json")).toBeNull();
    const parsed = parseProbedOutput(JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, duration: "4.0", r_frame_rate: "60/1" }], format: { duration: "4.0" } }));
    expect(parsed?.video?.width).toBe(1080);
    expect(parsed?.audio).toBeNull();
  });
});

/** Deliberately defective videos, produced with lavfi, must be stopped with exactly the right code (real ffmpeg/ffprobe). */
const availability = detectFfmpeg();
describe.skipIf(!availability.ok)("runFullQc on deliberately defective videos (real FFmpeg)", () => {
  let dir: string;
  let ctxFor: (file: string, over?: Partial<FullQcContext>) => FullQcContext;
  const SECONDS = 4;
  const FRAMES = SECONDS * 60;
  /** Measured once: the gain (dB) that brings the sine fixture to exactly -14 LUFS, so "compliant" does not rest on a hand-computed constant. */
  let calibrationDb = 0;

  const measureLufs = (file: string): number => {
    const r = spawnSync(ffmpegPath, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], { encoding: "utf8" });
    return parseEbur128Summary(r.stderr)!.integratedLufs!;
  };

  /** The lavfi sine source peaks at 0.125, so 1.728x gives A=0.216: stereo 1 kHz at -14 LUFS (peak -13.3 dBFS). Writes a 1080x1920 60 fps H.264 High + AAC mp4 of SECONDS s; `video`/`audio` are lavfi filter chains, `gainDb` shifts the audio. */
  const make = (name: string, opts: { videoFilter?: string; size?: string; fps?: number; channels?: number; sampleRate?: number; gainDb?: number; amp?: number } = {}): string => {
    const file = join(dir, `${name}.mp4`);
    const size = opts.size ?? "1080x1920";
    const fps = opts.fps ?? 60;
    const vf = opts.videoFilter ? `,${opts.videoFilter}` : "";
    generate([
      "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${fps}:duration=${SECONDS}`,
      "-f", "lavfi", "-i", `sine=frequency=1000:sample_rate=${opts.sampleRate ?? 48000}:duration=${SECONDS}`,
      "-filter_complex", `[0:v]format=yuv420p${vf}[v];[1:a]aformat=channel_layouts=${opts.channels === 1 ? "mono" : "stereo"},volume=${opts.amp ?? 1.728 * 10 ** (((opts.gainDb ?? 0) + calibrationDb) / 20)}[a]`,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high", "-x264-params", "cabac=1:8x8dct=1", "-pix_fmt", "yuv420p", "-r", String(fps), "-fps_mode", "cfr",
      "-c:a", "aac", "-b:a", "192k", "-ar", String(opts.sampleRate ?? 48000), "-movflags", "+faststart", file,
    ]);
    return file;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lyonix-qc-"));
    const probeFile = make("calibration");
    calibrationDb = -14 - measureLufs(probeFile);
    ctxFor = (file, over = {}) => ({ videoPath: file, expectedFrames: FRAMES, expectedDurationMs: SECONDS * 1000, targetLufs: -14, freezeCheck: true, runner: runProcess, ffmpegPath, ffprobePath, timeoutMs: 120_000, ...over });
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const failedCodes = async (file: string, over?: Partial<FullQcContext>) => (await runFullQc(ctxFor(file, over))).checks.filter((c) => !c.ok).map((c) => c.code);

  it("passes a compliant video and reports the measurements", async () => {
    const file = make("good");
    const lufs = measureLufs(file);
    expect(Math.abs(lufs + 14)).toBeLessThan(1); // the fixture itself is calibrated to -14 LUFS
    const report = await runFullQc(ctxFor(file));
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.measured).toMatchObject({ width: 1080, height: 1920, fps: 60, videoCodec: "h264", profile: "High", pixFmt: "yuv420p", audioCodec: "aac", sampleRate: 48000, channels: 2, blackMs: 0, freezeMs: 0 });
    expect(Math.abs(report.measured.integratedLufs! + 14)).toBeLessThan(1);
    expect(report.measured.truePeakDbtp!).toBeLessThanOrEqual(-1);
  }, 120_000);

  it("blocks bad loudness, a hot peak, wrong duration, wrong size/fps/format with the matching code", async () => {
    expect(await failedCodes(make("quiet", { gainDb: -9 }))).toEqual(["QC_LOUDNESS"]);
    expect(await failedCodes(make("loud", { gainDb: 16 }))).toEqual(expect.arrayContaining(["QC_LOUDNESS", "QC_TRUE_PEAK"]));
    expect(await failedCodes(make("good2"), { expectedDurationMs: 6000 })).toEqual(["QC_DURATION"]);
    expect(await failedCodes(make("small", { size: "720x1280", videoFilter: "scale=720:1280" }))).toEqual(["QC_RESOLUTION"]);
    expect(await failedCodes(make("fps30", { fps: 30 }))).toEqual(["QC_FPS"]);
    expect(await failedCodes(make("mono", { channels: 1 }))).toEqual(["QC_AUDIO"]);
    expect(await failedCodes(make("rate44", { sampleRate: 44100 }))).toEqual(["QC_AUDIO"]);
  }, 300_000);

  it("blocks an unintended black stretch (> 0.2 s) and a frozen picture (>= 1 s)", async () => {
    const black = make("black", { videoFilter: "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,1,1.6)'" });
    expect(await failedCodes(black)).toEqual(["QC_BLACK_FRAMES"]);
    const shortBlack = make("blink", { videoFilter: "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,1,1.1)'" });
    expect(await failedCodes(shortBlack)).toEqual([]); // 0.1 s is below the 0.2 s threshold
    const blackTail = make("blacktail", { videoFilter: "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(t,3)'" });
    expect(await failedCodes(blackTail)).toEqual(["QC_BLACK_FRAMES"]); // a black ending is caught too
    const frozen = make("frozen", { videoFilter: "trim=duration=1.5,tpad=stop_mode=clone:stop_duration=2.5" });
    expect(await failedCodes(frozen)).toEqual(["QC_FREEZE"]);
    expect(await failedCodes(frozen, { freezeCheck: false })).toEqual([]); // static by design
    const report = await runFullQc(ctxFor(frozen));
    expect(report.measured.freezeMs!).toBeGreaterThanOrEqual(1000);
    expect(report.checks.find((c) => c.code === "QC_FREEZE")!.measured).toBeGreaterThanOrEqual(1000);
  }, 300_000);
});
