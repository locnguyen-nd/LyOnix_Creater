import { describe, expect, it } from "vitest";
import { DEFAULT_CLIP_TARGET } from "@lyonix/media-jobs";
import {
  buildCopyArgs,
  decideBarCrop,
  parseCropdetect,
  frameAlignedDurationMs,
  frameCount,
  buildKeyframeProbeArgs,
  buildReencodeArgs,
  buildReencodeFilter,
  checkRange,
  copyIneligibilityReasons,
  parseKeyframePackets,
  parseProbeJson,
  planClip,
  type ProbeInfo,
} from "./clip-plan.js";

const probe = (overrides: Partial<ProbeInfo["video"]> = {}, rest: Partial<Omit<ProbeInfo, "video">> = {}): ProbeInfo => ({
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  durationMs: 30_000,
  startTimeMs: 0,
  audio: { codec: "aac" },
  ...rest,
  video: { codec: "h264", width: 1080, height: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, pixFmt: "yuv420p", fps: 30, ...overrides },
});

const plan = (p: ProbeInfo, keyframesMs: number[] | null, startMs: number, durationMs: number, toleranceMs = 1000, stripAudio = true) =>
  planClip({ probe: p, keyframesMs, startMs, durationMs, stripAudio, target: DEFAULT_CLIP_TARGET, toleranceMs });

describe("parseProbeJson", () => {
  it("reads codec/size/duration/fps/audio and applies rotation to display size", () => {
    const parsed = parseProbeJson(JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "30000/1001", side_data_list: [{ rotation: -90 }] },
        { codec_type: "audio", codec_name: "aac" },
      ],
      format: { format_name: "mov,mp4", duration: "12.345", start_time: "0.021" },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.probe.durationMs).toBe(12_345);
    expect(parsed.probe.startTimeMs).toBe(21);
    expect(parsed.probe.video).toMatchObject({ rotation: 270, displayWidth: 1080, displayHeight: 1920 });
    expect(parsed.probe.video.fps).toBeCloseTo(29.97, 2);
    expect(parsed.probe.audio).toEqual({ codec: "aac" });
  });

  it("ignores cover-art streams and reports missing video / malformed input", () => {
    const coverOnly = parseProbeJson(JSON.stringify({ streams: [{ codec_type: "video", codec_name: "mjpeg", width: 10, height: 10, disposition: { attached_pic: 1 } }], format: { duration: "3" } }));
    expect(coverOnly).toEqual({ ok: false, reason: "no_video_stream" });
    expect(parseProbeJson("not json")).toEqual({ ok: false, reason: "malformed" });
    expect(parseProbeJson(JSON.stringify({ streams: [{ codec_type: "video", width: 2, height: 2 }], format: {} }))).toEqual({ ok: false, reason: "no_duration" });
  });
});

describe("parseKeyframePackets", () => {
  it("keeps only K packets, dedupes, sorts and rebases on container start time", () => {
    const csv = ["2.002000,K__", "2.035000,___", "0.021000,K_", "4.021000,K__", "N/A,K__", "4.021000,K__", ""].join("\n");
    expect(parseKeyframePackets(csv, 21)).toEqual([0, 1981, 4000]);
  });

  it("rounds up so -ss never lands before the keyframe", () => {
    expect(parseKeyframePackets("1.0005,K_", 0)).toEqual([1001]);
    expect(parseKeyframePackets("2.9999999999,K_", 0)).toEqual([3000]);
  });
});

describe("checkRange", () => {
  it("rejects a start beyond the source and overflow above tolerance, clamps small overflow", () => {
    expect(checkRange(10_000, 10_000, 1000, 1000).ok).toBe(false);
    expect(checkRange(10_000, 5000, 6001, 1000).ok).toBe(false);
    expect(checkRange(10_000, 5000, 6000, 1000)).toEqual({ ok: true, availableDurationMs: 5000 });
    expect(checkRange(10_000, 0, 4000, 1000)).toEqual({ ok: true, availableDurationMs: 4000 });
  });
});

