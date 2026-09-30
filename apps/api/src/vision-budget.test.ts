import { describe, expect, it, vi } from "vitest";
import type { MediaCandidate, SceneBrief } from "@lyonix/domain";
import { VisionBudget, moderatePoolWithBudget, resolveVisionModel } from "./vision-budget.js";

const brief: SceneBrief = {
  sceneId: "scene", beat: "explanation_evidence", language: "vi", entities: [], action: [], setting: [], mood: [],
  exclusions: [], phrases: ["city"], shotIntent: "", verticalOnly: true, targetDurationSeconds: 5,
};
const candidate = (id: string): MediaCandidate => ({
  candidateId: id, source: "pexels", externalId: id, mediaType: "photo", accessMethod: "api_download",
  previewUrl: "https://images.pexels.com/sample.jpg", metadataScore: 0.5, relevanceScore: 0.5,
  attribution: null, provenance: {} as MediaCandidate["provenance"], rightsStatus: "cleared",
  capabilityEvidence: {} as MediaCandidate["capabilityEvidence"], visionFindings: null, moderationDecision: null,
  eligibility: { autoEligible: true },
});
const base = (budget: VisionBudget, scopeKey: string) => ({
  pool: [candidate(scopeKey)], brief, usedExternalIds: new Set<string>(), scopeKey, budget,
  account: { id: "account", provider: "gemini", apiKey: "test", model: "gemini-2.5-flash-lite" },
  sceneContext: { beat: brief.beat, entities: [], action: [], setting: [], mood: [], exclusions: [] },
  fetchFrame: async () => ({ mimeType: "image/jpeg", base64: "AAAA" }),
});

describe("vision job budget", () => {
  it("prefers an explicitly selected discovered model, then a cheap alternative to the script model", () => {
    const models = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    expect(resolveVisionModel(models[0]!, models, models[0])).toBe(models[0]);
    expect(resolveVisionModel(models[0]!, models)).toBe(models[1]);
    expect(resolveVisionModel(models[0]!, models, "unknown")).toBe(models[1]);
  });

  it("reserves the hard call cap across concurrently sourced segments", async () => {
    const budget = new VisionBudget({ maxCalls: 2, maxCandidatesPerSegment: 2 });
    const moderate = vi.fn(async () => ({ raw: null, capabilityVerifiedAt: null, evidenceRefs: [] }));
    await Promise.all(["one", "two"].map((key) => moderatePoolWithBudget({ ...base(budget, key), moderate })));
    expect(moderate).toHaveBeenCalledTimes(1);
    expect(budget.calls).toBe(2);
    expect(budget.skippedSegments).toBe(1);
  });

  it("skips a cooling vision model without spending a call", async () => {
    const budget = new VisionBudget();
    const moderate = vi.fn();
    const availability = { getModelAvailability: vi.fn(async () => ({ available: false, retryAt: new Date(Date.now() + 60_000) })) };
    await moderatePoolWithBudget({ ...base(budget, "one"), moderate, availability });
    expect(moderate).not.toHaveBeenCalled();
    expect(budget.calls).toBe(0);
    expect(budget.skipReasonFor("one")).toBe("vision_skipped_quota");
  });
});
