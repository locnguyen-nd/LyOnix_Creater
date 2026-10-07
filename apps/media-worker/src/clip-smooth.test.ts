import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClipPrepareJob } from "@lyonix/media-jobs";
import { ClipPrepareProcessor } from "./clip-prepare.js";
import { runProcess } from "./process.js";
import { DEFAULT_CLIP_TARGET } from "@lyonix/media-jobs";
import { buildProbeArgs, buildReencodeArgs, buildSmoothnessProbeArgs, copyIneligibilityReasons, isVariableFrameRate, analyzeSmoothness, measureSmoothness, normalizedFps, parseProbeJson, type ClipPlan } from "./clip-plan.js";

describe("constant frame rate normalisation (VE2E-90)", () => {
  it.each([[60, 30], [59.94, 30], [50, 25], [30, 30], [29.97, 30], [25, 25], [24, 24], [23.976, 24], [27.5, 30], [15, 24], [null, 30]])("%s fps -> %s", (input, expected) => {
    expect(normalizedFps(input)).toBe(expected);
  });
  it("every re-encode forces CFR, with a GOP of two seconds", () => {
    const plan: ClipPlan = { mode: "reencode", reencodeReasons: [], cutStartMs: 0, cutDurationMs: 3000, startDriftMs: 0, durationDriftMs: 0 };
    const args = buildReencodeArgs(plan, "in.mp4", "out.mp4", true, DEFAULT_CLIP_TARGET, 25);
    expect(args[args.indexOf("-vf") + 1]).toMatch(/,fps=25$/);
    expect(args).toEqual(expect.arrayContaining(["-fps_mode", "cfr", "-g", "50"]));
  });
  it("a variable-frame-rate source is never stream-copied", () => {
    expect(isVariableFrameRate({ fps: 27, rFps: 30 })).toBe(true);
    expect(isVariableFrameRate({ fps: 30, rFps: 30 })).toBe(false);
    const probe = { formatName: "mp4", durationMs: 9000, startTimeMs: 0, video: { codec: "h264", width: 720, height: 1280, displayWidth: 720, displayHeight: 1280, rotation: 0, pixFmt: "yuv420p", fps: 24.2, rFps: 30 }, audio: null };
    expect(copyIneligibilityReasons(probe, DEFAULT_CLIP_TARGET, true)).toContain("variable_frame_rate");
  });
});

describe("measureSmoothness", () => {
  const csv = (times: number[]) => times.map((t) => `${t.toFixed(4)},`).join("\n");
  it("accepts an evenly spaced clip", () => {
    const result = measureSmoothness(csv(Array.from({ length: 60 }, (_, i) => i / 30)))!;
    expect(result).toMatchObject({ smooth: true, irregularPct: 0, gridErrorFrames: 0 });
  });
  it("flags a stall and uneven spacing", () => {
    const times = Array.from({ length: 60 }, (_, i) => i / 30);
    const stalled = times.map((t, i) => (i >= 30 ? t + 0.2 : t));
    expect(measureSmoothness(csv(stalled))!.smooth).toBe(false);
    const jittery = times.map((t, i) => t + (i % 2 ? 0.012 : 0));
    expect(measureSmoothness(csv(jittery))!.smooth).toBe(false);
  });
  it("returns null with too few frames", () => {
    expect(measureSmoothness("0.0,\n0.03,")).toBeNull();
  });
});

const ffmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]);
const hasFfmpeg = !ffmpeg.error && ffmpeg.status === 0 && spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout.includes("libx264");

