import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSceneBrief, rankMediaCandidates, type MediaCandidate, type VisionCleanlinessFindings } from "@lyonix/domain";
import { chosenCleanlinessDiagnostics, cleanlinessCheckEnabled } from "./media-cleanliness-diagnostics.js";
import { MediaPlanService, SegmentSourceLedger, type MediaPlanScript } from "./media-plan.service.js";
import type { ApifyService } from "./apify.service.js";
import type { PexelsService } from "./pexels.service.js";

// VE2E-152: cleanliness diagnostics (chosen source, pool rejections, fallback) - STUBS only, not evidence of live vision behaviour.
vi.mock("./quarantine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./quarantine.js")>()),
  writeQuarantineFile: vi.fn(async (buffer: Buffer) => ({ quarantineToken: "quarantine-token", sha256: "x", bytes: buffer.byteLength })),
}));

const clean = (overrides: Partial<VisionCleanlinessFindings> = {}): VisionCleanlinessFindings => ({ textAreaPct: 2, textOverSubject: false, subtitles: false, logo: "none", watermark: false, lowerThird: false, stickers: false, frameTemplate: false, splitScreen: false, socialUi: false, largeOverlay: false, ...overrides });
const candidate = (id: string, cleanliness?: VisionCleanlinessFindings): MediaCandidate => ({
  candidateId: id, source: "apify", externalId: id, mediaType: "video", accessMethod: "api_download", previewUrl: `https://x/${id}.jpg`, durationSeconds: 12, widthPx: 1080, heightPx: 1920, attribution: null,
  provenance: { query: "q", providerAccountId: "a", queriedAt: "2026-10-09T00:00:00.000Z" }, rightsStatus: "owner_accepted_risk", capabilityEvidence: null, metadataScore: 0, descriptorText: "street dance",
  visionFindings: cleanliness ? { decision: "accepted", confidence: 0.9, reasonCodes: [], sceneBeatRelevance: 0.7, safetyFindings: [], provider: "gemini", model: "m", operation: "image_moderation", version: "v", evidenceRefs: [], decidedAt: "2026-10-09T00:00:00.000Z", cleanliness } : null,
  relevanceScore: 0, moderationDecision: cleanliness ? "accepted" : null, eligibility: { autoEligible: true },
});
const brief = deriveSceneBrief({ language: "en", scenes: [{ sceneId: "s1", narration: "street dance", screenText: "", visualQuery: "street dance", durationHintMs: 8000 }] }, 0);

describe("VE2E-152 cleanliness diagnostics", () => {
  afterEach(() => { delete process.env.MEDIA_CLEANLINESS; });

  it("chosen source + the pool's rejections + the fallback message (no clean footage left)", () => {
    const ranked = rankMediaCandidates([candidate("logo", clean({ logo: "small", textAreaPct: 10 })), candidate("ui", clean({ socialUi: true })), candidate("subs", clean({ textAreaPct: 26, subtitles: true }))], brief);
    expect(chosenCleanlinessDiagnostics(ranked, "logo")).toEqual({
      tier: "acceptable", cleanlinessScore: 0.65, textAreaRatio: 0.1, logoDetected: true, watermarkDetected: false, subtitleDetected: false, preEdited: false, editSignals: [], method: "vision",
      fallback: true, rejected: { SOCIAL_UI_OVERLAY: 1 }, message: "Không đủ footage sạch, đang dùng media có overlay nhẹ.",
    });
  });

  it("a clean pick is no fallback; a pool without any evidence gives no diagnostics", () => {
    const ranked = rankMediaCandidates([candidate("raw", clean()), candidate("subs", clean({ subtitles: true }))], brief);
    expect(chosenCleanlinessDiagnostics(ranked, "raw")).toMatchObject({ tier: "clean", fallback: false });
    expect(chosenCleanlinessDiagnostics(rankMediaCandidates([candidate("p")], brief), "p")).toBeUndefined();
  });

  it("MEDIA_CLEANLINESS=0 turns the vision fields off (default on)", () => {
    expect(cleanlinessCheckEnabled()).toBe(true);
    process.env.MEDIA_CLEANLINESS = "0";
    expect(cleanlinessCheckEnabled()).toBe(false);
  });
});

describe("VE2E-152 media plan carries the cleanliness into the segment diagnostics", () => {
  beforeEach(() => { process.env.MEDIA_SEGMENT_DEADLINE_MS = "3000"; });
  afterEach(() => { delete process.env.MEDIA_SEGMENT_DEADLINE_MS; });

  it("a Pexels pick flagged as overlay fallback shows up in the diagnostics with the message", async () => {
    const fallback = chosenCleanlinessDiagnostics(rankMediaCandidates([candidate("logo", clean({ logo: "small", textAreaPct: 10 }))], brief), "logo")!;
    const pexels = { autoImportForScene: vi.fn(async () => ({ ok: true, data: { asset: { id: "px-asset", kind: "video", durationMs: 30_000 }, externalId: "px1", cleanliness: fallback } })) };
    const service = new MediaPlanService({ mediaAssetVersion: { findFirst: async () => null }, providerAccount: { findFirst: async () => null } } as never, {} as never, pexels as unknown as PexelsService, undefined as unknown as ApifyService);
    const script: MediaPlanScript = { language: "en", scenes: [{ sceneId: "s1", narration: "n", screenText: "t", visualQuery: "street dance", durationHintMs: 5000, voiceDurationMs: 5000 }], visualPlan: null };
    const result = await service.sourceSegments("p", "u", "staff", { providerAccountId: "acc", script, segments: service.planSegments(script, null), ledger: new SegmentSourceLedger(), guaranteeSource: true });
    const diagnostics = service.buildBindings(script, result.sourced).diagnostics;
    expect(diagnostics[0]!.cleanliness).toMatchObject({ tier: "acceptable", fallback: true, logoDetected: true, message: "Không đủ footage sạch, đang dùng media có overlay nhẹ." });
  });
});
