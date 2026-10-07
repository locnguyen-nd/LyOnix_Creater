import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLibraryTags } from "@lyonix/domain";
import { MediaLibraryService, type LibraryLedger } from "./media-library.service.js";
import { MediaLibraryPrefetchService, inOffPeakHours, parsePrefetchTargets } from "./media-library-prefetch.service.js";
import { MediaPlanService, SegmentSourceLedger, type MediaPlanScript } from "./media-plan.service.js";
import type { ApifyService } from "./apify.service.js";
import type { PexelsService } from "./pexels.service.js";

// VE2E-135: unit tests with in-memory fakes only (no Apify/Pexels/DB; not evidence of live behaviour).
const NOW = new Date("2026-10-07T18:00:00Z"); // 03:00 JST = inside the default off-peak window (17-21 UTC)
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

type Row = Record<string, any>;
function fakePrisma(rows: Row[]) {
  const matches = (row: Row, where: Row): boolean => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "OR") { if (!(cond as Row[]).some((c) => matches(row, c))) return false; continue; }
      const value = row[key];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        if ("in" in cond && !cond.in.includes(value)) return false;
        if ("gt" in cond && !(value && value > cond.gt)) return false;
        if ("lte" in cond && !(value && value <= cond.lte)) return false;
        if ("gte" in cond && !(value && value >= cond.gte)) return false;
      } else if (value !== cond && !(cond === null && value === undefined)) return false;
    }
    return true;
  };
  return {
    rows,
    mediaAssetVersion: {
      findMany: vi.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
      findFirst: vi.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
      update: vi.fn(async ({ where, data }: any) => { const row = rows.find((r) => r.id === where.id)!; Object.assign(row, data); return row; }),
    },
  };
}
const clip = (id: string, tags: Parameters<typeof buildLibraryTags>[0] | null, extra: Row = {}): Row => ({
  id, projectId: "p1", kind: "video", reusable: true, deletedAt: null, parentMediaAssetVersionId: null, origin: "apify", durationMs: 30_000, checksumSha256: `sum-${id}`,
  retentionClass: "project", expiresAt: null, relativePath: `p1/${id}`, createdAt: new Date(NOW.getTime() - 1000), provenance: tags ? { library: buildLibraryTags({ now: new Date(NOW.getTime() - 5000), ...tags }) } : {}, ...extra,
});
const ledgerOf = (): LibraryLedger => ({ jobKey: "job-now", assetIds: new Set(), externalIds: new Set(), apifyPlainIds: new Set() });
const segment = { keywords: { ja: "東京夜景", en: "tokyo night", subject: "Aespa", aliases: ["エスパ"] }, subject: null, durationMs: 8000 };
const matching = { ja: ["東京夜景"], en: ["tokyo night"], subject: "Aespa", aliases: ["エスパ"], externalId: "apify:tiktok:111" };

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); for (const key of Object.keys(process.env)) if (key.startsWith("MEDIA_LIBRARY_")) delete process.env[key]; });