describe.skipIf(!hasFfmpeg)("real FFmpeg: a variable-frame-rate source becomes smooth CFR", () => {
  it("re-encode output has constant timestamps while the VFR source does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyx-smooth-"));
    try {
      const source = join(dir, "vfr.mp4");
      const out = join(dir, "out.mp4");
      // 4 s clip made of 2 s @30 fps + 2 s @24 fps joined without re-encoding: its frame spacing changes mid-stream, like a phone/TikTok VFR clip.
      const part = (name: string, rate: number) => {
        const target = join(dir, name);
        const made = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=360x640:rate=${rate}:duration=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", target]);
        expect(made.status, String(made.stderr)).toBe(0);
        return target;
      };
      const list = join(dir, "list.txt");
      const asConcatPath = (file: string) => file.split(sep).join("/");
      writeFileSync(list, ["file '" + asConcatPath(part("a.mp4", 30)) + "'", "file '" + asConcatPath(part("b.mp4", 24)) + "'", ""].join(String.fromCharCode(10)));
      const joined = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", source]);
      expect(joined.status, String(joined.stderr)).toBe(0);
      const smooth = (path: string) => measureSmoothness(spawnSync("ffprobe", buildSmoothnessProbeArgs(path), { encoding: "utf8" }).stdout)!;
      expect(smooth(source).smooth).toBe(false);
      const probe = parseProbeJson(spawnSync("ffprobe", buildProbeArgs(source), { encoding: "utf8" }).stdout);
      expect(probe.ok).toBe(true);
      const sourceFps = probe.ok ? probe.probe.video.fps : null;
      const plan: ClipPlan = { mode: "reencode", reencodeReasons: ["test"], cutStartMs: 0, cutDurationMs: 3500, startDriftMs: 0, durationDriftMs: 0 };
      const run = spawnSync("ffmpeg", buildReencodeArgs(plan, source, out, true, DEFAULT_CLIP_TARGET, sourceFps), { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      const result = smooth(out);
      expect(result.smooth, JSON.stringify(result)).toBe(true);
      expect(result.maxDeltaMs).toBeLessThanOrEqual(result.medianDeltaMs * 1.05);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("analyzeSmoothness / edge trimming (VE2E-90)", () => {
  const rows = (times: number[], keyEvery: number) => times.map((t, i) => `${t.toFixed(4)},${i % keyEvery === 0 ? "K__" : "___"}`).join("\n");
  const even = Array.from({ length: 90 }, (_, i) => i / 30);
  it("reports the largest keyframe gap", () => {
    expect(analyzeSmoothness(rows(even, 30))).toMatchObject({ smooth: true, maxKeyframeGapMs: 1000, keyframes: 3 });
    expect(analyzeSmoothness(rows(even, 1000))!.maxKeyframeGapMs).toBeNull();
  });
  it("ignores the reorder hole a stream copy leaves at its ends only when asked", () => {
    const withHole = [0.05, ...even.slice(5, 85), 2.8 + 0.2];
    expect(measureSmoothness(rows(withHole, 30))!.smooth).toBe(false);
    expect(measureSmoothness(rows(withHole, 30), { trimEdgeFrames: 2 })!.smooth).toBe(true);
  });
  it("still flags mid-clip stalls after trimming", () => {
    const stalled = even.map((t, i) => (i >= 45 ? t + 0.2 : t));
    expect(measureSmoothness(rows(stalled, 30), { trimEdgeFrames: 2 })!.smooth).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)("real FFmpeg: clip.prepare end to end (VE2E-90)", () => {
  const run = async (makeSource: (dir: string, target: string) => void, name: string) => {
    const root = mkdtempSync(join(tmpdir(), "lyx-e2e90-"));
    try {
      mkdirSync(join(root, "a"), { recursive: true });
      makeSource(root, join(root, "a", name));
      const processor = new ClipPrepareProcessor({ config: { mediaRoot: root, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", copyToleranceMs: 1000, jobTimeoutMs: 120_000, maxAttempts: 1 }, runner: runProcess, ffmpegVersion: "t" });
      const result = await processor.handle(buildClipPrepareJob({ jobKey: "e2e:" + name, source: { relativePath: "a/" + name }, startMs: 2370, durationMs: 3000, stripAudio: true }));
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const interior = measureSmoothness(spawnSync("ffprobe", buildSmoothnessProbeArgs(join(root, result.output.relativePath)), { encoding: "utf8" }).stdout, { trimEdgeFrames: 2 })!;
      return { result, interior };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const enc = (rate: number, g: number) => (_dir: string, target: string) => {
    const made = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=720x1280:rate=${rate}:duration=8`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", String(g), "-sc_threshold", "0", target]);
    expect(made.status, String(made.stderr)).toBe(0);
  };
  it("a 60 fps source already within the target is stream-copied (no re-encode) and is smooth", async () => {
    const { result, interior } = await run(enc(60, 60), "cfr60.mp4");
    expect(result.mode).toBe("copy");
    expect(interior.smooth, JSON.stringify(interior)).toBe(true);
  }, 90_000);
  it("a long-GOP source is re-encoded at an accurate start with CFR and a 2 s keyframe interval", async () => {
    const { result, interior } = await run(enc(30, 240), "longgop.mp4");
    expect(result.mode).toBe("reencode");
    expect(interior.smooth, JSON.stringify(interior)).toBe(true);
  }, 90_000);
});
