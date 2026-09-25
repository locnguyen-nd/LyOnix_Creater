import { describe, expect, it } from "vitest";
import { isTerminalRenderStatus, nextRenderJobStatus } from "./render-status.js";

describe("nextRenderJobStatus", () => {
  it("moves forward through the progress stages", () => {
    expect(nextRenderJobStatus("accepted", "queued")).toBe("queued");
    expect(nextRenderJobStatus("queued", "rendering")).toBe("rendering");
    expect(nextRenderJobStatus("rendering", "verifying")).toBe("verifying");
  });

  it("drops a stale/out-of-order webhook that regresses progress", () => {
    expect(nextRenderJobStatus("rendering", "queued")).toBeNull();
    expect(nextRenderJobStatus("verifying", "accepted")).toBeNull();
  });

  it("allows a same-rank replay (idempotent duplicate webhook)", () => {
    expect(nextRenderJobStatus("rendering", "rendering")).toBe("rendering");
  });

  it("always applies a terminal status regardless of current progress rank", () => {
    expect(nextRenderJobStatus("accepted", "completed")).toBe("completed");
    expect(nextRenderJobStatus("rendering", "failed")).toBe("failed");
  });

  it("freezes forever once a terminal status is reached (no un-complete / un-fail)", () => {
    expect(nextRenderJobStatus("completed", "rendering")).toBeNull();
    expect(nextRenderJobStatus("completed", "failed")).toBeNull();
    expect(nextRenderJobStatus("failed", "completed")).toBeNull();
    expect(nextRenderJobStatus("cancelled", "completed")).toBeNull();
  });

  it("enters blocked_provider/reconciling side-bands from any non-terminal stage", () => {
    expect(nextRenderJobStatus("queued", "blocked_provider")).toBe("blocked_provider");
    expect(nextRenderJobStatus("rendering", "reconciling")).toBe("reconciling");
  });

  it("leaves a side-band forward into a progress stage", () => {
    expect(nextRenderJobStatus("reconciling", "rendering")).toBe("rendering");
    expect(nextRenderJobStatus("blocked_provider", "queued")).toBe("queued");
  });

  it("does not leave a side-band into an unrecognized status", () => {
    expect(nextRenderJobStatus("reconciling", "reconciling")).toBe("reconciling");
  });

  it("classifies terminal statuses", () => {
    expect(isTerminalRenderStatus("completed")).toBe(true);
    expect(isTerminalRenderStatus("failed")).toBe(true);
    expect(isTerminalRenderStatus("cancelled")).toBe(true);
    expect(isTerminalRenderStatus("rendering")).toBe(false);
  });
});
