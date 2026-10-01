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
  availability: {
    acquireContentRequestSlot: vi.fn(async () => true),
    releaseContentRequestSlot: vi.fn(async () => undefined),
    cooldownContentAccount: vi.fn(async () => new Date()),
    markModelUnusable: vi.fn(async () => undefined),
    markModelLimited: vi.fn(async () => new Date()),
    getModelAvailability: vi.fn(async () => ({ available: true, retryAt: null as Date | null })),
  },
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
    const availability = { ...base(budget, "one").availability, getModelAvailability: vi.fn(async () => ({ available: false, retryAt: new Date(Date.now() + 60_000) })) };
    await moderatePoolWithBudget({ ...base(budget, "one"), moderate, availability });
    expect(moderate).not.toHaveBeenCalled();
    expect(budget.calls).toBe(0);
    expect(budget.skipReasonFor("one")).toBe("vision_skipped_quota");
  });

  it("rotates vision to another model on the same key without cooling script generation", async () => {
    const budget = new VisionBudget({ maxCalls: 4 });
    const input = base(budget, "one");
    const moderate = vi.fn(async ({ modelId }: { modelId: string }) => modelId === "a"
      ? { raw: null, capabilityVerifiedAt: null, evidenceRefs: [], failureCode: "PROVIDER_RATE_LIMITED" as const, quotaScope: "minute" as const }
      : { raw: null, capabilityVerifiedAt: null, evidenceRefs: [] });
    await moderatePoolWithBudget({ ...input, account: { ...input.account, model: "a", models: ["a", "b"] }, moderate });
    expect(moderate.mock.calls.map(([call]) => call.modelId)).toEqual(["a", "b"]);
    expect(input.availability.markModelLimited).toHaveBeenCalledWith("account", "a", 60_000, "PROVIDER_RATE_LIMITED");
    expect(input.availability.cooldownContentAccount).not.toHaveBeenCalled();
    expect(budget.calls).toBe(4);
  });

  it("VE2E-30: sends every extracted frame of one video in a single request (one verdict, one call)", async () => {
    const budget = new VisionBudget({ maxCalls: 4, maxCandidatesPerSegment: 1 });
    const moderate = vi.fn(async (_input: { frames: unknown[] }) => ({ raw: null, capabilityVerifiedAt: "2026-10-01T00:00:00.000Z", evidenceRefs: [] }));
    const frames = [{ mimeType: "image/jpeg", base64: "AAAA" }, { mimeType: "image/jpeg", base64: "BBBB" }, { mimeType: "image/jpeg", base64: "CCCC" }];
    await moderatePoolWithBudget({ ...base(budget, "video"), fetchFrames: async () => frames, moderate: moderate as never });
    expect(moderate).toHaveBeenCalledTimes(1);
    expect(moderate.mock.calls[0]![0].frames).toEqual(frames);
  });

  it("VE2E-30: a video whose frames cannot be produced keeps its score and spends no vision call", async () => {
    const budget = new VisionBudget({ maxCalls: 4, maxCandidatesPerSegment: 1 });
    const moderate = vi.fn();
    const pool = await moderatePoolWithBudget({ ...base(budget, "video"), fetchFrames: async () => [], moderate: moderate as never });
    expect(moderate).not.toHaveBeenCalled();
    expect(budget.calls).toBe(0);
    expect(pool[0]!.moderationDecision).toBeNull();
  });
});
