import { describe, expect, it } from "vitest";
import { pinterestAdapterStatus, PINTEREST_BLOCKED_REASON } from "./pinterest.js";

describe("pinterestAdapterStatus", () => {
  it("reports a deterministic blocked status instead of a guessed live adapter", () => {
    expect(pinterestAdapterStatus()).toEqual({ provider: "pinterest", implementationStatus: "blocked", reason: PINTEREST_BLOCKED_REASON });
  });

  it("never claims Pinterest is implemented", () => {
    expect(pinterestAdapterStatus().implementationStatus).toBe("blocked");
  });
});
