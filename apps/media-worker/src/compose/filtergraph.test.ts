import { describe, expect, it } from "vitest";
import type { ComposePlan, ComposeScene } from "@lyonix/media-jobs";
import { buildVideoGraph, filterComplexFileArgs, framesToSeconds, pictureArea, planSceneTimeline, quoteFilterPath } from "./filtergraph.js";
import { testRecipe } from "./test-fixtures.js";

const scene = (id: string, startFrame: number, durationFrames: number, over: Partial<ComposeScene> = {}): ComposeScene => ({
  sceneId: id,
  startFrame,
  durationFrames,
  media: { relativePath: `m/${id}.mp4`, kind: "video", sourceStartMs: null, sourceDurationMs: null },
  voice: { relativePath: `v/${id}.mp3`, durationMs: Math.round((durationFrames * 1000) / 60) },
  text: "",
  captionCues: [],
  effectIn: { kind: "none" },
  effectOut: { kind: "none" },
  transitionIn: { kind: "none", durationMs: 0 },
  ...over,
});

const plan = (scenes: ComposeScene[], padStart = 15, padEnd = 30): ComposePlan => {
  const last = scenes.at(-1)!;
  return { canvas: { width: 1080, height: 1920 }, fps: 60, padStartFrames: padStart, padEndFrames: padEnd, totalFrames: last.startFrame + last.durationFrames + padEnd, scenes, music: null, params: {} };
};

const wipe = (ms: number): ComposeScene["transitionIn"] => ({ kind: "wipe", durationMs: ms });

describe("framesToSeconds", () => {
  it("rounds DOWN to the microsecond so an xfade never starts a frame late", () => {
    expect(framesToSeconds(1)).toBe("0.016666");
    expect(framesToSeconds(183)).toBe("3.050000");
    expect(framesToSeconds(0)).toBe("0.000000");
  });
});

describe("planSceneTimeline", () => {
  it("covers exactly totalFrames: first scene starts at 0, last runs to the tail, transitions extend the outgoing scene by transition+1", () => {
    const p = plan([scene("a", 15, 180), scene("b", 195, 120, { transitionIn: wipe(400) }), scene("c", 315, 150, { transitionIn: wipe(400) })]);
    const tl = planSceneTimeline(p);
    expect(tl.map((t) => [t.visibleFrom, t.visibleTo])).toEqual([
      [0, 195 + 24 + 1],
      [195, 315 + 24 + 1],
      [315, p.totalFrames],
    ]);
    expect(tl.map((t) => t.transition.frames)).toEqual([0, 24, 24]);
    // the last visible frame of the final clip is the video's last frame
    expect(tl.at(-1)!.visibleTo).toBe(p.totalFrames);
  });

  it("uses a hard cut (0 frames) for kind none or zero duration, and caps a transition at half of the shorter neighbour", () => {
    const p = plan([scene("a", 0, 60), scene("b", 60, 30, { transitionIn: wipe(1000) }), scene("c", 90, 100, { transitionIn: { kind: "none", durationMs: 500 } }), scene("d", 190, 100, { transitionIn: wipe(0) })], 0, 0);
    const tl = planSceneTimeline(p);
    expect(tl[1]!.transition.frames).toBe(15); // min(60,30)/2
    expect(tl[2]!.transition.frames).toBe(0);
    expect(tl[3]!.transition.frames).toBe(0);
    expect(tl[0]!.visibleTo).toBe(60 + 15 + 1);
    expect(tl[1]!.visibleTo).toBe(90); // next is a cut: no extension
  });
});

