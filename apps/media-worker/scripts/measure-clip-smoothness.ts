/**
 * VE2E-90 measurement harness: builds synthetic sources with the real ffmpeg (VFR, 50/60 fps, long GOP, B-frames, jittery pts),
 * cuts them through the real ClipPrepareProcessor, and prints smoothness metrics of the sources, of the output and of a forced
 * stream copy. Run: `pnpm --filter @lyonix/media-worker exec tsx scripts/measure-clip-smoothness.ts [outFile.json]`.
 * No network, no secrets, temp dir removed at the end.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { buildClipPrepareJob } from "@lyonix/media-jobs";
import { ClipPrepareProcessor } from "../src/clip-prepare.js";
import { analyzeSmoothness, buildProbeArgs, buildSmoothnessProbeArgs, parseProbeJson, type SmoothnessReport } from "../src/clip-plan.js";
import { runProcess } from "../src/process.js";

const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
const gen = (args: string[]) => {
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
};
const measure = (path: string): SmoothnessReport | null => analyzeSmoothness(spawnSync(ffprobe, buildSmoothnessProbeArgs(path), { encoding: "utf8" }).stdout);
const fpsOf = (path: string) => {
  const p = parseProbeJson(spawnSync(ffprobe, buildProbeArgs(path), { encoding: "utf8" }).stdout);
  return p.ok ? { avg: p.probe.video.fps, r: p.probe.video.rFps, w: p.probe.video.displayWidth, h: p.probe.video.displayHeight } : null;
};

const main = async () => {
  const root = await mkdtemp(join(tmpdir(), "lyx-ve2e90-"));
  const dir = join(root, "projects/p/assets");
  await mkdir(dir, { recursive: true });
  const src = (name: string) => join(dir, name);
  const lav = (size: string, rate: number, dur: number) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=${dur}`];
  const x264 = (g: number, extra: string[] = []) => ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", String(g), "-sc_threshold", "0", ...extra];
  gen([...lav("720x1280", 30, 12), ...x264(30), src("cfr30-gop1s.mp4")]);
  gen([...lav("720x1280", 30, 12), ...x264(300), src("cfr30-longgop10s.mp4")]);
  gen([...lav("720x1280", 30, 12), ...x264(120, ["-bf", "3", "-b_strategy", "2"]), src("cfr30-bframes.mp4")]);
  gen([...lav("720x1280", 50, 12), ...x264(100), src("cfr50.mp4")]);
  gen([...lav("720x1280", 60, 12), ...x264(120), src("cfr60.mp4")]);
  gen([...lav("1080x1920", 30, 12), ...x264(30), src("cfr30-1080x1920.mp4")]);
  gen([...lav("720x1280", 24, 12), ...x264(48), src("cfr24.mp4")]);
  // real VFR: 60 fps content with ~35% of frames dropped at random-looking, pts kept (phone/screen-capture style)
  gen([...lav("720x1280", 60, 12), "-vf", "select='gte(random(0),0.35)'", "-fps_mode", "passthrough", ...x264(60), src("vfr-dropped.mp4")]);
  // VFR by joining a 30 fps part and a 24 fps part with stream copy (spacing changes mid-stream)
  gen([...lav("720x1280", 30, 6), ...x264(30), join(root, "a.mp4")]);
  gen([...lav("720x1280", 24, 6), ...x264(24), join(root, "b.mp4")]);
  await writeFile(join(root, "list.txt"), [`file '${join(root, "a.mp4").split(sep).join("/")}'`, `file '${join(root, "b.mp4").split(sep).join("/")}'`, ""].join("\n"));
  gen(["-f", "concat", "-safe", "0", "-i", join(root, "list.txt"), "-c", "copy", src("vfr-30to24.mp4")]);

  const files = ["cfr30-gop1s", "cfr30-longgop10s", "cfr30-bframes", "cfr50", "cfr60", "cfr30-1080x1920", "cfr24", "vfr-dropped", "vfr-30to24"];
  const processor = new ClipPrepareProcessor({
    config: { mediaRoot: root, ffmpegPath: ffmpeg, ffprobePath: ffprobe, copyToleranceMs: 1000, jobTimeoutMs: 120_000, maxAttempts: 1 },
    runner: runProcess,
    ffmpegVersion: "measure",
  });
  const rows: unknown[] = [];
  for (const name of files) {
    const rel = `projects/p/assets/${name}.mp4`;
    const started = Date.now();
    const result = await processor.handle(buildClipPrepareJob({ jobKey: `m:${name}`, source: { relativePath: rel }, startMs: 2370, durationMs: 4000, stripAudio: true }));
    const ms = Date.now() - started;
    const row: Record<string, unknown> = { name, source: { ...fpsOf(src(`${name}.mp4`)), smoothness: measure(src(`${name}.mp4`)) } };
    if (result.ok) {
      const out = join(root, result.output.relativePath);
      row.output = { mode: result.mode, reasons: result.reencodeReasons, wallMs: ms, fps: fpsOf(out), smoothness: measure(out), driftMs: result.drift };
    } else row.output = { error: result.error };
    // what a forced stream copy of the same range would have produced (the legacy behaviour for VFR/long GOP)
    const copyOut = join(root, `${name}-copy.mp4`);
    gen(["-ss", "2.370", "-i", src(`${name}.mp4`), "-t", "4.000", "-map", "0:v:0", "-an", "-c", "copy", "-avoid_negative_ts", "make_zero", copyOut]);
    row.forcedCopy = { fps: fpsOf(copyOut), smoothness: measure(copyOut) };
    rows.push(row);
  }
  const json = JSON.stringify({ tool: spawnSync(ffmpeg, ["-version"], { encoding: "utf8" }).stdout.split("\n")[0], platform: process.platform, cutStartMs: 2370, cutDurationMs: 4000, rows }, null, 2);
  if (process.argv[2]) await writeFile(process.argv[2], json);
  else console.log(json);
  await rm(root, { recursive: true, force: true });
};
void main();
