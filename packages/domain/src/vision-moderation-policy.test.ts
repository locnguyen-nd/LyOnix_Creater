import { describe, expect, it } from "vitest";
import {
  VISION_HIGH_CONFIDENCE_THRESHOLD,
  VISION_MODERATION_POLICY_VERSION,
  buildModerationAuditEntry,
  decideVisionModeration,
  type VisionModerationRawResult,
} from "./vision-moderation-policy.js";

const raw = (overrides: Partial<VisionModerationRawResult> = {}): VisionModerationRawResult => ({
  safetyFlag: false,
  safetyCategories: [],
  sceneBeatRelevance: 0.8,
  confidence: 0.9,
  notes: "clear scene",
  ...overrides,
});

const base = { provider: "gemini", model: "gemini-2.5-flash", operation: "video_frame_moderation", evidenceRefs: ["req-1"], now: new Date("2026-09-27T00:00:00.000Z") };

describe("decideVisionModeration", () => {
  it("accepts high-confidence safe content, with safety findings kept empty and separate from relevance", () => {
    const result = decideVisionModeration({ ...base, raw: raw({ confidence: 0.95, safetyFlag: false }) });
    expect(result.decision).toBe("accepted");
    expect(result.safetyFindings).toEqual([]);
    expect(result.sceneBeatRelevance).toBe(0.8);
    expect(result.version).toBe(VISION_MODERATION_POLICY_VERSION);
  });

  it("rejects high-confidence unsafe content and carries the safety categories as reason codes", () => {
    const result = decideVisionModeration({ ...base, raw: raw({ safetyFlag: true, confidence: 0.95, safetyCategories: ["explicit_violence"] }) });
    expect(result.decision).toBe("rejected");
    expect(result.reasonCodes).toEqual(["explicit_violence"]);
    expect(result.safetyFindings).toEqual(["explicit_violence"]);
  });

  it("routes low-confidence results to manual_review regardless of the safety flag direction", () => {
    const safeButUnsure = decideVisionModeration({ ...base, raw: raw({ safetyFlag: false, confidence: 0.5 }) });
    expect(safeButUnsure.decision).toBe("manual_review");
    const unsafeButUnsure = decideVisionModeration({ ...base, raw: raw({ safetyFlag: true, confidence: 0.5 }) });
    expect(unsafeButUnsure.decision).toBe("manual_review");
  });

  it("treats the exact threshold boundary as high-confidence (>=), and just below as manual_review", () => {
    const atThreshold = decideVisionModeration({ ...base, raw: raw({ confidence: VISION_HIGH_CONFIDENCE_THRESHOLD }) });
    expect(atThreshold.decision).toBe("accepted");
    const justBelow = decideVisionModeration({ ...base, raw: raw({ confidence: VISION_HIGH_CONFIDENCE_THRESHOLD - 0.01 }) });
    expect(justBelow.decision).toBe("manual_review");
  });

  it("fails closed to manual_review on provider error/timeout/unsupported/malformed (raw: null), never accepts implicitly", () => {
    const result = decideVisionModeration({ ...base, raw: null });
    expect(result).toMatchObject({ decision: "manual_review", confidence: 0, sceneBeatRelevance: null, safetyFindings: [] });
    expect(result.reasonCodes).toContain("provider_error_unsupported_or_unverified");
  });

  it("never returns a fourth decision value", () => {
    const decisions = new Set<string>();
    for (const input of [raw({ safetyFlag: false, confidence: 0.99 }), raw({ safetyFlag: true, confidence: 0.99 }), raw({ confidence: 0.1 })]) {
      decisions.add(decideVisionModeration({ ...base, raw: input }).decision);
    }
    decisions.add(decideVisionModeration({ ...base, raw: null }).decision);
    expect([...decisions].every((d) => d === "accepted" || d === "rejected" || d === "manual_review")).toBe(true);
  });

  it("carries provider/model/operation/version and non-secret evidence references, never raw payload", () => {
    const result = decideVisionModeration({ ...base, raw: raw() });
    expect(result).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash", operation: "video_frame_moderation", evidenceRefs: ["req-1"] });
  });
});

describe("buildModerationAuditEntry", () => {
  it("produces a deterministic, complete audit record for a reviewer override", () => {
    const entry = buildModerationAuditEntry({
      candidateId: "pexels:video:1",
      previousDecision: "manual_review",
      newDecision: "accepted",
      reviewerUserId: "user-1",
      reasonNote: "confirmed safe on manual review",
      now: new Date("2026-09-27T01:00:00.000Z"),
    });
    expect(entry).toEqual({
      candidateId: "pexels:video:1",
      previousDecision: "manual_review",
      newDecision: "accepted",
      reviewerUserId: "user-1",
      reviewedAt: "2026-09-27T01:00:00.000Z",
      reasonNote: "confirmed safe on manual review",
    });
  });
});
