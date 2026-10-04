/**
 * VE2E-116: `pnpm render:parity -- <a.mp4> <b.mp4> [--out report.html] [--frames 8] [--label-a lyonix] [--label-b creatomate]`
 * Compares two renders of the same timeline (any two video files): size/fps/duration, loudness, SSIM/PSNR (+VMAF when FFmpeg has libvmaf) over a
 * scaled copy, key frames side by side, and an estimate of the caption timing offset. Writes a self-contained HTML report; exit code 1 when the
 * overall verdict is `fail`. Needs only FFmpeg/ffprobe (works offline); comparing against a real Creatomate render needs that render's file, which is
 * produced on the owner's machine (paid provider, not run in CI).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildParityHtml, buildParityRows, detectOnsets, matchOnsets, overallVerdict, parsePsnrStats, parseSsimStats, parseVmafMean, summarize, type Loudness, type ParityInput, type StreamInfo } from "../src/parity/parity-metrics.js";
import { parseEbur128Summary } from "../src/compose/qc-signal.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
if (files.length !== 2) {
  console.error("usage: render-parity.ts <a.mp4> <b.mp4> [--out report.html] [--frames 8] [--label-a A] [--label-b B] [--caption-band 0.58:0.22]");
  process.exit(2);
}
const [fileA, fileB] = files.map((f) => resolve(f)) as [string, string];
const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
const out = resolve(flag("out", "render-parity.html")!);
const frameCount = Math.max(1, Math.min(24, Number(flag("frames", "8"))));
const [bandTop, bandHeight] = (flag("caption-band", "0.58:0.22")!).split(":").map(Number) as [number, number];
const work = mkdtempSync(join(tmpdir(), "lyonix-parity-"));

const run = (cmd: string, cmdArgs: string[]) => spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const rate = (value: string | undefined): number | null => {
  if (!value) return null;
  const [n, d] = value.split("/").map(Number);
  return n !== undefined && d !== undefined && d !== 0 && Number.isFinite(n / d) ? n / d : null;
};

const probe = (file: string): StreamInfo => {
  const json = JSON.parse(run(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file]).stdout || "{}") as { streams?: Array<Record<string, string>>; format?: Record<string, string> };
  const v = json.streams?.find((s) => s.codec_type === "video");
  const a = json.streams?.find((s) => s.codec_type === "audio");
  if (!v) throw new Error(`${file}: no video stream`);
  return { width: Number(v.width) || null, height: Number(v.height) || null, fps: rate(v.avg_frame_rate), durationMs: Number(v.duration ?? json.format?.duration) * 1000 || null, frames: Number(v.nb_read_frames) || null, videoCodec: v.codec_name ?? null, audioCodec: a?.codec_name ?? null };
};

const loudness = (file: string): Loudness => {
  const r = run(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]);
  const parsed = parseEbur128Summary(r.stderr);
  const finite = (v: number | null | undefined) => (v !== null && v !== undefined && Number.isFinite(v) ? v : null);
  return { integratedLufs: finite(parsed?.integratedLufs), truePeakDbtp: finite(parsed?.truePeakDbtp) };
};

const hasFilter = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(run(ffmpeg, ["-hide_banner", "-filters"]).stdout);

/** Per-frame activity of the caption band (YDIF between consecutive frames), 30 fps sampling. */
const bandActivity = (file: string): number[] => {
  const log = join(work, `band-${Math.random().toString(36).slice(2)}.txt`);
  run(ffmpeg, ["-hide_banner", "-nostdin", "-i", file, "-an", "-vf", `fps=30,scale=270:480,crop=iw*0.76:ih*${bandHeight}:iw*0.12:ih*${bandTop},signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=${log}`, "-f", "null", "-"]);
  return [...readFileSync(log, "utf8").matchAll(/lavfi\.signalstats\.YDIF=([\d.]+)/g)].map((m) => Number(m[1]));
};

try {
  const a = probe(fileA);
  const b = probe(fileB);
  console.error("[parity] SSIM/PSNR ...");
  const ssimLog = join(work, "ssim.log");
  const psnrLog = join(work, "psnr.log");
  const vmafLog = join(work, "vmaf.json");
  const wantVmaf = hasFilter("libvmaf");
  const graph = `[0:v]scale=540:960:flags=bicubic,fps=30,setpts=PTS-STARTPTS,format=yuv420p,split=${wantVmaf ? 3 : 2}[a1][a2]${wantVmaf ? "[a3]" : ""};[1:v]scale=540:960:flags=bicubic,fps=30,setpts=PTS-STARTPTS,format=yuv420p,split=${wantVmaf ? 3 : 2}[b1][b2]${wantVmaf ? "[b3]" : ""};[a1][b1]ssim=stats_file=${ssimLog}[s];[a2][b2]psnr=stats_file=${psnrLog}[p]${wantVmaf ? `;[a3][b3]libvmaf=log_path=${vmafLog}:log_fmt=json[v]` : ""}`;
  const metricRun = run(ffmpeg, ["-hide_banner", "-nostdin", "-nostats", "-v", "error", "-i", fileA, "-i", fileB, "-filter_complex", graph, "-map", "[s]", "-f", "null", "-", "-map", "[p]", "-f", "null", "-", ...(wantVmaf ? ["-map", "[v]", "-f", "null", "-"] : [])]);
  if (metricRun.status !== 0) throw new Error(`metric run failed: ${metricRun.stderr.slice(-400)}`);
  const ssimValues = parseSsimStats(readFileSync(ssimLog, "utf8"));
  const psnrValues = parsePsnrStats(readFileSync(psnrLog, "utf8"));
  const vmaf = wantVmaf ? parseVmafMean(readFileSync(vmafLog, "utf8")) : null;

  console.error("[parity] key frames ...");
  const duration = Math.min(a.durationMs ?? 0, b.durationMs ?? 0) / 1000;
  const keyframes: ParityInput["keyframes"] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const t = duration * ((i + 0.5) / frameCount);
    const shot = (file: string, name: string): string => {
      const png = join(work, `${name}-${i}.jpg`);
      run(ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=270:480", "-q:v", "4", png]);
      return `data:image/jpeg;base64,${readFileSync(png).toString("base64")}`;
    };
    const index = Math.min(ssimValues.length - 1, Math.round(t * 30));
    keyframes.push({ timeSec: t, ssim: index >= 0 ? ssimValues[index]! : null, imageA: shot(fileA, "a"), imageB: shot(fileB, "b") });
  }

  console.error("[parity] loudness + caption timing ...");
  const captions = matchOnsets(detectOnsets(bandActivity(fileA), 30), detectOnsets(bandActivity(fileB), 30));
  const input: ParityInput = { labelA: flag("label-a", "A")!, labelB: flag("label-b", "B")!, a, b, loudnessA: loudness(fileA), loudnessB: loudness(fileB), ssim: summarize(ssimValues), psnr: summarize(psnrValues), vmaf, keyframes, captions };
  writeFileSync(out, buildParityHtml(input));
  const rows = buildParityRows(input);
  const verdict = overallVerdict(rows);
  for (const row of rows) console.info(`${row.verdict.padEnd(5)} ${row.metric.padEnd(28)} ${row.delta}`);
  console.info(`overall: ${verdict} -> ${out}`);
  process.exitCode = verdict === "fail" ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
