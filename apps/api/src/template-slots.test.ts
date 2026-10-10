import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoTemplateSlot, PlannedSegment } from "@lyonix/domain";
import { MediaPlanService, SegmentSourceLedger, claimSameSubjectWindow, providerFailureSummary, type MediaPlanScript, type SegmentSource, type SourcedSegment } from "./media-plan.service.js";
import type { ApifyService } from "./apify.service.js";
import type { PexelsService } from "./pexels.service.js";
import { WorkflowRunnerService } from "./workflow-runner.service.js";

// Run 19db79bb (TEMPLATE_REQUIRED_ASSET_MISSING Image-7.source, Image-10.source): image scenes received a VIDEO window of an earlier clip.
// STUBS only - not evidence of live worker / provider behaviour.
vi.mock("./quarantine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./quarantine.js")>()),
  writeQuarantineFile: vi.fn(async (buffer: Buffer) => ({ quarantineToken: "quarantine-token", sha256: "x", bytes: buffer.byteLength })),
}));

const KINDS = ["image", "video", "video", "image", "video", "video", "image", "video", "video", "image"] as const;
const slots: AutoTemplateSlot[] = KINDS.flatMap((kind, i) => [
  { key: `${kind === "image" ? "Image" : "Video"}-${i + 1}.source`, kind, required: true } as AutoTemplateSlot,
  { key: `Subtitles-${i + 1}.text`, kind: "text", required: true } as AutoTemplateSlot,
]);
const script = (): MediaPlanScript => ({
  language: "ja",
  scenes: KINDS.map((_, i) => ({ sceneId: `scene_${i + 1}`, narration: `n${i + 1}`, screenText: "", visualQuery: "q", durationHintMs: 4000, voiceDurationMs: 4000 })),
  visualPlan: null,
});
const segment = (n: number, kind: "image" | "video"): PlannedSegment => ({ segmentId: `seg-${n}`, sceneIds: [`scene_${n}`], subject: "佐々木朗希", priority: 1, keywords: { ja: "", en: "", subject: "佐々木朗希" }, durationMs: 4000, origin: "fallback", visualKind: kind } as PlannedSegment);
const source = (id: string, kind: "image" | "video", extra: Partial<SegmentSource> = {}): SegmentSource => ({ mediaAssetVersionId: id, kind, durationMs: kind === "video" ? 30_000 : null, externalId: null, sourcing: "imported", provider: "pexels", ...extra });

