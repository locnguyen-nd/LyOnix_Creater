import { describe, expect, it, vi } from "vitest";
import { MediaPlanService } from "./media-plan.service.js";

const build = (selected: { provider: string; enabled: boolean } | null, apifyAccount: object | null) => {
  const prisma = { providerAccount: { findFirst: vi.fn(async () => selected) } };
  const apify = { findAccountForUser: vi.fn(async () => apifyAccount) };
  return new MediaPlanService(prisma as never, {} as never, {} as never, apify as never);
};

describe("MediaPlanService.checkMediaSourcesEnabled (provider on/off switch)", () => {
  it("passes when the chosen Pexels account is on", async () => {
    expect(await build({ provider: "pexels", enabled: true }, null).checkMediaSourcesEnabled("u", "staff", "a")).toEqual({ ok: true });
  });
  it("passes when Pexels is off but an Apify account is on", async () => {
    expect(await build({ provider: "pexels", enabled: false }, { id: "x" }).checkMediaSourcesEnabled("u", "staff", "a")).toEqual({ ok: true });
  });
  it("fails early with a clear code when Pexels and Apify are both off", async () => {
    const result = await build({ provider: "pexels", enabled: false }, null).checkMediaSourcesEnabled("u", "staff", "a");
    expect(result).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
  });
});

describe("Apify as the only source (Pexels off)", () => {
  const script = { language: "ja", scenes: [{ sceneId: "s1", narration: "阪神の引退試合", screenText: "引退試合", visualQuery: "baseball", durationHintMs: 5000 }] } as never;
  const segment = { segmentId: "segment1", sceneIds: ["s1"], durationMs: 5000, subject: "x", priority: 1, keywords: { ja: "阪神 引退試合", en: "baseball" }, visualKind: "video" } as never;
  const run = async (autoImport: ReturnType<typeof vi.fn>) => {
    const prisma = { providerAccount: { findFirst: vi.fn(async () => ({ provider: "pexels", enabled: false, status: "verified", isFake: false })) } };
    const apify = { findAccountForUser: vi.fn(async () => ({ id: "ap", encryptedSecret: "x" })), autoImportForSegment: autoImport };
    const pexels = { autoImportForScene: vi.fn() };
    const service = new MediaPlanService(prisma as never, {} as never, pexels as never, apify as never);
    const ledger = { externalIds: new Set<string>(), apifyPlainIds: new Set<string>(), assetIds: new Set<string>(), add: vi.fn(), release: vi.fn() } as never;
    const outcome = await service.importSegmentSource("p", "u", "staff", { providerAccountId: "px", script, segment, ledger });
    return { outcome, pexels, autoImport };
  };

  it("reports why Apify found nothing (not a misleading Pexels message) and never calls Pexels", async () => {
    const { outcome, pexels } = await run(vi.fn(async () => ({ ok: false, reason: "apify_abstained:no_verified_signal", quality: null })));
    expect(outcome).toMatchObject({ ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" });
    expect((outcome as { message: string }).message).toContain("apify_abstained:no_verified_signal");
    expect(pexels.autoImportForScene).not.toHaveBeenCalled();
  });

  it("lets Apify accept the best metadata-ranked candidate when nothing can replace it", async () => {
    const { autoImport } = await run(vi.fn(async () => ({ ok: false, reason: "x", quality: null })));
    expect(autoImport.mock.calls[0]![4]).toMatchObject({ allowUnverified: true });
  });
});

describe("relaxed en/broad tiers (VE2E-130; replaces the repeated lenient pass)", () => {
  const script = { language: "ja", scenes: [{ sceneId: "s1", narration: "阪神の引退試合", screenText: "引退試合", visualQuery: "baseball", durationHintMs: 5000 }] } as never;
  const segment = { segmentId: "segment1", sceneIds: ["s1"], durationMs: 5000, subject: "x", priority: 1, keywords: { ja: "阪神 引退試合", en: "baseball" }, visualKind: "video" } as never;
  const found = { ok: true, data: { asset: { id: "a1", kind: "video", durationMs: 9000 }, externalId: "v1", ledgerId: "apify:v1", provenance: null, platform: "tiktok", quality: null } };

  const run = async (relaxedWorks: boolean) => {
    const prisma = { providerAccount: { findFirst: vi.fn(async () => ({ provider: "pexels", enabled: false, status: "verified", isFake: false })) } };
    const autoImport = vi.fn(async (...args: unknown[]) => ((args[4] as { lenient?: boolean }).lenient && relaxedWorks ? found : { ok: false, reason: "apify_abstained:below_relevance_threshold", quality: null }));
    const apify = { findAccountForUser: vi.fn(async () => ({ id: "ap", encryptedSecret: "x" })), autoImportForSegment: autoImport };
    const service = new MediaPlanService(prisma as never, {} as never, { autoImportForScene: vi.fn() } as never, apify as never);
    const ledger = { externalIds: new Set<string>(), apifyPlainIds: new Set<string>(), assetIds: new Set<string>(), add: vi.fn(), release: vi.fn() } as never;
    const outcome = await service.importSegmentSource("p", "u", "staff", { providerAccountId: "px", script, segment, ledger });
    return { outcome, autoImport };
  };

  it("the strict ja tier abstains but the relaxed en tier fills the segment in the same race (one call per tier, no repeated pass)", async () => {
    const { outcome, autoImport } = await run(true);
    expect(outcome).toMatchObject({ ok: true, data: { provider: "apify", tier: "en" } });
    const calls = autoImport.mock.calls.map((call) => call[4] as { keyword: string; lenient?: boolean });
    expect(calls.map((c) => [c.keyword, Boolean(c.lenient)])).toEqual([["阪神 引退試合", false], ["baseball", true], ["x", true]]);
  });

  it("when every tier abstains the primary sourcing reports ok:false with the per-tier reasons (Auto then degrades, Studio asks the user)", async () => {
    const { outcome } = await run(false);
    expect(outcome).toMatchObject({ ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", reasons: expect.stringContaining("ja:apify_abstained:below_relevance_threshold") });
  });
});
