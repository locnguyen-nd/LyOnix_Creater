import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectFfmpeg, generate } from "../compose/test-fixtures.js";
import { buildParityHtml, buildParityRows, detectOnsets, matchOnsets, overallVerdict, parsePsnrStats, parseSsimStats, parseVmafMean, summarize, type ParityInput } from "./parity-metrics.js";

describe("parity metrics (VE2E-116)", () => {
  it("parses ssim/psnr/vmaf logs and summarises", () => {
    expect(parseSsimStats("n:1 Y:0.98 U:0.99 V:0.99 All:0.985 (18.2)\nn:2 Y:1.0 U:1.0 V:1.0 All:1.000000 (inf)")).toEqual([0.985, 1]);
    expect(parsePsnrStats("n:1 mse_avg:0.5 mse_y:0.5 psnr_avg:51.2 psnr_y:51\nn:2 mse_avg:0 psnr_avg:inf")).toEqual([51.2, 100]);
    expect(parseVmafMean(JSON.stringify({ pooled_metrics: { vmaf: { mean: 93.5 } } }))).toBe(93.5);
    expect(parseVmafMean("not json")).toBeNull();
    const stats = summarize([1, 0.9, 0.8, 0.95]);
    expect(stats).toMatchObject({ min: 0.8, count: 4 });
    expect(stats.mean).toBeCloseTo(0.9125, 5);
    expect(summarize([]).count).toBe(0);
  });

  it("detects caption onsets as isolated spikes above the noise floor and matches them across two renders", () => {
    const fps = 30;
    const spikes = (times: number[], length = 300) => {
      const activity = Array.from({ length }, (_, i) => 0.02 + (i % 3) * 0.01);
      for (const t of times) activity[Math.round(t * fps)] = 9;
      return activity;
    };
    const a = detectOnsets(spikes([1, 3.2, 6.5]), fps);
    expect(a).toEqual([1, 3.2, 6.5].map((t) => Math.round(t * fps) / fps));
    const b = detectOnsets(spikes([1.2, 3.4, 6.7, 8]), fps);
    const match = matchOnsets(a, b);
    expect(match).toMatchObject({ matched: 3, unmatchedA: 0, unmatchedB: 1 });
    expect(match.medianOffsetMs).toBeGreaterThanOrEqual(190);
    expect(match.medianOffsetMs).toBeLessThanOrEqual(210);
    expect(detectOnsets([0.1, 0.1], 30)).toEqual([]);
    expect(matchOnsets([], [1, 2])).toMatchObject({ matched: 0, medianOffsetMs: null, unmatchedB: 2 });
    expect(matchOnsets([1], [3], 0.5).matched).toBe(0); // too far apart to be the same caption
  });

  const input = (over: Partial<ParityInput> = {}): ParityInput => ({
    labelA: "lyonix", labelB: "creatomate",
    a: { width: 1080, height: 1920, fps: 60, durationMs: 70_000, frames: 4200, videoCodec: "h264", audioCodec: "aac" },
    b: { width: 1080, height: 1920, fps: 60, durationMs: 70_040, frames: 4202, videoCodec: "h264", audioCodec: "aac" },
    loudnessA: { integratedLufs: -14.1, truePeakDbtp: -1.6 }, loudnessB: { integratedLufs: -14.6, truePeakDbtp: -1.2 },
    ssim: { mean: 0.93, min: 0.8, p5: 0.86, count: 100 }, psnr: { mean: 31, min: 25, p5: 27, count: 100 }, vmaf: null,
    keyframes: [{ timeSec: 1, ssim: 0.9, imageA: "data:image/jpeg;base64,AAAA", imageB: "data:image/jpeg;base64,BBBB" }],
    captions: { matched: 10, unmatchedA: 0, unmatchedB: 1, medianOffsetMs: 17, maxAbsOffsetMs: 40 }, ...over,
  });

  it("rates each metric against the proposed thresholds and reports the worst as overall", () => {
    expect(overallVerdict(buildParityRows(input()))).toBe("pass");
    const verdicts = (over: Partial<ParityInput>) => Object.fromEntries(buildParityRows(input(over)).map((r) => [r.metric, r.verdict]));
    expect(verdicts({ b: { ...input().b, fps: 30 } })["Frame rate"]).toBe("fail");
    expect(verdicts({ b: { ...input().b, durationMs: 70_300 } })["Duration"]).toBe("fail");
    expect(verdicts({ loudnessB: { integratedLufs: -17, truePeakDbtp: -3 } })["Integrated loudness"]).toBe("warn");
    expect(verdicts({ ssim: { mean: 0.8, min: 0.5, p5: 0.6, count: 1 } })["SSIM (mean / min / p5)"]).toBe("warn");
    expect(verdicts({ ssim: { mean: 0.6, min: 0.5, p5: 0.5, count: 1 } })["SSIM (mean / min / p5)"]).toBe("fail");
    expect(verdicts({ captions: { matched: 5, unmatchedA: 0, unmatchedB: 0, medianOffsetMs: 200, maxAbsOffsetMs: 210 } })["Caption timing (estimate)"]).toBe("fail");
    expect(verdicts({ captions: null })["Caption timing (estimate)"]).toBeUndefined();
    expect(overallVerdict(buildParityRows(input({ a: { ...input().a, width: 720, height: 1280 } })))).toBe("warn");
  });

  it("builds a self-contained, escaped HTML report with the key frames", () => {
    const html = buildParityHtml(input({ labelA: "<script>x</script>" }), new Date("2026-10-04T00:00:00Z"));
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"');
    expect(html).toContain("2026-10-04T00:00:00.000Z");
    expect(html).toContain("not available (FFmpeg without libvmaf)");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });
});