describe("planClip — hybrid copy vs re-encode", () => {
  it("copies when source is <=1080p H.264 and the nearest keyframe is within tolerance", () => {
    const result = plan(probe(), [0, 2000, 4000, 6000], 4300, 5000);
    expect(result).toMatchObject({ mode: "copy", cutStartMs: 4000, cutDurationMs: 5000, startDriftMs: -300, durationDriftMs: 0, reencodeReasons: [] });
  });

  it("may snap forward to the next keyframe when it is closer", () => {
    expect(plan(probe(), [0, 5000], 4800, 3000)).toMatchObject({ mode: "copy", cutStartMs: 5000, startDriftMs: 200 });
  });

  it("treats drift exactly at the tolerance as OK and just above as re-encode", () => {
    expect(plan(probe(), [0, 3000], 1000, 2000, 1000).mode).toBe("copy");
    const over = plan(probe(), [0, 3000], 1001, 2000, 1000);
    expect(over.mode).toBe("reencode");
    expect(over.reencodeReasons).toContain("keyframe_start_drift_exceeds_tolerance");
    expect(over).toMatchObject({ cutStartMs: 1001, startDriftMs: 0 });
  });

  it("uses the configured tolerance, not a hard-coded one", () => {
    expect(plan(probe(), [0, 5000], 2500, 2000, 1000).mode).toBe("reencode");
    expect(plan(probe(), [0, 5000], 2500, 2000, 3000).mode).toBe("copy");
    expect(plan(probe(), [0, 5000], 200, 2000, 0).mode).toBe("reencode");
  });

  it("re-encodes when the nearest keyframe is further than tolerance", () => {
    const result = plan(probe({}, { durationMs: 10_000 }), [0, 6000], 4500, 5000, 1000);
    expect(result.mode).toBe("reencode");
    expect(result.reencodeReasons).toEqual(["keyframe_start_drift_exceeds_tolerance"]);
    expect(result.cutDurationMs).toBe(5000);
  });

  it("re-encodes when snapping forward would lose more than tolerance at the source end", () => {
    // start drift +900 is fine, but from 5900 only 4100ms remain of the 5500ms requested (-1400)
    const result = plan(probe({}, { durationMs: 10_000 }), [0, 5900], 5000, 5500, 1000);
    expect(result.mode).toBe("reencode");
    expect(result.reencodeReasons).toEqual(["duration_drift_exceeds_tolerance"]);
    expect(result).toMatchObject({ cutStartMs: 5000, cutDurationMs: 5000, durationDriftMs: -500 });
  });

  it.each([
    ["hevc source", probe({ codec: "hevc" }), "video_codec_hevc"],
    ["4K source", probe({ width: 2160, height: 3840, displayWidth: 2160, displayHeight: 3840 }), "resolution_above_1080p"],
    ["1440p landscape", probe({ width: 2560, height: 1440, displayWidth: 2560, displayHeight: 1440 }), "resolution_above_1080p"],
    ["10-bit", probe({ pixFmt: "yuv420p10le" }), "pix_fmt_yuv420p10le"],
  ])("re-encodes a %s", (_label, source, reason) => {
    const result = plan(source, [0, 2000], 2000, 3000);
    expect(result.mode).toBe("reencode");
    expect(result.reencodeReasons).toContain(reason);
  });

  it("accepts 1080p landscape and smaller H.264 for copy", () => {
    expect(copyIneligibilityReasons(probe({ width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080 }), DEFAULT_CLIP_TARGET, true)).toEqual([]);
    expect(copyIneligibilityReasons(probe({ width: 720, height: 1280, displayWidth: 720, displayHeight: 1280 }), DEFAULT_CLIP_TARGET, true)).toEqual([]);
  });

  it("only cares about audio codec when audio is kept", () => {
    const opus = probe({}, { audio: { codec: "opus" } });
    expect(copyIneligibilityReasons(opus, DEFAULT_CLIP_TARGET, true)).toEqual([]);
    expect(copyIneligibilityReasons(opus, DEFAULT_CLIP_TARGET, false)).toEqual(["audio_codec_opus"]);
  });

  it("re-encodes without a keyframe index", () => {
    expect(plan(probe(), null, 0, 3000).reencodeReasons).toEqual(["no_keyframe_index"]);
    expect(plan(probe(), [], 0, 3000).reencodeReasons).toEqual(["no_keyframe_index"]);
  });
});

