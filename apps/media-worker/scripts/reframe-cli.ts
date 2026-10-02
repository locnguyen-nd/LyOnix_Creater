/**
 * VE2E-66 manual run of `reframe.analyze` on a local file (no RabbitMQ, no DB, no provider). The source is COPIED into a throw-away
 * MEDIA_ROOT (default: OS temp dir) so the original file and its media folder are never written to.
 *
 *   tsx scripts/reframe-cli.ts <source-file> [--origin apify] [--start 0 --dur 8000] [--kind video|image] [--prefer largest|center|salient]
 *                              [--debug-dir <dir>] [--out-dir <dir>] [--runs N]
 * Prints the job result JSON (+ wall time and RSS). With --debug-dir it writes one JPEG per analysed frame with the subject track
 * (green), exclusion regions (red) and the planned crop window (yellow).
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReframeAnalyzeJob } from "@lyonix/media-jobs";
import { loadMediaWorkerConfig } from "../src/config.js";
import { ReframeAnalyzeProcessor } from "../src/reframe-analyze.js";
import { loadReframeConfig } from "../src/reframe/config.js";
import { encodeRgbToJpeg, type RgbImage } from "../src/reframe/image-io.js";
import { OnnxFrameDetector } from "../src/reframe/onnx-detector.js";
import { readToolVersion, runProcess } from "../src/process.js";

const args = process.argv.slice(2);
const source = args[0];
if (!source || source.startsWith("--")) {
  console.error("usage: reframe-cli.ts <source-file> [--origin x] [--start ms] [--dur ms] [--kind video|image] [--prefer largest|center|salient] [--debug-dir dir]");
  process.exit(2);
}
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = opt("out-dir") ? resolve(opt("out-dir")!) : await mkdtemp(join(tmpdir(), "lyonix-reframe-"));
await mkdir(join(root, "src"), { recursive: true });
const rel = `src/${basename(source)}`;
await copyFile(resolve(source), join(root, rel));

const cfg = loadMediaWorkerConfig({ ...process.env, MEDIA_ROOT: root }, repoRoot);
const reframe = loadReframeConfig(process.env, repoRoot);
const detector = new OnnxFrameDetector({ modelsDir: reframe.modelsDir, threads: reframe.ortThreads });
const ffmpegVersion = await readToolVersion(runProcess, cfg.ffmpegPath);

const drawRect = (image: RgbImage, x: number, y: number, w: number, h: number, rgb: [number, number, number]) => {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(image.width - 1, Math.round(x + w));
  const y1 = Math.min(image.height - 1, Math.round(y + h));
  const put = (px: number, py: number) => {
    const o = (py * image.width + px) * 3;
    image.data[o] = rgb[0];
    image.data[o + 1] = rgb[1];
    image.data[o + 2] = rgb[2];
  };
  for (let t = 0; t < 2; t += 1) {
    for (let px = x0; px <= x1; px += 1) { put(px, Math.min(y1, y0 + t)); put(px, Math.max(y0, y1 - t)); }
    for (let py = y0; py <= y1; py += 1) { put(Math.min(x1, x0 + t), py); put(Math.max(x0, x1 - t), py); }
  }
};

const debugDir = opt("debug-dir");
if (debugDir) await mkdir(resolve(debugDir), { recursive: true });
const tag = basename(source).replace(/\W+/g, "_").slice(0, 12);

const processor = new ReframeAnalyzeProcessor({
  config: cfg,
  reframe,
  runner: runProcess,
  ffmpegVersion,
  detector,
  onDebug: ({ result, debug }) => {
    if (!debugDir) return;
    for (const [index, frame] of debug.frames.entries()) {
      const canvas: RgbImage = { width: frame.image.width, height: frame.image.height, data: Uint8Array.from(frame.image.data) };
      const sx = canvas.width / result.source.width;
      const sy = canvas.height / result.source.height;
      for (const track of debug.subjects) {
        const sample = track.samples.reduce((best, s) => (Math.abs(s.tMs - frame.tMs) < Math.abs(best.tMs - frame.tMs) ? s : best), track.samples[0]!);
        if (sample) drawRect(canvas, sample.box.xPx * sx, sample.box.yPx * sy, sample.box.widthPx * sx, sample.box.heightPx * sy, track.subjectId === result.cropPlan.primarySubjectId ? [0, 255, 0] : [0, 120, 255]);
      }
      for (const ex of debug.exclusions) {
        if ((ex.startMs !== undefined && frame.tMs < ex.startMs) || (ex.endMs !== undefined && frame.tMs >= ex.endMs)) continue;
        drawRect(canvas, ex.box.xPx * sx, ex.box.yPx * sy, ex.box.widthPx * sx, ex.box.heightPx * sy, ex.kind === "logo" ? [255, 0, 255] : [255, 0, 0]);
      }
      const key = result.cropPlan.keyframes.reduce((best, k) => (Math.abs(k.tMs - frame.tMs) < Math.abs(best.tMs - frame.tMs) ? k : best), result.cropPlan.keyframes[0]!);
      drawRect(canvas, key.xPx * sx, key.yPx * sy, key.widthPx * sx, key.heightPx * sy, [255, 255, 0]);
      void writeFile(join(resolve(debugDir), `${tag}-f${index}.jpg`), encodeRgbToJpeg(canvas, 80));
    }
  },
});

const start = opt("start");
const dur = opt("dur");
const runs = Number(opt("runs") ?? 1);
const summary: unknown[] = [];
for (let run = 1; run <= runs; run += 1) {
  const job = buildReframeAnalyzeJob({
    jobKey: `cli:${tag}:${Date.now()}:${run}`,
    source: { relativePath: rel, kind: (opt("kind") as "video" | "image" | undefined) ?? "video" },
    startMs: start === undefined ? null : Number(start),
    durationMs: dur === undefined ? null : Number(dur),
    origin: opt("origin") ?? null,
    preferredSubject: (opt("prefer") as "largest" | "center" | "salient" | undefined) ?? null,
  });
  const wall = performance.now();
  const result = await processor.handle(job);
  const wallMs = Math.round(performance.now() - wall);
  if (result.ok) {
    summary.push({ run, wallMs, rssMb: Math.round(process.memoryUsage().rss / 1e6), metrics: result.metrics, zoom: result.cropPlan.zoomPermille, unavoidable: result.overlayUnavoidable, residualPct: result.cropPlan.residualOverlayPct, subjectCoveragePct: result.cropPlan.subjectCoveragePct, confidence: result.confidence, analysis: result.analysis, keyframes: result.cropPlan.keyframes });
  } else {
    summary.push({ run, wallMs, error: result.error });
  }
}
console.info(JSON.stringify(runs > 1 ? summary : summary[0], null, 1));
await detector.close();
if (!opt("out-dir")) await rm(root, { recursive: true, force: true });
