import { describe, expect, it } from "vitest";
import { tickLabels } from "./AutoRunTimeline";

const MIN = 60_000;
const from = Date.UTC(2026, 9, 7, 0, 3);

describe("Auto run timeline axis", () => {
  it("keeps the 5 / 10 minute steps for the normal live window", () => {
    const short = tickLabels(from, 30 * MIN);
    expect(short[1]!.at - short[0]!.at).toBe(5 * MIN);
    const hour = tickLabels(from, 67 * MIN);
    expect(hour[1]!.at - hour[0]!.at).toBe(10 * MIN);
  });

  it("widens the step for a window of a day or more, so labels stay readable", () => {
    const day = tickLabels(from, 26 * 60 * MIN);
    expect(day.length).toBeLessThanOrEqual(10);
    expect(day.length).toBeGreaterThan(2);
  });

  it("gives every tick a unique key even when a long window repeats an hh:mm label", () => {
    const week = tickLabels(from, 3 * 24 * 60 * MIN);
    expect(new Set(week.map((tick) => tick.at)).size).toBe(week.length);
  });
});
