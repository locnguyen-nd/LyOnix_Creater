import { describe, expect, it } from "vitest";
import { formatWaited, hasLiveRuns, isQueueSaturated, isSettledRun, isWaitingInQueue, queueOfKind } from "./queue-display";

describe("VE2E-62 queue display helpers", () => {
  it("formats the waiting time compactly and refuses an unknown or future start", () => {
    const now = Date.parse("2026-10-01T10:10:00Z");
    expect(formatWaited("2026-10-01T10:09:15Z", now)).toBe("45s");
    expect(formatWaited("2026-10-01T10:06:55Z", now)).toBe("3m 05s");
    expect(formatWaited("2026-10-01T08:58:00Z", now)).toBe("1h 12m");
    expect(formatWaited(null, now)).toBeNull();
    expect(formatWaited("not-a-date", now)).toBeNull();
    expect(formatWaited("2026-10-01T10:30:00Z", now)).toBeNull();
  });

  it("treats only a ranked draft as waiting in the queue", () => {
    expect(isWaitingInQueue("draft", { queuePosition: 2 })).toBe(true);
    expect(isWaitingInQueue("draft", { queuePosition: null })).toBe(false);
    expect(isWaitingInQueue("voice_generating", { queuePosition: 2 })).toBe(false);
    expect(isWaitingInQueue("draft", undefined)).toBe(false);
  });

  it("keeps polling while any run can still change, and stops once everything is settled", () => {
    expect(isSettledRun("completed")).toBe(true);
    expect(isSettledRun("needs_input")).toBe(true);
    expect(isSettledRun("draft")).toBe(false);
    expect(hasLiveRuns([{ status: "completed" }, { status: "rendering" }])).toBe(true);
    expect(hasLiveRuns([{ status: "completed" }, { status: "failed" }])).toBe(false);
    expect(hasLiveRuns([])).toBe(false);
  });

  it("finds a queue by kind and recognises a saturated one", () => {
    const summary = [
      { kind: "workflow" as const, active: 5, limit: 5, queued: 3 },
      { kind: "render" as const, active: 1, limit: 4, queued: 0 },
    ];
    expect(queueOfKind(summary, "workflow")?.queued).toBe(3);
    expect(queueOfKind(summary, "media")).toBeNull();
    expect(isQueueSaturated(summary[0]!)).toBe(true);
    expect(isQueueSaturated(summary[1]!)).toBe(false);
    expect(isQueueSaturated({ active: 5, limit: 5, queued: 0 })).toBe(false);
  });
});