describe("FFmpeg argument building", () => {
  const copyPlan = { mode: "copy" as const, reencodeReasons: [], cutStartMs: 4000, cutDurationMs: 5000, startDriftMs: -300, durationDriftMs: 0 };

  it("copy: seeks to the keyframe, stream-copies, strips audio with -an", () => {
    const args = buildCopyArgs(copyPlan, "in.mp4", "out.mp4", true);
    expect(args.join(" ")).toContain("-ss 4.000 -i in.mp4 -t 5.000 -map 0:v:0 -an -c copy");
    expect(args).not.toContain("0:a:0?");
    expect(args.slice(-3)).toEqual(["-f", "mp4", "out.mp4"]);
    expect(args).toContain("+faststart");
  });

  it("copy with audio kept maps the optional first audio stream", () => {
    const args = buildCopyArgs(copyPlan, "in.mp4", "out.mp4", false);
    expect(args).toContain("0:a:0?");
    expect(args).not.toContain("-an");
  });

  it("re-encode: libx264 1080x1920 cover crop, yuv420p, bounded bitrate, -an when stripping", () => {
    const reencodePlan = { ...copyPlan, mode: "reencode" as const, cutStartMs: 4300, startDriftMs: 0 };
    const args = buildReencodeArgs(reencodePlan, "in.mov", "out.mp4", true, DEFAULT_CLIP_TARGET, 60);
    const joined = args.join(" ");
    expect(joined).toContain("-ss 4.300 -i in.mov -t 5.000");
    expect(joined).toContain("-an");
    expect(joined).toContain("-c:v libx264");
    expect(joined).toContain("-pix_fmt yuv420p");
    expect(joined).toContain("-maxrate 4M");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30");
    const withAudio = buildReencodeArgs(reencodePlan, "in.mov", "out.mp4", false, DEFAULT_CLIP_TARGET, 30).join(" ");
    expect(withAudio).toContain("-map 0:a:0? -c:a aac");
    expect(withAudio).not.toContain("-an");
  });

  it("always adds a constant-fps filter (CFR), also for <=30fps and unknown-rate sources", () => {
    expect(buildReencodeFilter(DEFAULT_CLIP_TARGET, 29.97)).toContain("fps=30");
    expect(buildReencodeFilter(DEFAULT_CLIP_TARGET, null)).toContain("fps=30");
  });

  it("keyframe probe is bounded by a read interval around the start", () => {
    const args = buildKeyframeProbeArgs("in.mp4", 20_000, 1000);
    expect(args[args.indexOf("-read_intervals") + 1]).toBe("9.000%31.000");
  });
});

describe("frame-accurate re-encode length", () => {
  it("snaps the cut to a whole number of frames and caps output frames", () => {
    expect(frameCount(7123, 30)).toBe(214);
    expect(frameAlignedDurationMs(7123, 30)).toBe(7133);
    expect(frameCount(1, 30)).toBe(1);
  });
});

describe("bar crop (VE2E-143)", () => {
  const frame = { displayWidth: 1080, displayHeight: 1920 };
  it("parses the last cropdetect suggestion", () => {
    expect(parseCropdetect("... crop=1080:1920:0:0\n... crop=1080:608:0:656\n")).toEqual({ w: 1080, h: 608, x: 0, y: 656 });
    expect(parseCropdetect("no crop here")).toBeNull();
  });
  it("applies a crop that removes letterbox bars and ignores noise", () => {
    expect(decideBarCrop(frame, { w: 1080, h: 608, x: 0, y: 656 })).toEqual({ w: 1080, h: 608, x: 0, y: 656, mode: "blur_fill" }); // 16:9 picture in a 9:16 frame
    expect(decideBarCrop(frame, { w: 1080, h: 200, x: 0, y: 700 })).toBeNull(); // sliver
    expect(decideBarCrop(frame, { w: 1080, h: 1200, x: 0, y: 360 })).toEqual({ w: 1080, h: 1200, x: 0, y: 360, mode: "crop" });
    expect(decideBarCrop(frame, { w: 1080, h: 1900, x: 0, y: 10 })).toBeNull(); // 1 % bars: noise
    expect(decideBarCrop(frame, null)).toBeNull();
    expect(decideBarCrop(frame, { w: 1200, h: 1200, x: 0, y: 0 })).toBeNull(); // outside the frame
  });
  it("puts the bar crop before the cover scale and forces a re-encode", () => {
    const target = { width: 1080, height: 1920, videoCodec: "h264" } as const;
    const filter = buildReencodeFilter(target as never, 30, null, { w: 1080, h: 1200, x: 0, y: 360, mode: "crop" });
    expect(filter.startsWith("crop=1080:1200:0:360,scale=")).toBe(true);
    const probe = { formatName: "mov", durationMs: 20000, startTimeMs: 0, video: { codec: "h264", width: 1080, height: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, pixFmt: "yuv420p", fps: 30, rFps: 30 }, audio: null };
    const plan = planClip({ probe: probe as never, keyframesMs: [0, 2000, 4000], startMs: 2000, durationMs: 2000, stripAudio: true, target: target as never, toleranceMs: 40, barCrop: { w: 1080, h: 1200, x: 0, y: 360, mode: "crop" } });
    expect(plan.mode).toBe("reencode");
    expect(plan.reencodeReasons).toContain("bar_crop");
    expect(buildReencodeFilter(target as never, 30, null, { w: 1080, h: 608, x: 0, y: 656, mode: "blur_fill" })).toContain("boxblur");
  });
});