describe("MediaLibraryService.findForSegment (L0)", () => {
  it("empty library -> null (falls to the old tiers)", async () => {
    const service = new MediaLibraryService(fakePrisma([]) as any);
    expect(await service.findForSegment("p1", segment, ledgerOf(), { now: NOW })).toBeNull();
  });

  it("untagged clips are ignored", async () => {
    const service = new MediaLibraryService(fakePrisma([clip("a", null)]) as any);
    expect(await service.findForSegment("p1", segment, ledgerOf(), { now: NOW })).toBeNull();
  });

  it("returns a tagged clip above the threshold, claims it in the ledger, records usage", async () => {
    const prisma = fakePrisma([clip("a", matching)]);
    const service = new MediaLibraryService(prisma as any);
    const ledger = ledgerOf();
    const hit = await service.findForSegment("p1", segment, ledger, { now: NOW });
    expect(hit).toMatchObject({ assetId: "a", score: 1, provider: "apify", externalId: "apify:tiktok:111" });
    expect(ledger.assetIds.has("a")).toBe(true);
    expect(ledger.apifyPlainIds.has("111")).toBe(true);
    expect(prisma.rows[0]!.provenance.library.usages).toEqual([{ jobKey: "job-now", at: NOW.toISOString() }]);
    // A second segment of the same job cannot get the same clip.
    expect(await service.findForSegment("p1", segment, ledger, { now: NOW })).toBeNull();
  });

  it("below the threshold -> null; threshold is env-configurable", async () => {
    const rows = [clip("a", { ja: ["東京夜景"], subject: "Other" })]; // subject mismatch -> 0.25..0.5
    const service = new MediaLibraryService(fakePrisma(rows) as any);
    expect(await service.findForSegment("p1", segment, ledgerOf(), { now: NOW })).toBeNull();
    process.env.MEDIA_LIBRARY_MIN_SCORE = "0.2";
    expect(await service.findForSegment("p1", segment, ledgerOf(), { now: NOW })).not.toBeNull();
  });

  it("picks the best score among several clips", async () => {
    const rows = [clip("weak", { ja: ["東京夜景"], subject: "Aespa" }), clip("best", matching, { checksumSha256: "other" })];
    const hit = await new MediaLibraryService(fakePrisma(rows) as any).findForSegment("p1", segment, ledgerOf(), { now: NOW });
    expect(hit?.assetId).toBe("best");
  });

  it("repeat window: a clip used 3 days ago (or by a recent video) is skipped; checksum repost is skipped; expired window frees it", async () => {
    const used = clip("used", { ...matching, externalId: "apify:tiktok:1" }, { checksumSha256: "dup" });
    used.provenance.library.usages = [{ jobKey: "old-video", at: daysAgo(3) }];
    const repost = clip("repost", { ...matching, externalId: "apify:tiktok:2" }, { checksumSha256: "dup" });
    const service = new MediaLibraryService(fakePrisma([used, repost]) as any);
    expect(await service.findForSegment("p1", segment, ledgerOf(), { now: NOW })).toBeNull();
    // Window shrunk to 0 days / 0 videos -> the old use no longer counts.
    process.env.MEDIA_LIBRARY_REPEAT_DAYS = "0";
    process.env.MEDIA_LIBRARY_REPEAT_VIDEOS = "0";
    expect(await service.findForSegment("p1", segment, ledgerOf(), { now: NOW })).not.toBeNull();
  });

  it("window = last 20 videos: a 30-day-old use still blocks until 20 newer videos exist", async () => {
    const old = clip("old", matching);
    old.provenance.library.usages = [{ jobKey: "j-old", at: daysAgo(30) }];
    const fillers = Array.from({ length: 20 }, (_, i) => {
      const filler = clip(`f${i}`, { ja: ["無関係"], subject: "x" }, { checksumSha256: `f${i}` });
      filler.provenance.library.usages = [{ jobKey: `j${i}`, at: daysAgo(1 + i / 100) }];
      return filler;
    });
    expect(await new MediaLibraryService(fakePrisma([old]) as any).findForSegment("p1", segment, ledgerOf(), { now: NOW })).toBeNull();
    expect((await new MediaLibraryService(fakePrisma([old, ...fillers]) as any).findForSegment("p1", segment, ledgerOf(), { now: NOW }))?.assetId).toBe("old");
  });

  it("VE2E-91 hook: a registered guard can reject a near-duplicate", async () => {
    const service = new MediaLibraryService(fakePrisma([clip("a", matching)]) as any);
    service.registerRepeatGuard(() => true);
    expect(await service.findForSegment("p1", segment, ledgerOf(), { now: NOW })).toBeNull();
  });

  it("image slots, kill switch and errors fall through to null", async () => {
    const service = new MediaLibraryService(fakePrisma([clip("a", matching)]) as any);
    expect(await service.findForSegment("p1", { ...segment, visualKind: "image" }, ledgerOf(), { now: NOW })).toBeNull();
    process.env.MEDIA_LIBRARY_L0 = "0";
    expect(await service.findForSegment("p1", segment, ledgerOf(), { now: NOW })).toBeNull();
    delete process.env.MEDIA_LIBRARY_L0;
    const broken = new MediaLibraryService({ mediaAssetVersion: { findMany: async () => { throw new Error("db down"); } } } as any);
    expect(await broken.findForSegment("p1", segment, ledgerOf(), { now: NOW })).toBeNull();
  });

  it("reusing a working (prefetched) clip extends its TTL by 7 days", async () => {
    const row = clip("w", matching, { retentionClass: "working", expiresAt: new Date(NOW.getTime() + 3600_000) });
    await new MediaLibraryService(fakePrisma([row]) as any).findForSegment("p1", segment, ledgerOf(), { now: NOW });
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
  });
});

