import { describe, expect, it } from "vitest";
import type { PlannedSegment } from "@lyonix/domain";
import { SegmentSourceLedger, claimSameSubjectWindow } from "./media-plan.service.js";

const seg = (segmentId: string, subject: string | null, durationMs: number): PlannedSegment => ({ segmentId, sceneIds: [segmentId], subject, priority: 1, keywords: null, durationMs, origin: "visual_plan" });

describe("claimSameSubjectWindow", () => {
  it("gives a same-subject segment a free window of an already chosen clip, never overlapping", () => {
    const ledger = new SegmentSourceLedger();
    ledger.clips.set("clip1", { durationMs: 30_000, provider: "apify", windows: [{ startMs: 1000, endMs: 9000 }], subjects: new Set(["三笘薫"]) });
    const a = claimSameSubjectWindow(ledger, seg("s2", "三笘薫", 8000));
    expect(a).toMatchObject({ mediaAssetVersionId: "clip1", tier: "clip", sourcing: "reused", window: { startMs: 9000, durationMs: 8000 } });
    const b = claimSameSubjectWindow(ledger, seg("s3", "三笘薫", 8000));
    expect(b?.window?.startMs).toBe(17000);
    expect(claimSameSubjectWindow(ledger, seg("s4", "三笘薫", 8000))).toBeNull(); // 25000..28500 (end guard) is too short
  });

  it("does not reuse a clip of another subject or for a segment without subject", () => {
    const ledger = new SegmentSourceLedger();
    ledger.clips.set("clip1", { durationMs: 30_000, provider: "apify", windows: [], subjects: new Set(["a"]) });
    expect(claimSameSubjectWindow(ledger, seg("s2", "b", 5000))).toBeNull();
    expect(claimSameSubjectWindow(ledger, seg("s3", null, 5000))).toBeNull();
  });
});
