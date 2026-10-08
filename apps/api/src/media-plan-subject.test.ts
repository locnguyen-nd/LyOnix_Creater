import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mainSubjectShare } from "@lyonix/domain";
import { MediaPlanService, SegmentSourceLedger, type MediaPlanScript } from "./media-plan.service.js";
import type { ApifyService } from "./apify.service.js";
import type { PexelsService } from "./pexels.service.js";

// VE2E-89 (CR-MEDIA-SLA §7 "Bổ sung"): every search tier is bound to the video's main subject, the subject share target is applied,
// and a segment without any subject-bound source degrades instead of failing. Unit/integration test with STUBS only: it is not
// evidence of live Apify/Pexels/vision behaviour.
vi.mock("./quarantine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./quarantine.js")>()),
  writeQuarantineFile: vi.fn(async (buffer: Buffer) => ({ quarantineToken: "quarantine-token", sha256: "x", bytes: buffer.byteLength })),
}));

const NAMES = ["山田太郎", "Taro Yamada", "Yamada"];
const mentionsSubject = (text: string) => NAMES.some((name) => text.toLowerCase().includes(name.toLowerCase()));
const projectId = "project-1";

const script = (): MediaPlanScript => ({
  language: "ja",
  scenes: Array.from({ length: 5 }, (_, i) => ({ sceneId: `s${i + 1}`, narration: `n${i}`, screenText: `t${i}`, visualQuery: `q${i + 1}`, durationHintMs: 5000, voiceDurationMs: 5000 })),
  visualPlan: {
    segments: [
      { segmentId: "g1", sceneIds: ["s1"], subject: "山田太郎", priority: 1, keywords: { ja: "決勝ゴール", en: "final goal", jaAll: ["決勝ゴール", "山田太郎 ヘディング"], enAll: ["final goal"], broadEn: ["football stadium"], moodEn: "city night" } },
      { segmentId: "g2", sceneIds: ["s2", "s3", "s4"], subject: "チームメイト", priority: 2, keywords: { ja: "チーム 練習", en: "team training", broadEn: ["football training"], moodEn: "city night" } },
      { segmentId: "g3", sceneIds: ["s5"], subject: "山田太郎", priority: 1, keywords: { ja: "移籍 発表", en: "transfer news", broadEn: ["football transfer"], moodEn: "city night" } },
    ],
    videoSubject: { main: "Taro Yamada", aliases: ["山田太郎", "Yamada"], mustExclude: ["tutorial"] },
  } as never,
});

