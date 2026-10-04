import type { ComposePlan } from "@lyonix/media-jobs";
import type { RenderRecipe } from "@lyonix/render-recipes";
import { AUDIO_SAMPLE_RATE, SAMPLES_PER_FRAME } from "./filtergraph.js";

/**
 * VE2E-105: pure builder of the audio graph. Voices are laid out sample-exactly on the frame grid (800 samples per frame at 48 kHz /
 * 60 fps): each voice is padded/cut to exactly its scene length, joined by `concat` with head/tail silence, so audio length equals the
 * video length without drift. Music is looped, cut to the total, and ducked by an expression over the (merged) voice windows.
 * Loudness is normalised in two passes (measure, then linear apply) to land within +-1 LU of the target.
 */

export type LoudnormMeasurement = { inputI: number; inputTp: number; inputLra: number; inputThresh: number; targetOffset: number };

export type AudioGraphInput = {
  plan: ComposePlan;
  recipe: RenderRecipe;
  /** Input index of the first voice file (voices are consecutive, one per scene). */
  voiceInputOffset: number;
  /** Input index of the music file, or null. */
  musicInputIndex: number | null;
  /** `measure`: analysis only (prints JSON). A measurement: apply it linearly. `skip`: no normalisation (silent mix). */
  loudnorm: "measure" | LoudnormMeasurement | "skip";
};

const STEREO_FLOAT = `aresample=${AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
const num = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(6));

/** Merges voice windows that touch or overlap, in seconds. */
export function voiceWindowsSeconds(plan: ComposePlan): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  for (const scene of plan.scenes) {
    const start = scene.startFrame / 60;
    const end = (scene.startFrame + scene.durationFrames) / 60;
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1e-9) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }
  return windows;
}

/** `volume` expression: base level, lowered to `duck` while a voice plays, with linear ramps of `rampSec` around each window. */
export function musicVolumeExpression(windows: Array<{ start: number; end: number }>, baseDb: number, duckDb: number, rampSec: number, musicGain: number): string {
  const base = 10 ** (baseDb / 20) * musicGain;
  const duckFactor = 10 ** ((duckDb - baseDb) / 20);
  const bumps = windows.map(({ start, end }) =>
    rampSec > 0 ? `clip(min((t-(${num(start)}-${num(rampSec)}))/${num(rampSec)},((${num(end)}+${num(rampSec)})-t)/${num(rampSec)}),0,1)` : `between(t,${num(start)},${num(end)})`,
  );
  const active = bumps.length === 0 ? "0" : bumps.length === 1 ? bumps[0]! : bumps.reduce((a, b) => `max(${a},${b})`);
  return `${num(base)}*(1-(1-${num(duckFactor)})*${active})`;
}

export function buildAudioGraph(input: AudioGraphInput): { filterComplex: string; totalSamples: number } {
  const { plan, recipe } = input;
  const totalSamples = plan.totalFrames * SAMPLES_PER_FRAME;
  const parts: string[] = [];
  const labels: string[] = [];

  if (plan.padStartFrames > 0) {
    parts.push(`anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo,atrim=end_sample=${plan.padStartFrames * SAMPLES_PER_FRAME},asetpts=PTS-STARTPTS[ah]`);
    labels.push("[ah]");
  }
  plan.scenes.forEach((scene, index) => {
    const samples = scene.durationFrames * SAMPLES_PER_FRAME;
    parts.push(`[${input.voiceInputOffset + index}:a]${STEREO_FLOAT},apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=PTS-STARTPTS[a${index}]`);
    labels.push(`[a${index}]`);
  });
  if (plan.padEndFrames > 0) {
    parts.push(`anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo,atrim=end_sample=${plan.padEndFrames * SAMPLES_PER_FRAME},asetpts=PTS-STARTPTS[at]`);
    labels.push("[at]");
  }
  parts.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[voice]`);

  let mixed = "voice";
  if (input.musicInputIndex !== null && plan.music) {
    const { musicBaseDb, musicDuckDb, duckRampMs } = recipe.audio;
    const expression = musicVolumeExpression(voiceWindowsSeconds(plan), musicBaseDb, musicDuckDb, duckRampMs / 1000, plan.music.volume);
    parts.push(`[${input.musicInputIndex}:a]${STEREO_FLOAT},atrim=end_sample=${totalSamples},asetpts=PTS-STARTPTS,volume='${expression}':eval=frame[music]`);
    parts.push("[voice][music]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]");
    mixed = "mix";
  }

  const { loudnessLufs, truePeakDb } = recipe.audio;
  const target = `I=${loudnessLufs}:TP=${truePeakDb}:LRA=11`;
  let tail: string;
  if (input.loudnorm === "measure") tail = `loudnorm=${target}:print_format=json`;
  else if (input.loudnorm === "skip") tail = "anull";
  else {
    const m = input.loudnorm;
    tail = `loudnorm=${target}:measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true:print_format=json`;
  }
  // loudnorm resamples to 192 kHz internally: bring it back to 48 kHz stereo and pin the exact length
  parts.push(`[${mixed}]${tail},aresample=${AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}[aout]`);
  return { filterComplex: parts.join(";\n"), totalSamples };
}

/** Extracts the measurement JSON block ffmpeg's loudnorm prints at the end of the run; null when absent or the signal is silent (-inf). */
export function parseLoudnormMeasurement(stderr: string): LoudnormMeasurement | null {
  const end = stderr.lastIndexOf("}");
  const start = stderr.lastIndexOf("{", end);
  if (start < 0 || end < start) return null;
  try {
    const json = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const read = (key: string): number => Number(json[key]);
    const measurement: LoudnormMeasurement = {
      inputI: read("input_i"),
      inputTp: read("input_tp"),
      inputLra: read("input_lra"),
      inputThresh: read("input_thresh"),
      targetOffset: read("target_offset"),
    };
    return Object.values(measurement).every((value) => Number.isFinite(value)) ? measurement : null;
  } catch {
    return null;
  }
}