describe("buildVideoGraph", () => {
  const recipe = testRecipe("DejaVu Sans");
  const baseInput = (p: ComposePlan, extra: Partial<Parameters<typeof buildVideoGraph>[0]> = {}) => ({
    plan: p,
    recipe,
    params: { headline: "HEAD", accent: "#112233" },
    mediaPaths: p.scenes.map((s) => `/root/${s.media.relativePath}`),
    overlays: { layerAss: { headline: "layer-headline.ass" }, captionsAss: "captions.ass" },
    fontsDir: null,
    ...extra,
  });

  it("starts each xfade exactly at the next scene's startFrame and joins cuts with concat", () => {
    const p = plan([scene("a", 15, 180), scene("b", 195, 120, { transitionIn: wipe(400) }), scene("c", 315, 150), scene("d", 465, 90, { transitionIn: { kind: "fade", durationMs: 300 } })]);
    const graph = buildVideoGraph(baseInput(p));
    expect(graph.filterComplex).toContain(`xfade=transition=wipeleft:duration=0.400000:offset=${framesToSeconds(195)}[x1]`);
    expect(graph.filterComplex).toContain("[x1][s2]concat=n=2:v=1:a=0[x2]");
    expect(graph.filterComplex).toContain(`xfade=transition=fade:duration=0.300000:offset=${framesToSeconds(465)}[x3]`);
    expect(graph.filterComplex).toMatch(/\[x3\].*\[v\]$/s);
  });

  it("builds image inputs as a 60 fps loop and ranged videos with accurate input seeking; every clip is trimmed to its exact frame count", () => {
    const p = plan([
      scene("a", 15, 90, { media: { relativePath: "m/a.jpg", kind: "image", sourceStartMs: null, sourceDurationMs: null } }),
      scene("b", 105, 90, { media: { relativePath: "m/b.mp4", kind: "video", sourceStartMs: 2000, sourceDurationMs: 1500 } }),
    ]);
    const graph = buildVideoGraph(baseInput(p));
    expect(graph.inputArgs.slice(0, 5)).toEqual(["-loop", "1", "-framerate", "60", "-t"]);
    expect(graph.inputArgs).toContain("-ss");
    const unranged = buildVideoGraph(baseInput(plan([scene("u", 0, 90)], 0, 0)));
    expect(unranged.inputArgs.slice(0, 3)).toEqual(["-stream_loop", "-1", "-i"]); // too-short sources loop instead of freezing
    expect(unranged.filterComplex).not.toContain("tpad");
    expect(graph.inputArgs[graph.inputArgs.indexOf("-ss") + 1]).toBe("2.000");
    expect(graph.filterComplex).toContain(`trim=end_frame=${graph.timeline[0]!.clipFrames}`);
    expect(graph.filterComplex).toMatch(/\[1:v\][^;]*tpad/); // a ranged video holds its last frame when shorter than its scene
    expect(graph.filterComplex).not.toMatch(/\[0:v\][^;]*tpad/); // ...a still does not need it
    expect(graph.filterComplex).toContain("out_color_matrix=bt709:out_range=tv");
  });

  it("zooms still images (alternating direction) unless the Studio option turns the animation off; videos stay still with this recipe", () => {
    const img = (id: string, start: number): ComposeScene => scene(id, start, 120, { media: { relativePath: `m/${id}.jpg`, kind: "image", sourceStartMs: null, sourceDurationMs: null } });
    const p = plan([img("a", 0), img("b", 120)], 0, 0);
    const graph = buildVideoGraph(baseInput(p));
    const [first, second] = graph.filterComplex.split(";\n");
    expect(first).toContain("eval=frame");
    expect(first).toMatch(/1\+0\.06\*t\//); // zoom in
    expect(second).toMatch(/1\+0\.06\*\(1-t\//); // alternate: zoom out
    const off = buildVideoGraph(baseInput(p, { params: { "dynamicStyle.imageAnimation": "none" } }));
    expect(off.filterComplex).not.toContain("eval=frame");
    const vid = buildVideoGraph(baseInput(plan([scene("v", 0, 120)], 0, 0)));
    expect(vid.filterComplex).not.toContain("eval=frame");
  });

  it("freeze guard: a video scene with near-static footage gets a slow zoom (alternating), other video scenes stay as the recipe says", () => {
    const p = plan([scene("v0", 0, 240), scene("v1", 240, 240), scene("v2", 480, 240)], 0, 0);
    const guarded = buildVideoGraph(baseInput(p, { staticScenes: new Set([0, 1]) }));
    const [s0, s1, s2] = guarded.filterComplex.split(";\n");
    expect(s0).toMatch(/1\+0\.1\*t\//); // zoom in (STATIC_GUARD_INTENSITY: fast enough to move even a smooth, text-less card)
    expect(s1).toMatch(/1\+0\.1\*\(1-t\//); // next static scene zooms out
    expect(s2).not.toContain("eval=frame"); // moving footage is left alone
    expect(buildVideoGraph(baseInput(p)).filterComplex).not.toContain("eval=frame");
  });

  it("freeze guard: a ranged video clearly shorter than its scene (held last frame) is guarded; a few frames short is not", () => {
    const ranged = (id: string, durationMs: number): ComposeScene => scene(id, 0, 240, { media: { relativePath: `m/${id}.mp4`, kind: "video", sourceStartMs: 1000, sourceDurationMs: durationMs } });
    const short = buildVideoGraph(baseInput(plan([ranged("short", 2500)], 0, 0))); // 4 s scene, 2.5 s of footage
    expect(short.filterComplex).toContain("tpad=stop_mode=clone");
    expect(short.filterComplex).toContain("eval=frame");
    const almost = buildVideoGraph(baseInput(plan([ranged("almost", 3800)], 0, 0))); // 200 ms short: rounding, not a visible hold
    expect(almost.filterComplex).not.toContain("eval=frame");
  });

  it("draws boxes with the resolved slot colour, text layers via ASS only when the slot has a value, captions last", () => {
    const p = plan([scene("a", 15, 120)]);
    const graph = buildVideoGraph(baseInput(p, { fontsDir: "C:\\fonts\\jp" }));
    expect(graph.filterComplex).toContain("drawbox=x=0:y=128:w=1080:h=176:color=0x112233@0.9:t=fill");
    expect(graph.filterComplex).toContain("ass=filename=layer-headline.ass:fontsdir='C\\:/fonts/jp'");
    expect(graph.filterComplex.lastIndexOf("ass=filename=captions.ass")).toBeGreaterThan(graph.filterComplex.indexOf("layer-headline.ass"));
    const hidden = buildVideoGraph(baseInput(p, { params: { headline: "", accent: "#112233" }, overlays: { layerAss: {}, captionsAss: null } }));
    expect(hidden.filterComplex).not.toContain("ass=filename");
    expect(hidden.warnings).toEqual([]);
    const badColor = buildVideoGraph(baseInput(p, { params: { headline: "x", accent: "red" } }));
    expect(badColor.filterComplex).toContain("color=0xB00020@0.9"); // falls back to the slot default
  });

  it("applies the background tint once on the composed picture", () => {
    const graph = buildVideoGraph(baseInput(plan([scene("a", 0, 60)], 0, 0)));
    expect(graph.filterComplex.match(/drawbox=x=0:y=0:w=iw:h=ih:color=0x000000@0\.1:t=fill/g)).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("quotes filter paths (backslashes -> slashes, colon escaped)", () => {
    expect(quoteFilterPath("C:\\Users\\me\\fonts")).toBe("'C\\:/Users/me/fonts'");
    expect(quoteFilterPath("/opt/fonts")).toBe("'/opt/fonts'");
  });
  it("selects the graph-file option by FFmpeg major version", () => {
    expect(filterComplexFileArgs("g.txt", "ffmpeg version 6.1.1-3ubuntu5 Copyright")[0]).toBe("-filter_complex_script");
    expect(filterComplexFileArgs("g.txt", "ffmpeg version 7.1.1 Copyright")[0]).toBe("-/filter_complex");
    expect(filterComplexFileArgs("g.txt", "ffmpeg version n8.0 Copyright")[0]).toBe("-/filter_complex");
    expect(filterComplexFileArgs("g.txt", "ffmpeg version N-118000-gabc Copyright")[0]).toBe("-/filter_complex");
    expect(filterComplexFileArgs("g.txt", "ffmpeg version 5.1.2 Copyright")[0]).toBe("-filter_complex_script");
  });
});

describe("band picture area (VE2E-115)", () => {
  const banded = (): ReturnType<typeof testRecipe> => ({
    ...testRecipe("DejaVu Sans"),
    background: { ...testRecipe("DejaVu Sans").background, frame: { mode: "band", heightPct: 44, centerYPct: 50, canvasColor: "#0B0B0B" } },
  });
  it("derives an even-sized band centred on the canvas, and the full canvas without a frame", () => {
    expect(pictureArea(testRecipe("DejaVu Sans"))).toEqual({ width: 1080, height: 1920, y: 0, canvasColor: null });
    const area = pictureArea(banded());
    expect(area).toEqual({ width: 1080, height: 844, y: 538, canvasColor: "#0B0B0B" });
    expect(area.height % 2).toBe(0);
    expect(area.y % 2).toBe(0);
    expect(area.y + area.height).toBeLessThanOrEqual(1920);
  });
  it("scales/crops each scene to the band and pads it onto the canvas colour; the full-bleed graph has no pad", () => {
    const p = plan([scene("a", 15, 180), scene("b", 195, 120, { transitionIn: wipe(400) })]);
    const input = { plan: p, params: {}, mediaPaths: p.scenes.map((s) => `/root/${s.media.relativePath}`), overlays: { layerAss: {}, captionsAss: null }, fontsDir: null };
    const band = buildVideoGraph({ ...input, recipe: banded() }).filterComplex;
    const area = pictureArea(banded());
    expect(band).toContain(`scale=1080:${area.height}:force_original_aspect_ratio=increase`);
    expect(band).toContain(`crop=1080:${area.height}`);
    expect(band).toContain(`pad=1080:1920:0:${area.y}:color=0x0B0B0B`);
    expect(buildVideoGraph({ ...input, recipe: testRecipe("DejaVu Sans") }).filterComplex).not.toContain("pad=1080");
  });
});