const hit = (id: string) => ({ ok: true as const, data: { asset: { id: `asset-${id}`, kind: "video", durationMs: 60_000 } as any, externalId: id, ledgerId: `apify:tiktok:${id}`, platform: "tiktok" as const, provenance: null, quality: null } });
const miss = { ok: false as const, reason: "apify_no_usable_candidate" };
const pexelsMiss = { ok: false as const, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" as const, message: "none" };

function setup(apifyImpl: (input: any) => any) {
  const apify = { findAccountForUser: vi.fn(async () => ({ id: "apify-acc", encryptedSecret: "enc" })), autoImportForSegment: vi.fn(async (...args: any[]) => apifyImpl(args[4])) };
  const pexels = { autoImportForScene: vi.fn(async () => pexelsMiss) };
  const media = { registerAsset: vi.fn(async () => ({ id: "brand-bg", kind: "image" })) };
  const service = new MediaPlanService({ mediaAssetVersion: { findFirst: async () => null } } as never, {} as never, pexels as unknown as PexelsService, apify as unknown as ApifyService, undefined, media as never);
  return { service, apify, pexels };
}

describe("VE2E-89 subject-bound sourcing (stubs)", () => {
  beforeEach(() => { process.env.APIFY_VIDEO_PLATFORMS = "tiktok"; process.env.MEDIA_SEGMENT_DEADLINE_MS = "3000"; });
  afterEach(() => { delete process.env.APIFY_VIDEO_PLATFORMS; delete process.env.MEDIA_SEGMENT_DEADLINE_MS; delete process.env.SUBJECT_SHARE_TARGET; });

  it("planSegments applies the subject share target (default 0.6) and carries the subject on every segment", () => {
    const { service } = setup(() => miss);
    const segments = service.planSegments(script(), null);
    expect(mainSubjectShare(segments)).toBeGreaterThanOrEqual(0.6);
    expect(mainSubjectShare(segments)).toBeLessThanOrEqual(0.85);
    for (const segment of segments) expect(segment.keywords).toMatchObject({ subject: "Taro Yamada", aliases: ["山田太郎", "Yamada"], mustExclude: ["tutorial"] });
  });

  it("player-A scenario: ja -> en -> broad -> Pexels -> L4-L6, every tier keyword names the subject, no segment fails the run", async () => {
    // g1: the ja tier wins. g2: ja/en miss, broad wins. g3: every Apify tier + Pexels miss -> degraded ladder.
    const { service, apify, pexels } = setup((input) => {
      if (input.sceneId === "s1" && !input.lang) return hit("v-ja");
      if (input.sceneId !== "s1" && input.sceneId !== "s5" && input.lang === "en" && input.keyword.toLowerCase().includes("football")) return hit("v-broad");
      return miss;
    });
    const planned = service.planSegments(script(), null);
    const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script: script(), segments: planned, ledger: new SegmentSourceLedger(), guaranteeSource: true });
    expect(result.failure).toBeNull();
    expect(result.sourced.every((entry) => entry.source !== null)).toBe(true);
    const bySegment = new Map(result.sourced.map((entry) => [entry.segment.segmentId, entry.source!]));
    expect(bySegment.get("g1")).toMatchObject({ provider: "apify", tier: "ja" });
    expect(bySegment.get("g2")).toMatchObject({ provider: "apify", tier: "broad" });
    expect(bySegment.get("g3")?.degraded).toBeTruthy(); // L4: another window of an earlier clip - flagged, the job still renders
    // Every Apify tier keyword and every Pexels query is bound to the subject (name or alias).
    const apifyCalls = apify.autoImportForSegment.mock.calls.map((call) => (call as any[])[4] as { keyword: string; lang?: string; lenient?: boolean; subjectAliases?: string[] });
    expect(apifyCalls.length).toBeGreaterThanOrEqual(7);
    for (const call of apifyCalls) {
      expect(mentionsSubject(call.keyword)).toBe(true);
      expect(call.lenient).toBeUndefined();
      expect(call.subjectAliases).toEqual(expect.arrayContaining(["山田太郎"]));
    }
    expect(apifyCalls.filter((call) => call.lang === "en").length).toBeGreaterThanOrEqual(2);
    const pexelsQueries = pexels.autoImportForScene.mock.calls.map((call) => ((call as any[])[3] as { query: string }).query);
    expect(pexelsQueries.length).toBeGreaterThan(0);
    for (const query of pexelsQueries) expect(mentionsSubject(query)).toBe(true);
    // The generic mood keyword never leads a search.
    expect([...apifyCalls.map((call) => call.keyword), ...pexelsQueries].some((text) => text === "city night")).toBe(false);
  });

  it("no source anywhere and no clip to reuse: the brand background (L6) keeps the run alive", async () => {
    const { service } = setup(() => miss);
    const result = await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script: script(), segments: service.planSegments(script(), null), ledger: new SegmentSourceLedger(), guaranteeSource: true });
    expect(result.failure).toBeNull();
    expect(result.sourced.every((entry) => entry.source?.degraded === "brand_background")).toBe(true);
  });

  it("Auto swaps the overlay policy and drops the verified gate when vision cannot run (job context)", async () => {
    const { service, apify } = setup(() => hit("v1"));
    await service.sourceSegments(projectId, "u", "staff", { providerAccountId: "p", script: script(), segments: service.planSegments(script(), null).slice(0, 1), ledger: new SegmentSourceLedger(), guaranteeSource: true });
    const job = (apify.autoImportForSegment.mock.calls[0] as any[])[4].job;
    expect(job.overlayPolicy).toBe("swap");
    expect(job.vision.unattended).toBe(true);
  });
});