/** The CLI on two real video files (synthetic lavfi videos with captions at known times). */
const here = dirname(fileURLToPath(import.meta.url));
const tsx = resolve(here, "../../node_modules/.bin/tsx");
const cli = resolve(here, "../../scripts/render-parity.ts");
const fontFile = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf", "C:/Windows/Fonts/arialbd.ttf"].find((f) => existsSync(f));
const availability = detectFfmpeg();

describe.skipIf(!availability.ok || !existsSync(tsx) || !fontFile)("render:parity CLI on real videos", () => {
  let dir: string;
  const make = (name: string, opts: { offsetSec?: number; color?: string; fps?: number } = {}): string => {
    const file = join(dir, `${name}.mp4`);
    const off = opts.offsetSec ?? 0;
    const caption = (from: number, to: number, text: string) => `drawtext=fontfile=${fontFile}:text='${text}':fontsize=90:fontcolor=white:x=(w-text_w)/2:y=h*0.7:enable='between(t,${from + off},${to + off})'`;
    generate([
      "-f", "lavfi", "-i", `color=c=${opts.color ?? "0x223355"}:s=540x960:r=${opts.fps ?? 30}:d=8`,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
      "-vf", [caption(1, 2.4, "One"), caption(3, 4.4, "Two"), caption(5.2, 6.8, "Three")].join(","),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
    ]);
    return file;
  };
  const parity = (a: string, b: string) => {
    const report = join(dir, `report-${Math.random().toString(36).slice(2)}.html`);
    const r = spawnSync(tsx, [cli, a, b, "--out", report, "--frames", "3", "--label-a", "lyonix", "--label-b", "other"], { encoding: "utf8", cwd: resolve(here, "../.."), timeout: 240_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, html: existsSync(report) ? readFileSync(report, "utf8") : "" };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lyonix-parity-it-"));
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("two identical renders: SSIM ~1, no caption offset, overall pass, HTML report written", () => {
    const a = make("same-a");
    const r = parity(a, a);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("overall: pass");
    expect(r.html).toContain("Render parity");
    expect(r.html.match(/data:image\/jpeg;base64,/g)!.length).toBeGreaterThanOrEqual(6); // 3 key frames x 2 videos
    expect(r.stdout).toMatch(/SSIM[^\n]*1\.0000/);
    expect(r.stdout).toMatch(/Caption timing[^\n]*median \+?0 ms/);
  }, 300_000);

  it("a caption shown 200 ms late in B is measured (~+200 ms) and fails the 2-frame bar; a different picture lowers SSIM", () => {
    const a = make("late-a");
    const b = make("late-b", { offsetSec: 0.2 });
    const r = parity(a, b);
    const match = /Caption timing[^\n]*median \+?(-?\d+) ms/.exec(r.stdout);
    expect(match, r.stdout + r.stderr).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(150);
    expect(Number(match![1])).toBeLessThanOrEqual(250);
    expect(r.stdout).toContain("fail ");
    expect(r.status).toBe(1);

    const different = parity(a, make("diff-b", { color: "0xcc3322" }));
    const ssim = Number(/SSIM[^\n]*?(\d\.\d{4}) \//.exec(different.stdout)?.[1]);
    expect(ssim).toBeLessThan(0.9);
  }, 300_000);

  it("reports a frame-rate mismatch", () => {
    const r = parity(make("fps-a"), make("fps-b", { fps: 24 }));
    expect(r.stdout).toMatch(/fail\s+Frame rate/);
    expect(r.status).toBe(1);
  }, 300_000);
});
