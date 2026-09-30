import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetVersionSummary } from "@lyonix/contracts";
import type { ApifyDeps } from "@lyonix/providers";
import { deriveSceneBrief } from "@lyonix/domain";
import { ApifyJobContext, ApifyService } from "./apify.service.js";
import type { MediaService } from "./media.service.js";
import { encryptSecret } from "./secret-crypto.js";
import * as safeBinaryFetch from "./safe-binary-fetch.js";

// VE2E-51 - candidate filtering, two-phase flow, library reuse, job dedupe, shared cache. Fixtures use the field shapes of the
// owner-job dataset (VE2E-50 diagnosis) with fake values; the Apify API is a local fetch stub (no live calls).
const projectId = "project-1";
const TOKEN = "stub_apify_token_value_000000";
const fakeAsset = { id: "asset-1", kind: "video", durationMs: 30_000 } as unknown as MediaAssetVersionSummary;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  text: "東京 夜景",
  textLanguage: "ja",
  locationMeta: { countryCode: "1861060" },
  isAd: false,
  isSponsored: false,
  hashtags: [{ name: "夜景" }],
  webVideoUrl: `https://www.tiktok.com/@fake/video/${id}`,
  authorMeta: { name: "creator" },
  videoMeta: { duration: 30, width: 720, height: 1280, originalCoverUrl: "https://p16-common-sign.tiktokcdn.com/fake.jpeg?x-signature=fake" },
  ...over,
});
const stored = (base: Record<string, unknown>) => ({ ...base, mediaUrls: [`https://api.apify.com/v2/key-value-stores/FAKEKV/records/video-${String(base.id)}.mp4`] });

type Stub = ApifyDeps & { runs: Array<{ url: string; body: any }> };
/** Search runs answer from `byKeyword`; runs with `postURLs` answer `post(url)` (`null` = HTTP 400 like an unknown input field). */
const apifyStub = (byKeyword: Record<string, unknown[]>, post?: (url: string) => unknown[] | null, usd = 0.02): Stub => {
  const runs: Stub["runs"] = [];
  const results = new Map<string, unknown[]>();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url.includes("/runs?")) {
      const body = JSON.parse(String(init!.body));
      const id = `run${runs.length + 1}`;
      let items: unknown[];
      if (body.postURLs) {
        const answer = post ? post(body.postURLs[0]) : null;
        if (answer === null) { runs.push({ url, body }); return json({ error: { message: "Input is not valid" } }, 400); }
        items = answer;
      } else {
        const all = byKeyword[body.searchQueries[0]] ?? [];
        items = body.shouldDownloadVideos ? all.map((entry) => stored(entry as Record<string, unknown>)) : all;
      }
      runs.push({ url, body });
      results.set(id, items);
      return json({ data: { id, status: "READY", defaultDatasetId: `ds${runs.length}` } }, 201);
    }
    const run = /actor-runs\/(run\d+)/.exec(url);
    if (run) return json({ data: { id: run[1], status: "SUCCEEDED", defaultDatasetId: `ds${run[1]!.slice(3)}`, usageTotalUsd: usd, stats: { runTimeSecs: 10 } } });
    const ds = /datasets\/ds(\d+)\/items/.exec(url);
    if (ds) return json(results.get(`run${ds[1]}`) ?? []);
    throw new Error(`unexpected ${url}`);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined, runs };
};

