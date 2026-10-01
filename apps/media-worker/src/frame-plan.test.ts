import { describe, expect, it } from "vitest";
import { buildFrameArgs, readJpegSize, sampleTimesMs } from "./frame-plan.js";

describe("sampleTimesMs", () => {
  it("spreads frames evenly inside the guarded default window (skips intro and outro)", () => {
    const times = sampleTimesMs({ sourceDurationMs: 100_000, frameCount: 4 });
    expect(times).toHaveLength(4);
    expect(times[0]!).toBeGreaterThan(5_000); // after the 5% head margin
    expect(times.at(-1)!).toBeLessThan(92_000); // before the 8% tail margin
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(4);
  });

  it("honours an explicit window and never samples past the end", () => {
    const times = sampleTimesMs({ sourceDurationMs: 30_000, frameCount: 3, windowStartMs: 10_000, windowDurationMs: 6_000 });
    expect(times.every((t) => t >= 10_000 && t <= 16_000)).toBe(true);
    const clipped = sampleTimesMs({ sourceDurationMs: 8_000, frameCount: 2, windowStartMs: 6_000, windowDurationMs: 10_000 });
    expect(clipped.every((t) => t <= 7_900)).toBe(true);
  });

  it("returns a single frame for a tiny source and de-duplicates identical points", () => {
    expect(sampleTimesMs({ sourceDurationMs: 150, frameCount: 5 })).toEqual([0]);
    const dense = sampleTimesMs({ sourceDurationMs: 1_000, frameCount: 6 });
    expect(new Set(dense).size).toBe(dense.length);
  });
});

describe("buildFrameArgs", () => {
  it("builds a shell-free, metadata-free single-frame JPEG command scaled down only", () => {
    const args = buildFrameArgs("in.mp4", 12_345, "out.jpg", 640, 8);
    expect(args).toContain("-frames:v");
    expect(args[args.indexOf("-ss") + 1]).toBe("12.345");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale='min(640,iw)':-2");
    expect(args[args.indexOf("-q:v") + 1]).toBe("8");
    expect(args.at(-1)).toBe("out.jpg");
  });
});

describe("readJpegSize", () => {
  it("reads dimensions from a baseline JPEG SOF0 marker", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x80, 0x01, 0xe0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(readJpegSize(jpeg)).toEqual({ width: 480, height: 640 });
  });

  it("returns null for non-JPEG bytes", () => {
    expect(readJpegSize(Buffer.from("not a jpeg at all"))).toBeNull();
  });
});
