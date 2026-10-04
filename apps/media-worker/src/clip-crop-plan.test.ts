import { describe, expect, it } from "vitest";
import { DEFAULT_CLIP_TARGET, type ReframeCropPlan } from "@lyonix/media-jobs";
import { buildAxisExpression, buildImageCropArgs, buildReencodeArgs, buildReencodeFilter, isFullFrameCropPlan, planClip, type ProbeInfo } from "./clip-plan.js";

const probe = (overrides: Partial<ProbeInfo["video"]> = {}): ProbeInfo => ({
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  durationMs: 30_000,
  startTimeMs: 0,
  audio: { codec: "aac" },
  video: { codec: "h264", width: 1080, height: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, pixFmt: "yuv420p", fps: 30, ...overrides },
});

const cropPlan = (keyframes: ReframeCropPlan["keyframes"], overrides: Partial<ReframeCropPlan> = {}): ReframeCropPlan => ({
  version: "crop-plan.v1",
  sourceWidthPx: 1280,
  sourceHeightPx: 720,
  targetWidthPx: 1080,
  targetHeightPx: 1920,
  durationMs: 4000,
  zoomPermille: 1000,
  mode: keyframes.length === 1 ? "static" : "keyframes",
  keyframes,
  primarySubjectId: "s1",
  overlayUnavoidable: false,
  residualOverlayPct: 0,
  subjectCoveragePct: 100,
  ...overrides,
});
const win = (tMs: number, xPx: number, yPx = 0) => ({ tMs, xPx, yPx, widthPx: 405, heightPx: 720 });

describe("crop plan application (VE2E-67)", () => {
  it("static plan -> constant crop then lanczos scale to 1080x1920", () => {
    expect(buildReencodeFilter(DEFAULT_CLIP_TARGET, 30, cropPlan([win(0, 300)]))).toBe("crop=w=405:h=720:x=300:y=0,scale=1080:1920:flags=lanczos,setsar=1");
  });

  it("keyframed plan -> single-quoted piecewise-linear x expression in seconds; constant y stays a plain number", () => {
    const filter = buildReencodeFilter(DEFAULT_CLIP_TARGET, 30, cropPlan([win(0, 0), win(2000, 400), win(3500, 100)]));
    expect(filter).toContain("x='if(lt(t,2),0+(400)*(t-0)/2,if(lt(t,3.5),400+(-300)*(t-2)/1.5,100))'");
    expect(filter).toContain(":y=0,");
    expect(filter).not.toContain("fps");
  });

  it("adds the fps cap after the crop for >30fps sources and skips scale when the window already is 1080x1920", () => {
    const exact = cropPlan([{ tMs: 0, xPx: 100, yPx: 0, widthPx: 1080, heightPx: 1920 }], { sourceWidthPx: 1920, sourceHeightPx: 1920 });
    expect(buildReencodeFilter(DEFAULT_CLIP_TARGET, 60, exact)).toBe("crop=w=1080:h=1920:x=100:y=0,setsar=1,fps=30");
  });

  it("a whole-frame plan keeps the legacy filter byte-for-byte; no plan is unchanged", () => {
    const full = cropPlan([{ tMs: 0, xPx: 0, yPx: 0, widthPx: 1280, heightPx: 720 }]);
    expect(isFullFrameCropPlan(full)).toBe(true);
    const legacy = buildReencodeFilter(DEFAULT_CLIP_TARGET, 30);
    expect(buildReencodeFilter(DEFAULT_CLIP_TARGET, 30, full)).toBe(legacy);
    expect(buildReencodeFilter(DEFAULT_CLIP_TARGET, 30, null)).toBe(legacy);
    expect(legacy).toBe("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1");
  });

  it("buildAxisExpression collapses constant axes and clamps outside the keyframe range", () => {
    expect(buildAxisExpression([{ tMs: 0 }, { tMs: 1000 }], [50, 50])).toBe("50");
    expect(buildAxisExpression([{ tMs: 0 }, { tMs: 1000 }], [10, 30])).toBe("if(lt(t,1),10+(20)*(t-0)/1,30)");
  });

  it("a crop plan that removes pixels forces re-encode even on a copy-eligible source; a whole-frame plan does not", () => {
    const base = { probe: probe(), keyframesMs: [0, 2000, 4000], startMs: 2000, durationMs: 2000, stripAudio: true, target: DEFAULT_CLIP_TARGET, toleranceMs: 1000 } as const;
    expect(planClip({ ...base }).mode).toBe("copy");
    const partial = cropPlan([{ tMs: 0, xPx: 0, yPx: 0, widthPx: 600, heightPx: 1067 }], { sourceWidthPx: 1080, sourceHeightPx: 1920 });
    const forced = planClip({ ...base, cropPlan: partial });
    expect(forced.mode).toBe("reencode");
    expect(forced.reencodeReasons[0]).toBe("crop_plan");
    const full = cropPlan([{ tMs: 0, xPx: 0, yPx: 0, widthPx: 1080, heightPx: 1920 }], { sourceWidthPx: 1080, sourceHeightPx: 1920 });
    expect(planClip({ ...base, cropPlan: full }).mode).toBe("copy");
  });

  it("re-encode args with a plan keep -an when stripping audio and use the crop filter", () => {
    const reencode = planClip({ probe: probe({ codec: "vp9" }), keyframesMs: null, startMs: 0, durationMs: 4000, stripAudio: true, target: DEFAULT_CLIP_TARGET, toleranceMs: 1000 });
    const args = buildReencodeArgs(reencode, "in.webm", "out.mp4", true, DEFAULT_CLIP_TARGET, 30, cropPlan([win(0, 300)]));
    expect(args).toContain("-an");
    expect(args[args.indexOf("-vf") + 1]).toContain("crop=w=405:h=720:x=300:y=0");
  });

  it("still-image args: one mjpeg frame, no audio/metadata, first keyframe window or centre cover", () => {
    const withPlan = buildImageCropArgs("in.png", "out.jpg.partial", DEFAULT_CLIP_TARGET, cropPlan([win(0, 300), win(1000, 500)]));
    expect(withPlan[withPlan.indexOf("-vf") + 1]).toBe("crop=w=405:h=720:x=300:y=0,scale=1080:1920:flags=lanczos,setsar=1");
    expect(withPlan).toEqual(expect.arrayContaining(["-frames:v", "1", "-c:v", "mjpeg", "-an", "-map_metadata", "-1", "-f", "image2"]));
    const cover = buildImageCropArgs("in.png", "out.jpg.partial", DEFAULT_CLIP_TARGET, null);
    expect(cover[cover.indexOf("-vf") + 1]).toBe("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1");
  });
});