describe("ApifyService quality/cost - VE2E-51", () => {
  let root: string;
  let prevRoot: string | undefined;
  let prevKey: string | undefined;
  let media: { registerAsset: ReturnType<typeof vi.fn> };
  let prisma: any;
  let service: ApifyService;
  const account = () => ({ id: "acct-1", encryptedSecret: encryptSecret(TOKEN) });
  const brief = () => deriveSceneBrief({ language: "ja", scenes: [{ sceneId: "s1", narration: "", screenText: "", visualQuery: "東京 夜景", durationHintMs: 5000 }] }, 0);
  const auto = (over: Record<string, unknown> = {}) => ({ platform: "tiktok" as const, keyword: "東京 夜景", brief: brief(), sceneId: "s1", usedExternalIds: new Set<string>(), scriptLanguage: "ja", segmentDurationSeconds: 10, ...over });
  const makeService = () => new ApifyService(prisma, { forUser: async () => ({ projectIds: [projectId] }) } as any, media as unknown as MediaService);

  beforeEach(async () => {
    prevKey = process.env.PERSISTENCE_ENCRYPTION_KEY;
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    root = await mkdtemp(join(tmpdir(), "lyonix-apify-q-"));
    prevRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = root;
    media = { registerAsset: vi.fn(async () => fakeAsset) };
    prisma = { project: { findUnique: async () => ({ id: projectId }) }, providerAccount: { findFirst: async () => null }, mediaAssetVersion: { findFirst: vi.fn(async () => null) } };
    service = makeService();
    vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: MP4, mimeType: "video/mp4", finalUrl: "x" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.APIFY_TWO_PHASE;
    delete process.env.APIFY_TWO_PHASE_FALLBACK;
    process.env.PERSISTENCE_ENCRYPTION_KEY = prevKey;
    if (prevRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("ja script: foreign, ad, template, horizontal and too-short clips are all rejected with reasons -> no candidate (Pexels fallback)", async () => {
    service.apifyDeps = apifyStub({
      "東京 夜景": [
        item("1", { textLanguage: "en", locationMeta: { countryCode: "6252001" } }),
        item("2", { isAd: true }),
        item("3", { text: "Use this template CapCut greenscreen", hashtags: [{ name: "capcut" }] }),
        item("4", { videoMeta: { duration: 30, width: 1280, height: 720 } }),
        item("5", { videoMeta: { duration: 4, width: 720, height: 1280 } }),
        item("6", { textLanguage: "un", locationMeta: undefined }),
      ],
    });
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto());
    expect(outcome).toMatchObject({ ok: false, reason: "apify_no_usable_candidate" });
    if (outcome.ok) return;
    expect(outcome.quality).toMatchObject({ considered: 6, passed: 0 });
    expect(outcome.quality!.rejected).toMatchObject({ language_mismatch: 1, location_not_jp: 1, ad_or_sponsored: 1, template_or_greenscreen: 1, not_vertical: 1, too_short: 1, language_unverified: 1 });
    expect(outcome.quality!.rejectedExamples.length).toBeLessThanOrEqual(5);
    expect(media.registerAsset).not.toHaveBeenCalled();
  });

  it("imports the passing Japanese clip, reports usage from run.usageTotalUsd, and skips a clip an earlier segment reserved", async () => {
    const stub = apifyStub({ "東京 夜景": [item("1"), item("2")] });
    service.apifyDeps = stub;
    const job = new ApifyJobContext();
    const used = new Set<string>(["1"]);
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto({ usedExternalIds: used, job }));
    expect(outcome).toMatchObject({ ok: true, data: { externalId: "2", ledgerId: "apify:tiktok:2", quality: { considered: 2, passed: 1, twoPhase: false } } });
    expect(used.has("2")).toBe(true);
    expect(job.usage).toMatchObject({ runs: 1, seconds: 10, usd: 0.02 });
    expect(media.registerAsset.mock.calls[0]![3]).toMatchObject({ origin: "apify", originalFileName: "apify-tiktok-2.mp4" });
  });

  it("identical (platform, keyword) searches of one job share one Actor run and never pick the same clip, even in parallel", async () => {
    const stub = apifyStub({ "東京 夜景": [item("1"), item("2"), item("3")] });
    service.apifyDeps = stub;
    const job = new ApifyJobContext();
    const used = new Set<string>();
    const outcomes = await Promise.all([1, 2, 3].map(() => service.autoImportForSegment(projectId, "u1", "staff", account(), auto({ usedExternalIds: used, job }))));
    expect(stub.runs).toHaveLength(1);
    const ids = outcomes.map((o) => (o.ok ? o.data.externalId : null));
    expect(new Set(ids).size).toBe(3);
    expect(job.usage.searchesReused).toBe(2);
  });

  it("the search cache is shared through MEDIA_ROOT across service instances (Studio API process and Auto worker)", async () => {
    const first = apifyStub({ "東京 夜景": [item("1")] });
    service.apifyDeps = first;
    expect((await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "東京 夜景" })).ok).toBe(false); // no account row: only to prove access checks stay in front
    const other = makeService();
    other.apifyDeps = first;
    await other.autoImportForSegment(projectId, "u1", "staff", account(), auto());
    const worker = makeService();
    const second = apifyStub({ "東京 夜景": [item("9")] });
    worker.apifyDeps = second;
    // Same account/platform/keyword/limit as `other`'s download search (single-phase): served from the file cache, no run.
    const outcome = await worker.autoImportForSegment(projectId, "u1", "staff", account(), auto());
    expect(second.runs).toHaveLength(0);
    expect(outcome).toMatchObject({ ok: true, data: { externalId: "1", quality: { searchReused: true } } });
  });

  it("reuses an asset of the project library with the same TikTok video id instead of downloading again", async () => {
    prisma.mediaAssetVersion.findFirst = vi.fn(async () => ({ id: "lib-1", kind: "video", durationMs: 33_000 }));
    service.apifyDeps = apifyStub({ "東京 夜景": [item("7")] });
    const job = new ApifyJobContext();
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto({ job }));
    expect(outcome).toMatchObject({ ok: true, data: { asset: { id: "lib-1", durationMs: 33_000 }, externalId: "7", quality: { reusedLibraryAsset: true } } });
    expect(safeBinaryFetch.fetchBinarySafely).not.toHaveBeenCalled();
    expect(media.registerAsset).not.toHaveBeenCalled();
    expect(job.usage.libraryReuses).toBe(1);
    expect(prisma.mediaAssetVersion.findFirst.mock.calls[0]![0].where).toMatchObject({ projectId, originalFileName: { startsWith: "apify-tiktok-7." } });
  });

  describe("two-phase (APIFY_TWO_PHASE=1)", () => {
    beforeEach(() => { process.env.APIFY_TWO_PHASE = "1"; });

    it("phase 1 searches WITHOUT download; phase 2 downloads only the chosen post; usage covers both runs", async () => {
      const stub = apifyStub({ "東京 夜景": [item("1"), item("2")] }, (url) => [stored(item(url.split("/").pop()!))], 0.01);
      service.apifyDeps = stub;
      const job = new ApifyJobContext();
      const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto({ job }));
      expect(stub.runs).toHaveLength(2);
      expect(stub.runs[0]!.body).toMatchObject({ shouldDownloadVideos: false, shouldDownloadCovers: false });
      expect(stub.runs[1]!.body).toMatchObject({ resultsPerPage: 1, shouldDownloadVideos: true });
      expect(stub.runs[1]!.body.postURLs).toHaveLength(1);
      expect(stub.runs[1]!.url).toContain("timeout=240");
      expect(outcome).toMatchObject({ ok: true, data: { quality: { twoPhase: true, phase2: "ok" } } });
      expect(job.usage).toMatchObject({ runs: 2, usd: 0.02 });
      expect(media.registerAsset).toHaveBeenCalledTimes(1);
    });

    it("phase 2 failure falls back to the single-phase download search and still imports", async () => {
      const stub = apifyStub({ "東京 夜景": [item("1")] }, () => null);
      service.apifyDeps = stub;
      const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto());
      expect(outcome).toMatchObject({ ok: true, data: { externalId: "1", quality: { phase2: "fallback_single_phase" } } });
      expect(stub.runs.map((r) => Boolean(r.body.postURLs))).toEqual([false, true, false]);
      expect(stub.runs[2]!.body.shouldDownloadVideos).toBe(true);
    });

    it("with APIFY_TWO_PHASE_FALLBACK=0 a phase-2 failure is a Pexels-fallback reason and releases the reservation", async () => {
      process.env.APIFY_TWO_PHASE_FALLBACK = "0";
      service.apifyDeps = apifyStub({ "東京 夜景": [item("1")] }, () => null);
      const used = new Set<string>();
      const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto({ usedExternalIds: used }));
      expect(outcome).toMatchObject({ ok: false, reason: "apify_phase2_failed:PROVIDER_SCHEMA_INVALID", quality: { phase2: "failed" } });
      expect(used.size).toBe(0);
    });
  });
});
