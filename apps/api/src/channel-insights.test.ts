import { describe, expect, it } from "vitest";
import { buildChannelInsights, metricGrowth, parsePeriod } from "./channel-insights.js";

describe("channel insights", () => {
  it("defaults unknown periods to 7d", () => {
    expect(parsePeriod("nope")).toBe("7d");
    expect(parsePeriod("1d")).toBe("1d");
  });

  it("does not invent a zero baseline when only one sample exists", () => {
    expect(metricGrowth([{ t: 2_000, v: 40 }], 1_000, 3_000)).toMatchObject({
      current: 40,
      delta: null,
      missingBaseline: true,
    });
  });

  it("computes growth against the last sample at or before the window start", () => {
    const snaps = [
      { metric: "followers", value: 100, availability: "available", capturedAt: "2026-09-01T00:00:00.000Z" },
      { metric: "followers", value: 130, availability: "available", capturedAt: "2026-09-10T00:00:00.000Z" },
      { metric: "likes", value: 10, availability: "available", capturedAt: "2026-09-10T00:00:00.000Z" },
    ];
    const insights = buildChannelInsights({
      snaps,
      scopes: ["user.info.stats", "video.list"],
      period: "7d",
      now: Date.parse("2026-09-10T00:00:00.000Z"),
    });
    const followers = insights.metrics.find((item) => item.id === "followers");
    expect(followers?.current).toBe(130);
    expect(followers?.delta).toBe(30);
    expect(followers?.missingBaseline).toBe(false);
    expect(insights.granted.map((item) => item.scope)).toEqual(["user.info.stats", "video.list"]);
  });
});
