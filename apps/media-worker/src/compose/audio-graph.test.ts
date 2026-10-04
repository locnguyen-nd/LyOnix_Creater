import { describe, expect, it } from "vitest";
import type { ComposePlan } from "@lyonix/media-jobs";
import { buildAudioGraph, musicVolumeExpression, parseLoudnormMeasurement, voiceWindowsSeconds } from "./audio-graph.js";
import { testRecipe } from "./test-fixtures.js";

const plan = (withMusic: boolean, padStart = 15, padEnd = 30): ComposePlan => {
  const mk = (id: string, startFrame: number, durationFrames: number) => ({
    sceneId: id,
    startFrame,
    durationFrames,
    media: { relativePath: `m/${id}.mp4`, kind: "video" as const, sourceStartMs: null, sourceDurationMs: null },
    voice: { relativePath: `v/${id}.mp3`, durationMs: 1000 },
    text: "",
    captionCues: [],
    effectIn: { kind: "none" as const },
    effectOut: { kind: "none" as const },
    transitionIn: { kind: "none" as const, durationMs: 0 },
  });
  const scenes = [mk("a", padStart, 180), mk("b", padStart + 180, 120)];
  return { canvas: { width: 1080, height: 1920 }, fps: 60, padStartFrames: padStart, padEndFrames: padEnd, totalFrames: padStart + 300 + padEnd, scenes, music: withMusic ? { relativePath: "music.wav", volume: 1 } : null, params: {} };
};

describe("buildAudioGraph", () => {
  const recipe = testRecipe("DejaVu Sans");

  it("lays voices out sample-exactly: 800 samples per frame, head/tail silence, one concat", () => {
    const p = plan(false);
    const { filterComplex, totalSamples } = buildAudioGraph({ plan: p, recipe, voiceInputOffset: 0, musicInputIndex: null, loudnorm: "measure" });
    expect(totalSamples).toBe(p.totalFrames * 800);
    expect(filterComplex).toContain(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${15 * 800}`);
    expect(filterComplex).toContain(`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=${180 * 800},atrim=end_sample=${180 * 800}`);
    expect(filterComplex).toContain("[ah][a0][a1][at]concat=n=4:v=0:a=1[voice]");
    expect(filterComplex).toContain(`atrim=end_sample=${totalSamples}[aout]`);
    expect(filterComplex).not.toContain("amix");
  });

  it("omits head/tail silence when the pads are zero", () => {
    const { filterComplex } = buildAudioGraph({ plan: plan(false, 0, 0), recipe, voiceInputOffset: 0, musicInputIndex: null, loudnorm: "skip" });
    expect(filterComplex).toContain("[a0][a1]concat=n=2:v=0:a=1[voice]");
    expect(filterComplex).not.toContain("anullsrc");
    expect(filterComplex).toContain("anull");
  });

  it("mixes looped music under the voice with a ducking expression and keeps the voice length", () => {
    const p = plan(true);
    const { filterComplex } = buildAudioGraph({ plan: p, recipe, voiceInputOffset: 0, musicInputIndex: 2, loudnorm: "measure" });
    expect(filterComplex).toContain("[2:a]aresample=48000");
    expect(filterComplex).toContain("volume='");
    expect(filterComplex).toContain("eval=frame");
    expect(filterComplex).toContain("[voice][music]amix=inputs=2:duration=first:normalize=0");
  });

  it("applies a measured loudness linearly in pass 2 and measures with JSON output in pass 1", () => {
    const measure = buildAudioGraph({ plan: plan(false), recipe, voiceInputOffset: 0, musicInputIndex: null, loudnorm: "measure" }).filterComplex;
    expect(measure).toContain("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json");
    const apply = buildAudioGraph({ plan: plan(false), recipe, voiceInputOffset: 0, musicInputIndex: null, loudnorm: { inputI: -23.1, inputTp: -4.2, inputLra: 3.5, inputThresh: -33.4, targetOffset: 0.3 } }).filterComplex;
    expect(apply).toContain("measured_I=-23.1:measured_TP=-4.2:measured_LRA=3.5:measured_thresh=-33.4:offset=0.3:linear=true");
    // loudnorm works at 192 kHz internally: the graph must come back to 48 kHz
    expect(apply).toContain("loudnorm=");
    expect(apply.indexOf("aresample=48000", apply.indexOf("loudnorm="))).toBeGreaterThan(0);
  });
});

describe("music ducking", () => {
  it("merges touching voice windows and builds an expression that dips by the configured amount", () => {
    expect(voiceWindowsSeconds(plan(false))).toEqual([{ start: 0.25, end: 5.25 }]);
    const expr = musicVolumeExpression([{ start: 1, end: 5 }], -14, -26, 0.2, 1);
    const evalAt = (t: number): number => {
      const clip = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
      const fn = new Function("t", "min", "max", "clip", "between", `return ${expr};`);
      return fn(t, Math.min, Math.max, clip, (x: number, a: number, b: number) => (x >= a && x <= b ? 1 : 0)) as number;
    };
    const base = 10 ** (-14 / 20);
    expect(evalAt(0)).toBeCloseTo(base, 6); // nobody speaks
    expect(evalAt(3)).toBeCloseTo(10 ** (-26 / 20), 6); // voice playing: 12 dB below the base
    expect(20 * Math.log10(evalAt(3) / base)).toBeCloseTo(-12, 3);
    expect(evalAt(1)).toBeGreaterThan(10 ** (-26 / 20)); // ramp in progress at the window edge
    expect(evalAt(6)).toBeCloseTo(base, 6);
  });

  it("falls back to a hard window without ramps and scales by the plan's music volume", () => {
    const expr = musicVolumeExpression([{ start: 1, end: 2 }], -10, -22, 0, 0.5);
    expect(expr).toContain("between(t,1,2)");
    expect(expr.startsWith(String(10 ** (-10 / 20) * 0.5).slice(0, 6))).toBe(true);
  });
});

describe("parseLoudnormMeasurement", () => {
  const json = `{
\t"input_i" : "-23.45",
\t"input_tp" : "-4.10",
\t"input_lra" : "5.20",
\t"input_thresh" : "-34.00",
\t"output_i" : "-14.00",
\t"target_offset" : "0.50"
}`;
  it("reads the JSON block ffmpeg prints at the end of stderr", () => {
    expect(parseLoudnormMeasurement(`[Parsed_loudnorm_0 @ 0x1] \n${json}`)).toEqual({ inputI: -23.45, inputTp: -4.1, inputLra: 5.2, inputThresh: -34, targetOffset: 0.5 });
  });
  it("returns null for silence (-inf), garbage and empty output", () => {
    expect(parseLoudnormMeasurement(json.replace("-23.45", "-inf"))).toBeNull();
    expect(parseLoudnormMeasurement("no json here")).toBeNull();
    expect(parseLoudnormMeasurement("")).toBeNull();
  });
});
