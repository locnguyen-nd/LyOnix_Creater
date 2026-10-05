/**
 * VE2E-67 manual run on a local file (no RabbitMQ, no DB, no provider): `reframe.analyze` -> `clip.prepare` WITH the plan and, for
 * comparison, `clip.prepare` WITHOUT it (legacy blind centre crop). The source is COPIED into a throw-away MEDIA_ROOT (OS temp dir) so
 * the original file and its media folder are never written to.
 *
 *   tsx scripts/crop-apply-cli.ts <source-file> [--origin apify] [--start 0 --dur 5000] [--out-dir <dir>] [--frames-dir <dir>]
 *
 * Prints one JSON object: analysis summary, both clip results (mode, size, audio, bytes, wall ms) and the output stream facts. With
 * --frames-dir it writes small JPEGs (legacy vs planned frame at 25/50/75% of the clip) for visual inspection.
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClipPrepareJob, buildReframeAnalyzeJob } from "@lyonix/media-jobs";
import { ClipPrepareProcessor } from "../src/clip-prepare.js";
import { loadMediaWorkerConfig } from "../src/config.js";
import { readToolVersion, runProcess } from "../src/process.js";
import { ReframeAnalyzeProcessor } from "../src/reframe-analyze.js";
import { loadReframeConfig } from "../src/reframe/config.js";
import { OnnxFrameDetector } from "../src/reframe/onnx-detector.js";

const args = process.argv.slice(2);
const source = args[0];
if (!source || source.startsWith("--")) {
  console.error("usage: crop-apply-cli.ts <source-file> [--origin x] [--start ms] [--dur ms] [--out-dir dir] [--frames-dir dir]");
  process.exit(2);
}
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = opt("out-dir") ? resolve(opt("out-dir")!) : await mkdtemp(join(tmpdir(), "lyonix-cropapply-"));
await mkdir(join(root, "src"), { recursive: true });
const rel = `src/${basename(source)}`;
await copyFile(resolve(source), join(root, rel));

const cfg = loadMediaWorkerConfig({ ...process.env, MEDIA_ROOT: root }, repoRoot);
const reframe = loadReframeConfig(process.env, repoRoot);
const detector = new OnnxFrameDetector({ modelsDir: reframe.modelsDir, threads: reframe.ortThreads });
const ffmpegVersion = await readToolVersion(runProcess, cfg.ffmpegPath);
const analyzer = new ReframeAnalyzeProcessor({ config: cfg, reframe, runner: runProcess, ffmpegVersion, detector });
const clips = new ClipPrepareProcessor({ config: cfg, runner: runProcess, ffmpegVersion });

const startMs = Number(opt("start") ?? 0);
const durationMs = Number(opt("dur") ?? 5000);
const tag = basename(source).replace(/\W+/g, "_").slice(0, 12);
const stamp = Date.now();

const t0 = performance.now();
const analysis = await analyzer.handle(buildReframeAnalyzeJob({ jobKey: `cli:a:${tag}:${stamp}`, source: { relativePath: rel, kind: "video" }, startMs, durationMs, origin: opt("origin") ?? null }));
const analyzeWallMs = Math.round(performance.now() - t0);
if (!analysis.ok) {
  console.info(JSON.stringify({ analysisError: analysis.error }, null, 1));
  await detector.close();
  process.exit(1);
}

const base = { source: { relativePath: rel }, startMs, durationMs, stripAudio: true } as const;
const timed = async <T>(fn: () => Promise<T>) => {
  const t = performance.now();
  const value = await fn();
  return { value, wallMs: Math.round(performance.now() - t) };
};
const legacy = await timed(() => clips.handle(buildClipPrepareJob({ ...base, jobKey: `cli:legacy:${tag}:${stamp}` })));
const planned = await timed(() => clips.handle(buildClipPrepareJob({ ...base, jobKey: `cli:planned:${tag}:${stamp}`, cropPlan: analysis.cropPlan })));

const ffprobe = (relPath: string) => {
  const result = spawnSync(cfg.ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration", "-of", "json", join(root, relPath)], { encoding: "utf8" });
  return JSON.parse(result.stdout || "{}") as unknown;
};
const summarize = (name: string, wrapped: { value: Awaited<ReturnType<ClipPrepareProcessor["handle"]>>; wallMs: number }) => {
  const result = wrapped.value;
  if (!result.ok) return { name, error: result.error };
  return { name, wallMs: wrapped.wallMs, mode: result.mode, reasons: result.reencodeReasons, output: { width: result.output.width, height: result.output.height, hasAudio: result.output.hasAudio, bytes: result.output.bytes, sha256: result.output.sha256.slice(0, 12), durationMs: result.output.durationMs }, reframe: result.reframe ?? null, streams: ffprobe(result.output.relativePath) };
};

const framesDir = opt("frames-dir");
if (framesDir) {
  await mkdir(resolve(framesDir), { recursive: true });
  for (const [label, wrapped] of [["legacy", legacy], ["planned", planned]] as const) {
    if (!wrapped.value.ok) continue;
    for (const pct of [0.25, 0.5, 0.75]) {
      const at = ((durationMs / 1000) * pct).toFixed(2);
      spawnSync(cfg.ffmpegPath, ["-v", "error", "-y", "-ss", at, "-i", join(root, wrapped.value.output.relativePath), "-frames:v", "1", "-vf", "scale=360:640", join(resolve(framesDir), `${tag}-${label}-${Math.round(pct * 100)}.jpg`)]);
    }
  }
}

console.info(
  JSON.stringify(
    {
      source: { file: basename(source), startMs, durationMs, origin: opt("origin") ?? null },
      analysis: { wallMs: analyzeWallMs, zoomPermille: analysis.cropPlan.zoomPermille, mode: analysis.cropPlan.mode, keyframes: analysis.cropPlan.keyframes.length, unavoidable: analysis.overlayUnavoidable, residualOverlayPct: analysis.cropPlan.residualOverlayPct, subjectCoveragePct: analysis.cropPlan.subjectCoveragePct, confidence: analysis.confidence.level, subjectSource: analysis.analysis.subjectSource, warnings: analysis.analysis.warnings, sourceSize: `${analysis.source.width}x${analysis.source.height}` },
      clips: [summarize("legacy_center_crop", legacy), summarize("with_crop_plan", planned)],
    },
    null,
    1,
  ),
);
await detector.close();
if (!opt("out-dir")) await rm(root, { recursive: true, force: true });
