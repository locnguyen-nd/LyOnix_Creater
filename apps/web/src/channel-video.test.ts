import { describe, expect, it } from "vitest";
import { channelVideoPath, costPartsOf, formatUsd } from "./channel-video";

describe("formatUsd", () => {
  it("keeps four decimals under ten cents and two decimals from ten cents up", () => {
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(0.0125)).toBe("$0.0125");
    expect(formatUsd(0.0999)).toBe("$0.0999");
    expect(formatUsd(0.1)).toBe("$0.10");
    expect(formatUsd(0.56)).toBe("$0.56");
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(12.345)).toBe("$12.35");
  });
});

describe("costPartsOf", () => {
  it("lists only the recorded parts, in a fixed order, and keeps a recorded zero", () => {
    expect(costPartsOf({ totalUsd: 0.5, renderUsd: 0, contentUsd: null, ttsUsd: 0.03, mediaUsd: 0.47 })).toEqual([
      { key: "render", usd: 0 },
      { key: "tts", usd: 0.03 },
      { key: "media", usd: 0.47 },
    ]);
  });

  it("is empty when nothing was recorded", () => {
    expect(costPartsOf({ totalUsd: null, renderUsd: null, contentUsd: null, ttsUsd: null, mediaUsd: null })).toEqual([]);
  });
});

describe("channelVideoPath", () => {
  it("sends an Auto run to its page and a Studio job to its Studio at the render", () => {
    expect(channelVideoPath({ mode: "auto", jobId: "run-1", renderJobId: "r-1" })).toBe("/video-productions/run-1");
    expect(channelVideoPath({ mode: "manual", jobId: "job-1", renderJobId: "r-1" })).toBe("/jobs/job-1/studio?renderJobId=r-1");
  });
});