function service(overrides: { videoFrames?: unknown; media?: unknown; apify?: unknown } = {}) {
  const pexels = { autoImportForScene: vi.fn(async () => ({ ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", message: "none" })) };
  return new MediaPlanService(
    { mediaAssetVersion: { findFirst: async () => null }, providerAccount: { findFirst: async () => null } } as never,
    {} as never,
    pexels as unknown as PexelsService,
    (overrides.apify ?? undefined) as ApifyService | undefined,
    undefined,
    (overrides.media ?? { registerAsset: vi.fn(async () => ({ id: "brand-bg", kind: "image" })) }) as never,
    undefined,
    undefined,
    overrides.videoFrames as never,
  );
}

describe("image slots never get a video window", () => {
  it("claimSameSubjectWindow skips image segments (video segments still reuse the window)", () => {
    const ledger = new SegmentSourceLedger();
    ledger.clips.set("clip-1", { durationMs: 60_000, provider: "pexels", windows: [{ startMs: 0, endMs: 4000 }], subjects: new Set(["佐々木朗希"]) });
    expect(claimSameSubjectWindow(ledger, segment(4, "image"))).toBeNull();
    expect(claimSameSubjectWindow(ledger, segment(5, "video"))?.kind).toBe("video");
  });

  it("the degraded ladder gives an image segment a still frame of a job clip (person footage kept), never a video window", async () => {
    const frames = { framesForAsset: vi.fn(async () => ({ ok: true, frames: [{ mimeType: "image/jpeg", base64: Buffer.from("jpeg").toString("base64") }], reused: false, skippedFrames: 0 })) };
    const media = { registerAsset: vi.fn(async () => ({ id: "still-1", kind: "image" })) };
    const plan = service({ videoFrames: frames, media });
    const ledger = new SegmentSourceLedger();
    ledger.clips.set("clip-person", { durationMs: 60_000, provider: "apify", windows: [], subjects: new Set(), personEvidence: { match: "verified", identityConfidence: 0.9, verificationMethod: "vision", flags: [] } });
    const result = await plan.resolveDegradedSource("p1", "u", "staff", { providerAccountId: "acc", script: script(), segment: segment(4, "image"), ledger });
    expect(result).toMatchObject({ mediaAssetVersionId: "still-1", kind: "image", degraded: "reuse_window", personEvidence: { match: "verified" } });
    expect(frames.framesForAsset).toHaveBeenCalledWith("clip-person", expect.objectContaining({ frameCount: 1 }));
    expect(media.registerAsset).toHaveBeenCalledWith("p1", "u", "staff", expect.objectContaining({ kind: "image", origin: "generated", mimeType: "image/jpeg" }));
  });
});

describe("template slot preflight in the runner", () => {
  const runner = (plan: MediaPlanService, saved: Array<{ key: string; value: unknown }>) => {
    const instance = Object.create(WorkflowRunnerService.prototype) as Record<string, unknown>;
    Object.assign(instance, { mediaPlans: plan, saveStepDiagnostics: async (_run: unknown, key: string, value: unknown) => { saved.push({ key, value }); } });
    return (instance as unknown as { ensureTemplateSlots: (run: unknown, ctx: unknown) => Promise<ReturnType<MediaPlanService["buildBindings"]>> }).ensureTemplateSlots.bind(instance);
  };
  const sourcedWith = (overrides: Record<number, SegmentSource | null>): SourcedSegment[] =>
    KINDS.map((kind, i) => ({ segment: segment(i + 1, kind), source: i + 1 in overrides ? overrides[i + 1]! : source(`a${i + 1}`, kind), errorCode: null }));

  it("scene 7 / 10 carry a video for Image-7 / Image-10 -> a fallback image fills them before the render (required slots all have a source)", async () => {
    const plan = service();
    const fallback = vi.spyOn(plan, "resolveSlotFallback").mockImplementation(async (_p, _u, _r, input) => source(`fix-${input.segment.segmentId}`, input.expectedKind, { degraded: "reuse_window" }));
    const sourced = sourcedWith({ 7: source("v7", "video"), 10: source("v10", "video") });
    const saved: Array<{ key: string; value: unknown }> = [];
    const result = await runner(plan, saved)({ id: "run-1", projectId: "p1" }, { userId: "u", role: "staff", providerAccountId: "acc", planScript: script(), sourced, mediaPlan: plan.buildBindings(script(), sourced), slots, sceneCompositions: 0, orshotPages: null, ledger: new SegmentSourceLedger() });
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(result.scenes.map((scene) => scene.mediaKind)).toEqual([...KINDS]);
    const diag = saved.find((entry) => entry.key === "template_slot_preflight")?.value as { issues: Array<{ slotKey: string }>; fixes: unknown[]; unresolved: unknown[] };
    expect(diag.issues.map((issue) => issue.slotKey)).toEqual(["Image-7.source", "Image-10.source"]);
    expect(diag.unresolved).toEqual([]);
  });

  it("no valid fallback -> TEMPLATE_REQUIRED_ASSET_MISSING with scene + slot, before the gate / render", async () => {
    const plan = service();
    vi.spyOn(plan, "resolveSlotFallback").mockResolvedValue(null);
    const sourced = sourcedWith({ 7: null, 10: source("v10", "video") });
    await expect(
      runner(plan, [])({ id: "run-1", projectId: "p1" }, { userId: "u", role: "staff", providerAccountId: "acc", planScript: script(), sourced, mediaPlan: plan.buildBindings(script(), sourced), slots, sceneCompositions: 0, orshotPages: null, ledger: new SegmentSourceLedger() }),
    ).rejects.toMatchObject({ code: "TEMPLATE_REQUIRED_ASSET_MISSING", message: expect.stringContaining("Cảnh 7 (scene_7) -> Image-7.source: cần ảnh, chưa có media; Cảnh 10 (scene_10) -> Image-10.source: cần ảnh, đang là video") });
  });

  it("a re-composed template (Scene compositions, count differs) has no positional slot to check", async () => {
    const plan = service();
    const sourced = sourcedWith({ 7: source("v7", "video") }).slice(0, 9);
    const saved: Array<{ key: string; value: unknown }> = [];
    const shorter: MediaPlanScript = { ...script(), scenes: script().scenes.slice(0, 9) };
    await runner(plan, saved)({ id: "run-1", projectId: "p1" }, { userId: "u", role: "staff", providerAccountId: "acc", planScript: shorter, sourced, mediaPlan: plan.buildBindings(shorter, sourced), slots, sceneCompositions: 10, orshotPages: null, ledger: new SegmentSourceLedger() });
    expect((saved[0]?.value as { applies: boolean }).applies).toBe(false);
  });
});

describe("Apify quota: the next account is tried; none left is said plainly", () => {
  beforeEach(() => { process.env.APIFY_VIDEO_PLATFORMS = "tiktok"; process.env.MEDIA_SEGMENT_DEADLINE_MS = "3000"; });
  afterEach(() => { delete process.env.APIFY_VIDEO_PLATFORMS; delete process.env.MEDIA_SEGMENT_DEADLINE_MS; });

  it("PROVIDER_QUOTA_EXHAUSTED on account A -> account B is used; later segments skip A", async () => {
    const calls: string[] = [];
    const apify = {
      findAccountForUser: vi.fn(async () => ({ id: "A", encryptedSecret: "a" })),
      findAccountsForUser: vi.fn(async () => [{ id: "A", encryptedSecret: "a" }, { id: "B", encryptedSecret: "b" }]),
      autoImportForSegment: vi.fn(async (...args: unknown[]) => {
        const account = args[3] as { id: string };
        calls.push(account.id);
        return account.id === "A"
          ? { ok: false, reason: "apify_error:PROVIDER_QUOTA_EXHAUSTED" }
          : { ok: true, data: { asset: { id: `asset-${calls.length}`, kind: "video", durationMs: 60_000 }, externalId: `v${calls.length}`, ledgerId: `apify:tiktok:v${calls.length}`, platform: "tiktok", provenance: null, quality: null } };
      }),
    };
    const plan = service({ apify });
    const ledger = new SegmentSourceLedger();
    const s = script();
    const segments: PlannedSegment[] = [
      { segmentId: "g1", sceneIds: ["scene_1"], subject: "佐々木朗希", priority: 1, keywords: { ja: "佐々木朗希 投球", en: "Roki Sasaki pitch", subject: "佐々木朗希" }, durationMs: 4000, origin: "visual_plan" } as PlannedSegment,
    ];
    const result = await plan.sourceSegments("p1", "u", "staff", { providerAccountId: "acc", script: s, segments, ledger, guaranteeSource: true });
    expect(result.sourced[0]?.source?.provider).toBe("apify");
    expect(calls[0]).toBe("A");
    expect(calls).toContain("B");
    expect(ledger.apifyExhausted.has("A")).toBe(true);
  });

  it("every account exhausted -> the reason says so (no person-specific source), and the summary is readable", () => {
    const pieces = [
      { source: source("p1", "video", { fallbackReason: "apify_quota_exhausted_all_accounts" }), errorCode: null },
      { source: source("p2", "video", { fallbackReason: "apify_error:PROVIDER_QUOTA_EXHAUSTED" }), errorCode: null },
    ];
    expect(providerFailureSummary(pieces)).toEqual(["Apify: hết quota (không còn account Apify nào dùng được) - 2 đoạn"]);
  });
});
