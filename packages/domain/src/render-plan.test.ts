import { describe, expect, it } from "vitest";
import { buildRenderPlan, framesToMs, msToFrames, type RenderPlanSceneInput } from "./render-plan.js";

const scene = (id: string, orderIndex: number, over: Partial<RenderPlanSceneInput> = {}): RenderPlanSceneInput => ({
  sceneId: id,
  orderIndex,
  mediaAssetVersionId: `media-${id}`,
  mediaKind: "image",
  audioAssetVersionId: `audio-${id}`,
  audioDurationMs: 3000,
  fallbackScreenText: `text ${id}`,
  ...over,
});

describe("buildRenderPlan (VE2E-102)", () => {
  it("defaults to 1080x1920 at 60 fps and orders scenes by orderIndex", () => {
    const result = buildRenderPlan({ scenes: [scene("b", 2), scene("a", 1)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.fps).toBe(60);
    expect(result.plan.canvas).toEqual({ width: 1080, height: 1920 });
    expect(result.plan.scenes.map((s) => s.sceneId)).toEqual(["a", "b"]);
    expect(result.plan.scenes.map((s) => s.index)).toEqual([0, 1]);
  });

  it("total duration = sum of voice durations + padding; frames are the source of truth", () => {
    const result = buildRenderPlan({
      scenes: [scene("a", 0, { audioDurationMs: 3333 }), scene("b", 1, { audioDurationMs: 4100 }), scene("c", 2, { audioDurationMs: 2500 })],
      profile: { padStartMs: 500, padEndMs: 1000 },
    });
    if (!result.ok) throw new Error("expected ok");
    const { plan } = result;
    const voiceSum = 3333 + 4100 + 2500;
    expect(Math.abs(plan.totalDurationMs - (voiceSum + 1500))).toBeLessThanOrEqual(100);
    expect(plan.scenes[0]!.startFrame).toBe(msToFrames(500, 60));
    // scenes are contiguous on the frame grid, no gaps/overlaps (no CFR drift)
    for (let i = 1; i < plan.scenes.length; i += 1) {
      expect(plan.scenes[i]!.startFrame).toBe(plan.scenes[i - 1]!.startFrame + plan.scenes[i - 1]!.durationFrames);
    }
    const last = plan.scenes.at(-1)!;
    expect(plan.totalFrames).toBe(last.startFrame + last.durationFrames + plan.padEndFrames);
    expect(plan.totalDurationMs).toBe(framesToMs(plan.totalFrames, 60));
  });

  it("skips excluded scenes and scenes without media, voice or positive duration, and reports them", () => {
    const result = buildRenderPlan({
      scenes: [
        scene("ok", 0),
        scene("ex", 1, { excluded: true }),
        scene("nomedia", 2, { mediaAssetVersionId: null }),
        scene("novoice", 3, { audioAssetVersionId: null }),
        scene("zero", 4, { audioDurationMs: 0 }),
      ],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.scenes.map((s) => s.sceneId)).toEqual(["ok"]);
    expect(result.skippedSceneIds).toEqual(["ex", "nomedia", "novoice", "zero"]);
  });

  it("mixes image and video scenes and keeps the background source range only for video", () => {
    const result = buildRenderPlan({
      scenes: [
        scene("img", 0, { sourceStartMs: 1000, sourceDurationMs: 2000 }),
        scene("vid", 1, { mediaKind: "video", sourceStartMs: 4000, sourceDurationMs: 3000, mediaPrepared: true, segmentId: " seg-1 " }),
        scene("vid2", 2, { mediaKind: "video" }),
      ],
    });
    if (!result.ok) throw new Error("expected ok");
    const [img, vid, vid2] = result.plan.scenes;
    expect(img!.media).toMatchObject({ kind: "image", sourceStartMs: null, sourceDurationMs: null, prepared: false });
    expect(vid!.media).toMatchObject({ kind: "video", sourceStartMs: 4000, sourceDurationMs: 3000, prepared: true });
    expect(vid!.segmentId).toBe("seg-1");
    expect(vid2!.media.sourceStartMs).toBeNull();
  });

  it("uses the Studio override as a single static block and drops voice-timed cues; otherwise clamps cues into the scene", () => {
    const result = buildRenderPlan({
      scenes: [
        scene("o", 0, { screenTextOverride: " typed ", captionSegments: [{ text: "x", startMs: 0, endMs: 100 }] }),
        scene("c", 1, {
          audioDurationMs: 2000,
          captionSegments: [
            { text: "one", startMs: -50, endMs: 900 },
            { text: "  ", startMs: 900, endMs: 1000 },
            { text: "two", startMs: 1000, endMs: 5000 },
            { text: "late", startMs: 4000, endMs: 4500 },
          ],
        }),
      ],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.scenes[0]).toMatchObject({ text: "typed", captionCues: [] });
    const cues = result.plan.scenes[1]!.captionCues;
    expect(cues.map((cue) => cue.text)).toEqual(["one", "two"]);
    expect(cues[0]!.startMs).toBe(0);
    expect(cues[1]!.endMs).toBeLessThanOrEqual(result.plan.scenes[1]!.durationMs);
  });

  it("never gives the first scene an incoming transition and applies the profile default to the rest", () => {
    const result = buildRenderPlan({ scenes: [scene("a", 0), scene("b", 1)], profile: { defaultTransition: { kind: "wipe", durationMs: 400 } } });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.scenes[0]!.transitionIn.kind).toBe("none");
    expect(result.plan.scenes[1]!.transitionIn).toEqual({ kind: "wipe", durationMs: 400 });
  });

  it("keeps a very short voice clip at >= 1 frame", () => {
    const result = buildRenderPlan({ scenes: [scene("a", 0, { audioDurationMs: 3 })] });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.scenes[0]!.durationFrames).toBe(1);
  });

  it("copies option values and template ref; rejects empty plans and bad profiles", () => {
    const ok = buildRenderPlan({ scenes: [scene("a", 0)], optionValues: { accent: "#fff" }, template: { templateSnapshotId: "snap", engine: "lyonix", recipeId: "r", recipeVersion: 1 } });
    if (!ok.ok) throw new Error("expected ok");
    expect(ok.plan.params).toEqual({ accent: "#fff" });
    expect(ok.plan.template).toEqual({ templateSnapshotId: "snap", engine: "lyonix", recipeId: "r", recipeVersion: 1 });
    expect(buildRenderPlan({ scenes: [scene("a", 0, { excluded: true })] })).toMatchObject({ ok: false, code: "NO_RENDERABLE_SCENES" });
    expect(buildRenderPlan({ scenes: [scene("a", 0)], profile: { fps: 0 } })).toMatchObject({ ok: false, code: "INVALID_PROFILE" });
    expect(buildRenderPlan({ scenes: [scene("a", 0)], profile: { canvas: { width: 1081, height: 1920 } } })).toMatchObject({ ok: false, code: "INVALID_PROFILE" });
  });

  it("is deterministic: same input, same plan", () => {
    const input = { scenes: [scene("a", 0), scene("b", 1)] };
    expect(buildRenderPlan(input)).toEqual(buildRenderPlan(input));
  });
});
