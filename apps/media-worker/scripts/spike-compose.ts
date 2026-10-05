/**
 * VE2E-101 spike (measurement tool, not run in CI): builds a broadcast-telop-like 70 s 1080x1920 60 fps video
 * from synthetic fixtures (lavfi testsrc2/sine, nothing downloaded, nothing committed) and reports wall time and
 * CPU-seconds per x264 preset. The filtergraph is a hand-written approximation of the telop recipe (cover crop,
 * slow zoom, xfade wipe/fade, banner + libass subtitles, voice + ducked music, loudnorm); the real composer
 * lives in src/compose (VE2E-105). Numbers are only meaningful for the machine they ran on.
 *
 *   tsx scripts/spike-compose.ts [--presets veryfast,faster,medium] [--seconds 70] [--threads N] [--keep]
 *
 * CPU-seconds come from bash's `time` (user+sys of the ffmpeg process tree) on Linux/macOS; elsewhere only wall time is reported.
 */
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
};
const presets = arg("presets", "veryfast,faster,medium").split(",");
const totalSeconds = Number(arg("seconds", "70"));
const threads = Number(arg("threads", "0"));
const keep = process.argv.includes("--keep");
const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
const fontsDir = process.env.SPIKE_FONTS_DIR?.trim() || "/usr/share/fonts/truetype/dejavu";
const fontFile = join(fontsDir, "DejaVuSans-Bold.ttf");

const SCENES = 7;
const TRANSITION = 0.4;
const sceneSeconds = totalSeconds / SCENES;
const W = 1080;
const H = 1920;
const FPS = 60;

const work = mkdtempSync(join(tmpdir(), "lyonix-spike-"));
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr.slice(-1500)}`);
  return r;
};

// --- fixtures -------------------------------------------------------------------------------------------------
// Landscape 1080p 30 fps sources (the hard real-world case: cover crop + fps 30 -> 60 by frame duplication).
const clipLen = sceneSeconds + TRANSITION + 0.5;
for (let i = 0; i < SCENES; i += 1) {
  run(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${clipLen}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", join(work, `clip${i}.mp4`)]);
}
run(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=48000:duration=${totalSeconds}`, "-ac", "2", join(work, "voice.wav")]);
run(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${totalSeconds}`, "-ac", "2", join(work, "music.wav")]);

const assTime = (s: number) => `0:${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const cues: string[] = [];
for (let t = 0.5; t < totalSeconds - 2; t += 2.5) {
  cues.push(`Dialogue: 0,${assTime(t)},${assTime(t + 2.3)},Sub,,0,0,0,,これは{\\c&H00FFFF&}テスト用の{\\c}字幕です\\N二行目のサンプル`);
}
writeFileSync(
  join(work, "sub.ass"),
  [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 2", "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Sub,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,5,0,2,130,130,380,1", "",
    "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text", ...cues, "",
  ].join("\n"),
);

// --- filtergraph ---------------------------------------------------------------------------------------------
const buildGraph = (): string => {
  const parts: string[] = [];
  for (let i = 0; i < SCENES; i += 1) {
    const dur = sceneSeconds + TRANSITION;
    const zoom = i % 2 === 0
      ? `scale=w='trunc(${W}*(1+0.05*t/${dur})/2)*2':h='trunc(${H}*(1+0.05*t/${dur})/2)*2':eval=frame:flags=bilinear,crop=${W}:${H}`
      : "null";
    parts.push(`[${i}:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bilinear,crop=${W}:${H},setsar=1,trim=duration=${dur},setpts=PTS-STARTPTS,${zoom},format=yuv420p[s${i}]`);
  }
  let last = "s0";
  for (let i = 1; i < SCENES; i += 1) {
    const offset = (sceneSeconds * i - 0).toFixed(3);
    const kind = i % 2 === 0 ? "fade" : "wipeleft";
    parts.push(`[${last}][s${i}]xfade=transition=${kind}:duration=${TRANSITION}:offset=${(Number(offset) - TRANSITION).toFixed(3)}[x${i}]`);
    last = `x${i}`;
  }
  const text = "速報テスト：ブロードキャストテロップ";
  parts.push(
    `[${last}]drawbox=x=0:y=120:w=${W}:h=190:color=0xB00020@0.92:t=fill,` +
      `drawtext=fontfile=${fontFile}:text='${text}':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=190,` +
      `drawbox=x=40:y=60:w=260:h=70:color=0xFFD400@1:t=fill,` +
      `ass=${join(work, "sub.ass").replace(/\\/g, "/")}:fontsdir=${fontsDir}[v]`,
  );
  const base = SCENES; // voice, music inputs follow the clips
  parts.push(`[${base}:a]aresample=48000,aformat=channel_layouts=stereo[va]`);
  parts.push(`[${base + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=-12dB[ma]`);
  parts.push(`[va][ma]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]`);
  return parts.join(";");
};

const inputs: string[] = [];
for (let i = 0; i < SCENES; i += 1) inputs.push("-i", join(work, `clip${i}.mp4`));
inputs.push("-i", join(work, "voice.wav"), "-i", join(work, "music.wav"));
const graph = buildGraph();

type Row = { preset: string; wallSec: number; cpuSec: number | null; speedX: number; mb: number; probe: string };
const rows: Row[] = [];
const canTime = process.platform !== "win32";

for (const preset of presets) {
  const out = join(work, `out-${preset}.mp4`);
  const args = [
    "-y", "-v", "error", ...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", preset, "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-fps_mode", "cfr",
    "-g", String(FPS * 2), "-keyint_min", String(FPS * 2), "-sc_threshold", "0",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart",
    ...(threads > 0 ? ["-threads", String(threads)] : []), "-t", String(totalSeconds), out,
  ];
  const started = performance.now();
  let cpuSec: number | null = null;
  if (canTime) {
    const quoted = [ffmpeg, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const r = spawnSync("bash", ["-c", `TIMEFORMAT='%U %S'; time ${quoted}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`ffmpeg ${preset} failed: ${r.stderr.slice(-1500)}`);
    const [user, sys] = r.stderr.trim().split("\n").at(-1)!.split(" ").map(Number);
    if (Number.isFinite(user) && Number.isFinite(sys)) cpuSec = (user ?? 0) + (sys ?? 0);
  } else {
    run(ffmpeg, args);
  }
  const wallSec = (performance.now() - started) / 1000;
  const probeJson = JSON.parse(run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,duration", "-of", "json", out]).stdout) as { streams: Array<Record<string, string>> };
  const v = probeJson.streams.find((s) => s.codec_name === "h264")!;
  rows.push({ preset, wallSec, cpuSec, speedX: totalSeconds / wallSec, mb: statSync(out).size / 1e6, probe: `${v.width}x${v.height} ${v.avg_frame_rate} (r=${v.r_frame_rate}) ${Number(v.duration).toFixed(2)}s` });
}

const cpu = cpus();
console.info(`machine: ${cpu[0]?.model ?? "?"} x${cpu.length} logical CPUs; ffmpeg threads=${threads || "auto"}; video=${totalSeconds}s ${W}x${H}@${FPS}`);
console.info("| preset | wall s | CPU-s (user+sys) | speed x realtime | MB | ffprobe |");
console.info("|---|---:|---:|---:|---:|---|");
for (const r of rows) console.info(`| ${r.preset} | ${r.wallSec.toFixed(1)} | ${r.cpuSec === null ? "n/a" : r.cpuSec.toFixed(1)} | ${r.speedX.toFixed(2)} | ${r.mb.toFixed(1)} | ${r.probe} |`);
if (keep) console.info(`fixtures/outputs kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