describe("MediaLibraryService tagging + TTL sweep", () => {
  it("tagAsset writes ja/en/subject/source/date and, for prefetch, makes the clip a 7-day working asset", async () => {
    const row = clip("n", null, { provenance: { platform: "tiktok", apify: { author: "alice" }, query: "tokyo" } });
    const prisma = fakePrisma([row]);
    const ok = await new MediaLibraryService(prisma as any).tagAsset("n", { ja: ["東京"], en: ["tokyo"], subject: "Aespa", via: "prefetch", costUsd: 0.2 }, { ttl: "working" });
    expect(ok).toBe(true);
    expect(row.provenance.library).toMatchObject({ ja: ["東京"], en: ["tokyo"], subject: "Aespa", source: "tiktok", author: "alice", via: "prefetch", costUsd: 0.2 });
    expect(row.provenance.library.addedAt).toBeTruthy();
    expect(row.retentionClass).toBe("working");
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + 7 * 86_400_000);
  });

  it("tagAsset keeps existing tags and never throws", async () => {
    const row = clip("n", { ja: ["既存"] });
    expect(await new MediaLibraryService(fakePrisma([row]) as any).tagAsset("n", { ja: ["上書き"] })).toBe(true);
    expect(row.provenance.library.ja).toEqual(["既存"]);
    expect(await new MediaLibraryService({ mediaAssetVersion: { findFirst: async () => { throw new Error("x"); } } } as any).tagAsset("n", {})).toBe(false);
  });

  it("sweepExpired removes only expired WORKING library clips (file + soft delete); project clips stay", async () => {
    const root = await mkdtemp(join(tmpdir(), "lib-sweep-"));
    process.env.MEDIA_ROOT = root;
    try {
      const mk = async (id: string) => { await mkdir(join(root, "p1", id), { recursive: true }); await writeFile(join(root, "p1", id, "f.mp4"), "x"); };
      await Promise.all(["exp", "fresh", "proj", "untagged"].map(mk));
      const rows = [
        clip("exp", { ja: ["a"] }, { retentionClass: "working", expiresAt: new Date(NOW.getTime() - 1000) }),
        clip("fresh", { ja: ["a"] }, { retentionClass: "working", expiresAt: new Date(NOW.getTime() + 86_400_000) }),
        clip("proj", { ja: ["a"] }),
        clip("untagged", null, { retentionClass: "working", expiresAt: new Date(NOW.getTime() - 1000) }),
      ];
      const result = await new MediaLibraryService(fakePrisma(rows) as any).sweepExpired(NOW);
      expect(result.removed).toBe(1);
      expect(rows[0]!.deletedAt).toEqual(NOW);
      await expect(stat(join(root, "p1", "exp"))).rejects.toThrow();
      for (const kept of ["fresh", "proj", "untagged"]) await expect(stat(join(root, "p1", kept))).resolves.toBeTruthy();
    } finally {
      delete process.env.MEDIA_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MediaLibraryPrefetchService (never real)", () => {
  const targets = JSON.stringify([{ projectId: "p1", userId: "u1", topics: [{ ja: "東京夜景", en: "tokyo night", subject: "Aespa" }] }]);
  const apifyOk = (n: { v: number }) => ({
    findAccountForUser: vi.fn(async () => ({ id: "acc", encryptedSecret: "enc" })),
    autoImportForSegment: vi.fn(async (_p: string, _u: string, _r: string, _a: unknown, input: any) => {
      n.v += 1;
      input.job.usage.usd += 0.5;
      return { ok: true as const, data: { asset: { id: `new-${n.v}`, kind: "video", durationMs: 9000 }, externalId: `${n.v}`, ledgerId: `apify:tiktok:${n.v}`, provenance: { author: "bob" }, platform: "tiktok", quality: {} } };
    }),
  });
  const build = (apify: any, prisma: any) => {
    const library = new MediaLibraryService(prisma);
    return { service: new MediaLibraryPrefetchService(library, prisma, apify as unknown as ApifyService), library };
  };

  it("is OFF by default: no env -> nothing called", async () => {
    process.env.MEDIA_LIBRARY_PREFETCH_TARGETS = targets;
    const apify = apifyOk({ v: 0 });
    const { service } = build(apify, fakePrisma([]));
    expect(await service.runOnce(NOW)).toMatchObject({ ran: false, reason: "disabled" });
    expect(apify.autoImportForSegment).not.toHaveBeenCalled();
    expect(apify.findAccountForUser).not.toHaveBeenCalled();
  });

  it("does not run in peak hours; off-peak window parsing (wrap-around too)", async () => {
    process.env.MEDIA_LIBRARY_PREFETCH = "1";
    process.env.MEDIA_LIBRARY_PREFETCH_TARGETS = targets;
    const apify = apifyOk({ v: 0 });
    const { service } = build(apify, fakePrisma([]));
    expect(await service.runOnce(new Date("2026-10-07T06:00:00Z"))).toMatchObject({ ran: false, reason: "peak_hours" });
    expect(apify.autoImportForSegment).not.toHaveBeenCalled();
    expect(inOffPeakHours(new Date("2026-10-07T18:00:00Z"), "17-21")).toBe(true);
    expect(inOffPeakHours(new Date("2026-10-07T21:00:00Z"), "17-21")).toBe(false);
    expect(inOffPeakHours(new Date("2026-10-07T01:00:00Z"), "22-3")).toBe(true);
    expect(inOffPeakHours(new Date("2026-10-07T12:00:00Z"), "22-3")).toBe(false);
  });

  it("enabled + off-peak: imports, tags (prefetch, working TTL, cost) and stops at the clips-per-topic cap", async () => {
    process.env.MEDIA_LIBRARY_PREFETCH = "1";
    process.env.MEDIA_LIBRARY_PREFETCH_TARGETS = targets;
    process.env.MEDIA_LIBRARY_PREFETCH_CLIPS_PER_TOPIC = "2";
    const n = { v: 0 };
    const apify = apifyOk(n);
    const rows = [clip("new-1", null, { createdAt: NOW }), clip("new-2", null, { createdAt: NOW })];
    const { service } = build(apify, fakePrisma(rows));
    const summary = await service.runOnce(NOW);
    expect(summary).toMatchObject({ ran: true, imported: 2, usd: 1 });
    expect(apify.autoImportForSegment).toHaveBeenCalledTimes(2);
    expect(rows[0]!.provenance.library).toMatchObject({ via: "prefetch", costUsd: 0.5, subject: "Aespa", author: "bob", externalId: "apify:tiktok:1" });
    expect(rows[0]!.retentionClass).toBe("working");
  });

  it("daily clip cap (counted from tagged clips in the DB) stops the run", async () => {
    process.env.MEDIA_LIBRARY_PREFETCH = "1";
    process.env.MEDIA_LIBRARY_PREFETCH_TARGETS = targets;
    process.env.MEDIA_LIBRARY_PREFETCH_MAX_CLIPS_PER_DAY = "1";
    const done = clip("done", { ja: ["x"], via: "prefetch", costUsd: 0.1 }, { createdAt: new Date("2026-10-07T17:30:00Z") });
    const apify = apifyOk({ v: 0 });
    const summary = await build(apify, fakePrisma([done])).service.runOnce(NOW);
    expect(summary).toMatchObject({ imported: 0, reason: "clip_cap" });
    expect(apify.autoImportForSegment).not.toHaveBeenCalled();
  });

  it("daily cost cap stops further clips once spend reaches it", async () => {
    process.env.MEDIA_LIBRARY_PREFETCH = "1";
    process.env.MEDIA_LIBRARY_PREFETCH_TARGETS = targets;
    process.env.MEDIA_LIBRARY_PREFETCH_CLIPS_PER_TOPIC = "5";
    process.env.MEDIA_LIBRARY_PREFETCH_MAX_USD_PER_DAY = "1";
    const n = { v: 0 };
    const apify = apifyOk(n);
    const rows = Array.from({ length: 5 }, (_, i) => clip(`new-${i + 1}`, null, { createdAt: NOW }));
    const summary = await build(apify, fakePrisma(rows)).service.runOnce(NOW);
    expect(summary).toMatchObject({ imported: 2, reason: "cost_cap" }); // 0.5 + 0.5 reaches the 1.0 cap
    expect(apify.autoImportForSegment).toHaveBeenCalledTimes(2);
  });

  it("failed search for a topic does not retry in the same run and never throws; bad targets JSON = no targets", async () => {
    process.env.MEDIA_LIBRARY_PREFETCH = "1";
    process.env.MEDIA_LIBRARY_PREFETCH_TARGETS = targets;
    const apify = { findAccountForUser: vi.fn(async () => ({ id: "a", encryptedSecret: "e" })), autoImportForSegment: vi.fn(async () => { throw new Error("boom"); }) };
    const summary = await build(apify, fakePrisma([])).service.runOnce(NOW);
    expect(summary).toMatchObject({ ran: true, imported: 0, skipped: 1 });
    expect(apify.autoImportForSegment).toHaveBeenCalledTimes(1);
    expect(parsePrefetchTargets("not json")).toEqual([]);
  });
});

describe("L0 inside the ladder (MediaPlanService)", () => {
  const script: MediaPlanScript = {
    language: "ja",
    scenes: [{ sceneId: "s1", narration: "n", screenText: "t", visualQuery: "q", durationHintMs: 5000, voiceDurationMs: 5000 }],
    visualPlan: null,
  };
  const make = (libraryRows: Row[]) => {
    const apify = { findAccountForUser: vi.fn(async () => ({ id: "acc", encryptedSecret: "enc" })), autoImportForSegment: vi.fn(async () => ({ ok: false as const, reason: "apify_no_usable_candidate" })) };
    const pexels = { autoImportForScene: vi.fn(async () => ({ ok: true as const, data: { asset: { id: "pex-asset", kind: "video", durationMs: 30_000 } as any, externalId: "pex-1" } })) };
    const prisma = fakePrisma(libraryRows);
    const library = new MediaLibraryService(prisma as any);
    const service = new MediaPlanService(prisma as any, {} as any, pexels as unknown as PexelsService, apify as unknown as ApifyService, undefined, undefined, library);
    const planOriginal = service.planSegments.bind(service);
    service.planSegments = (s, range) => planOriginal(s, range).map((seg) => ({ ...seg, keywords: segment.keywords }));
    return { service, apify, pexels, prisma };
  };

  it("a library hit is used before any search: no Apify/Pexels call, sourceTier library in diagnostics", async () => {
    const { service, apify, pexels } = make([clip("lib", matching)]);
    const out = await service.sourceSegments("p1", "u1", "admin", { providerAccountId: "pa", script, segments: service.planSegments(script, null), ledger: new SegmentSourceLedger() });
    expect(out.sourced[0]!.source).toMatchObject({ mediaAssetVersionId: "lib", tier: "library", sourcing: "reused" });
    expect(apify.autoImportForSegment).not.toHaveBeenCalled();
    expect(pexels.autoImportForScene).not.toHaveBeenCalled();
    const diagnostics = service.buildBindings(script, out.sourced).diagnostics[0]!;
    expect(diagnostics).toMatchObject({ sourceTier: "library", libraryScore: 1, sourcing: "reused" });
    expect(diagnostics.qualityDegraded).toBeUndefined();
  });

  it("empty library -> the old tiers run (Pexels fallback here), nothing breaks", async () => {
    const { service, pexels } = make([]);
    const out = await service.sourceSegments("p1", "u1", "admin", { providerAccountId: "pa", script, segments: service.planSegments(script, null), ledger: new SegmentSourceLedger() });
    expect(out.sourced[0]!.source).toMatchObject({ tier: "pexels" });
    expect(pexels.autoImportForScene).toHaveBeenCalled();
  });

  it("an imported (non-library) winner gets tagged for next time", async () => {
    const row = clip("pex-asset", null, { origin: "pexels", provenance: {} });
    const { service } = make([row]);
    await service.sourceSegments("p1", "u1", "admin", { providerAccountId: "pa", script, segments: service.planSegments(script, null), ledger: new SegmentSourceLedger() });
    expect(row.provenance.library).toMatchObject({ ja: ["東京夜景"], en: ["tokyo night"], subject: "Aespa", externalId: "pex-1" });
  });
});
