import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ComposePlan, ComposeScene } from "@lyonix/media-jobs";
import type { RenderRecipe } from "@lyonix/render-recipes";

/** Test-only helpers shared by the compose unit and integration tests (never imported by runtime code). */

export const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
export const ffprobePath = process.env.FFPROBE_PATH?.trim() || "ffprobe";

export const detectFfmpeg = (): { ok: true; version: string } | { ok: false; reason: string } => {
  const ffmpeg = spawnSync(ffmpegPath, ["-hide_banner", "-version"], { encoding: "utf8" });
  if (ffmpeg.error || ffmpeg.status !== 0) return { ok: false, reason: `${ffmpegPath} not runnable` };
  const probe = spawnSync(ffprobePath, ["-hide_banner", "-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return { ok: false, reason: `${ffprobePath} not runnable` };
  const encoders = spawnSync(ffmpegPath, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (!encoders.stdout?.includes("libx264")) return { ok: false, reason: "ffmpeg build has no libx264 encoder" };
  const filters = spawnSync(ffmpegPath, ["-hide_banner", "-filters"], { encoding: "utf8" });
  for (const name of ["xfade", "ass", "loudnorm", "drawbox", "ebur128", "blackdetect", "freezedetect"]) {
    if (!new RegExp(`\\b${name}\\b`).test(filters.stdout ?? "")) return { ok: false, reason: `ffmpeg build lacks the ${name} filter` };
  }
  return { ok: true, version: ffmpeg.stdout.split(/\r?\n/)[0] ?? "ffmpeg" };
};

export const generate = (args: string[]): void => {
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture generation failed: ${result.stderr}`);
};

/** A font family that can render Japanese on this machine (fontconfig), or null. */
export const findJapaneseFont = (): string | null => {
  const result = spawnSync("fc-match", ["-f", "%{family}", ":lang=ja"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const family = result.stdout.split(",")[0]?.trim();
  return family || null;
};

export const testRecipe = (fontFamily: string): RenderRecipe => ({
  schemaVersion: 1,
  id: "test-telop",
  version: 1,
  name: "Test telop",
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  timing: { padStartMs: 250, padEndMs: 500 },
  transition: { kind: "wipe", durationMs: 400 },
  background: {
    image: { motion: "zoom_in", intensity: 0.06, alternate: true },
    video: { motion: "none", intensity: 0 },
    tint: { color: "#000000", opacity: 0.1 },
  },
  layers: [
    { type: "box", id: "band", x: 0, y: 128, w: 1080, h: 176, color: "slot:accent", opacity: 0.9 },
    { type: "text", id: "headline", slot: "headline", x: 60, y: 128, w: 960, h: 176, fontFamily, fontSizePx: 64, minFontSizePx: 40, color: "#FFFFFF", bold: true, maxLines: 2, outlinePx: 0, outlineColor: "#000000", visibleIfSlot: "headline" },
  ],
  captions: { enabled: true, fontFamily, fontSizePx: 64, minFontSizePx: 44, maxLines: 2, bold: true, textColor: "#FFFFFF", highlightColor: "#FFD400", outlineColor: "#000000", outlinePx: 5, highlight: "word" },
  audio: { musicBaseDb: -14, musicDuckDb: -26, duckRampMs: 200, loudnessLufs: -14, truePeakDb: -1.5 },
  slots: [
    { key: "headline", kind: "text", label: "Headline", required: false, default: "" },
    { key: "accent", kind: "color", label: "Accent", required: false, default: "#B00020" },
  ],
  fonts: [fontFamily],
});

export type FixtureFiles = { image: string; landscape: string; portraitShort: string; voices: string[]; music: string };

/** Generates tiny synthetic media under `<root>/projects/p/...` (relative paths returned). Nothing is committed. */
export async function makeFixtures(root: string, voiceSeconds: number[] = [3, 2.5, 3.5]): Promise<FixtureFiles> {
  const dir = join(root, "projects/p");
  await mkdir(dir, { recursive: true });
  const abs = (name: string) => join(dir, name);
  generate(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=1", "-frames:v", "1", abs("still.jpg")]);
  generate(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=5", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", abs("landscape.mp4")]);
  generate(["-f", "lavfi", "-i", "smptebars=size=720x1280:rate=24:duration=1.2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", abs("portrait-short.mp4")]);
  const voices: string[] = [];
  voiceSeconds.forEach((seconds, index) => {
    generate(["-f", "lavfi", "-i", `sine=frequency=${220 + index * 60}:sample_rate=44100:duration=${seconds}`, "-af", "volume=0.5", "-c:a", "libmp3lame", abs(`voice${index}.mp3`)]);
    voices.push(`projects/p/voice${index}.mp3`);
  });
  generate(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=4", "-af", "volume=0.4", "-ac", "2", abs("music.wav")]);
  return { image: "projects/p/still.jpg", landscape: "projects/p/landscape.mp4", portraitShort: "projects/p/portrait-short.mp4", voices, music: "projects/p/music.wav" };
}

const frames = (ms: number) => Math.round((ms * 60) / 1000);

export type PlanOptions = {
  voiceSeconds?: number[];
  texts?: string[];
  transitions?: Array<ComposeScene["transitionIn"]>;
  withMusic?: boolean;
  params?: Record<string, string>;
  padStartMs?: number;
  padEndMs?: number;
};

/** Builds a valid ComposePlan over the generated fixtures: scene 0 = still image, 1 = landscape video, 2 = short portrait video (held on its last frame). */
export function makePlan(files: FixtureFiles, options: PlanOptions = {}): ComposePlan {
  const voiceSeconds = options.voiceSeconds ?? [3, 2.5, 3.5];
  const padStartFrames = frames(options.padStartMs ?? 250);
  const padEndFrames = frames(options.padEndMs ?? 500);
  const media: Array<{ path: string; kind: "image" | "video" }> = [
    { path: files.image, kind: "image" },
    { path: files.landscape, kind: "video" },
    { path: files.portraitShort, kind: "video" },
  ];
  let cursor = padStartFrames;
  const scenes: ComposeScene[] = voiceSeconds.map((seconds, index) => {
    const durationFrames = frames(seconds * 1000);
    const scene: ComposeScene = {
      sceneId: `scene-${index}`,
      startFrame: cursor,
      durationFrames,
      media: { relativePath: media[index % media.length]!.path, kind: media[index % media.length]!.kind, sourceStartMs: null, sourceDurationMs: null },
      voice: { relativePath: files.voices[index]!, durationMs: Math.round(seconds * 1000) },
      text: options.texts?.[index] ?? `Scene ${index + 1} caption text`,
      captionCues: [],
      effectIn: { kind: "none" },
      effectOut: { kind: "none" },
      transitionIn: index === 0 ? { kind: "none", durationMs: 0 } : options.transitions?.[index] ?? { kind: "wipe", durationMs: 400 },
    };
    cursor += durationFrames;
    return scene;
  });
  return {
    canvas: { width: 1080, height: 1920 },
    fps: 60,
    padStartFrames,
    padEndFrames,
    totalFrames: cursor + padEndFrames,
    scenes,
    music: options.withMusic ? { relativePath: files.music, volume: 1 } : null,
    params: options.params ?? {},
  };
}
