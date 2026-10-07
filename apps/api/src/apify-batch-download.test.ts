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

// VE2E-132 - batch download of the chosen posts (one Actor run, N postURLs) + search cache TTL. Apify is a local fetch stub: NO live call.
const projectId = "project-1";
const fakeAsset = { id: "asset-1", kind: "video", durationMs: 30_000 } as unknown as MediaAssetVersionSummary;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const item = (id: string) => ({
  id, text: "東京 夜景", textLanguage: "ja", locationMeta: { countryCode: "1861060" }, isAd: false, isSponsored: false, hashtags: [{ name: "夜景" }],
  webVideoUrl: `https://www.tiktok.com/@fake/video/${id}`, authorMeta: { name: "creator" },
  videoMeta: { duration: 30, width: 720, height: 1280, originalCoverUrl: "https://p16-common-sign.tiktokcdn.com/fake.jpeg?x-signature=fake" },
});
const stored = (base: { id: string }) => ({ ...base, mediaUrls: [`https://api.apify.com/v2/key-value-stores/FAKEKV/records/video-${base.id}.mp4`] });

type Stub = ApifyDeps & { runs: Array<{ url: string; body: any }> };
/** Search runs answer from `byKeyword`; postURLs runs answer with a stored file for every requested id except those in `missing`. */
const apifyStub = (byKeyword: Record<string, unknown[]>, opts: { missing?: Set<string>; usd?: number } = {}): Stub => {
  const runs: Stub["runs"] = [];
  const results = new Map<string, unknown[]>();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url.includes("/runs?")) {
      const body = JSON.parse(String(init!.body));
      const id = `run${runs.length + 1}`;
      const items = body.postURLs
        ? (body.postURLs as string[]).map((u) => u.split("/").pop()!).filter((vid) => !opts.missing?.has(vid)).map((vid) => stored(item(vid)))
        : (byKeyword[body.searchQueries[0]] ?? []);
      runs.push({ url, body });
      results.set(id, items);
      return json({ data: { id, status: "READY", defaultDatasetId: `ds${runs.length}` } }, 201);
    }
    const run = /actor-runs\/(run\d+)/.exec(url);
    if (run) return json({ data: { id: run[1], status: "SUCCEEDED", defaultDatasetId: `ds${run[1]!.slice(3)}`, usageTotalUsd: opts.usd ?? 0.02, stats: { runTimeSecs: 10 } } });
    const ds = /datasets\/ds(\d+)\/items/.exec(url);
    if (ds) return json(results.get(`run${ds[1]}`) ?? []);
    throw new Error(`unexpected ${url}`);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined, runs };
};

describe("ApifyService batch download - VE2E-132", () => {
  let root: string;
  let prevRoot: string | undefined;
  let prevKey: string | undefined;
  let media: { registerAsset: ReturnType<typeof vi.fn> };
  let prisma: any;
  let service: ApifyService;
  const account = () => ({ id: "acct-1", encryptedSecret: encryptSecret("stub_apify_token_value_000000") });
  const brief = () => deriveSceneBrief({ language: "ja", scenes: [{ sceneId: "s1", narration: "", screenText: "", visualQuery: "東京 夜景", durationHintMs: 5000 }] }, 0);
  const auto = (over: Record<string, unknown> = {}) => ({ platform: "tiktok" as const, keyword: "東京 夜景", brief: brief(), sceneId: "s1", usedExternalIds: new Set<string>(), scriptLanguage: "ja", segmentDurationSeconds: 10, ...over });
  const makeService = () => new ApifyService(prisma, { forUser: async () => ({ projectIds: [projectId] }) } as any, media as unknown as MediaService);
  const postRuns = (stub: Stub) => stub.runs.filter((r) => r.body.postURLs);
  const search = (svc: ApifyService, keyword: string, download: boolean) => svc.searchRaw(projectId, account(), { platform: "tiktok", keyword, lang: "ja", limit: 20, download });

  beforeEach(async () => {
    process.env.APIFY_TWO_PHASE = "1";
    process.env.APIFY_BATCH_DOWNLOAD = "1";
    process.env.APIFY_BATCH_WINDOW_MS = "40";
    prevKey = process.env.PERSISTENCE_ENCRYPTION_KEY;
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    root = await mkdtemp(join(tmpdir(), "lyonix-apify-b-"));
    prevRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = root;
    media = { registerAsset: vi.fn(async () => fakeAsset) };
    prisma = { project: { findUnique: async () => ({ id: projectId }) }, providerAccount: { findFirst: async () => null }, mediaAssetVersion: { findFirst: vi.fn(async () => null) } };
    service = makeService();
    vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: MP4, mimeType: "video/mp4", finalUrl: "x" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const name of ["APIFY_TWO_PHASE", "APIFY_BATCH_DOWNLOAD", "APIFY_BATCH_WINDOW_MS", "APIFY_BATCH_MAX", "APIFY_CACHE_TTL_MS"]) delete process.env[name];
    process.env.PERSISTENCE_ENCRYPTION_KEY = prevKey;
    if (prevRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  const threeSegments = (job: ApifyJobContext, used: Set<string>) =>
    Promise.all(["a", "b", "c"].map((k) => service.autoImportForSegment(projectId, "u1", "staff", account(), auto({ keyword: `kw-${k}`, sceneId: `s-${k}`, usedExternalIds: used, job }))));
  const seg3 = { "kw-a": [item("1")], "kw-b": [item("2")], "kw-c": [item("3")] };

  it("parallel segments' chosen posts are downloaded by ONE run with N postURLs; each segment gets its own clip; usage counts the batch once", async () => {
    const stub = apifyStub(seg3);
    service.apifyDeps = stub;
    const job = new ApifyJobContext();
    const outcomes = await threeSegments(job, new Set());
    expect(postRuns(stub)).toHaveLength(1);
    expect(postRuns(stub)[0]!.body.postURLs).toHaveLength(3);
    expect(outcomes.map((o) => (o.ok ? o.data.externalId : null)).sort()).toEqual(["1", "2", "3"]);
    expect(job.usage.runs).toBe(4); // 3 searches + 1 batch (not 3 + 3)
    expect(job.usage.usd).toBeCloseTo(0.08);
    expect(media.registerAsset).toHaveBeenCalledTimes(3);
  });

  it("a clip missing from the batch result fails only its own segment (next candidate is tried), the others still import", async () => {
    const stub = apifyStub({ ...seg3, "kw-b": [item("2"), item("22")] }, { missing: new Set(["2"]) });
    service.apifyDeps = stub;
    const used = new Set<string>();
    const outcomes = await threeSegments(new ApifyJobContext(), used);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => (o.ok ? o.data.externalId : null)).sort()).toEqual(["1", "22", "3"]);
    expect(postRuns(stub)).toHaveLength(2); // batch of 3, then the retry of segment b alone
    expect(used.has("2")).toBe(false);
  });

  it("when every candidate of a segment is missing it fails with a phase2 reason (max 2 candidates), without failing the others", async () => {
    const stub = apifyStub({ ...seg3, "kw-b": [item("2"), item("22"), item("23")] }, { missing: new Set(["2", "22", "23"]) });
    service.apifyDeps = stub;
    const outcomes = await threeSegments(new ApifyJobContext(), new Set());
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
    expect(outcomes.find((o) => !o.ok)).toMatchObject({ reason: "apify_phase2_failed:PROVIDER_SCHEMA_INVALID" });
  });

  it("reaching APIFY_BATCH_MAX flushes at once (window would never expire)", async () => {
    process.env.APIFY_BATCH_WINDOW_MS = "600000";
    process.env.APIFY_BATCH_MAX = "3";
    const stub = apifyStub(seg3);
    service.apifyDeps = stub;
    const outcomes = await threeSegments(new ApifyJobContext(), new Set());
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(postRuns(stub)).toHaveLength(1);
  });

  it("segments sourced one after another (window already closed) each get their own run", async () => {
    const stub = apifyStub({ "kw-a": [item("1")], "kw-d": [item("4")] });
    service.apifyDeps = stub;
    const job = new ApifyJobContext();
    const first = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto({ keyword: "kw-a", job }));
    const second = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto({ keyword: "kw-d", job }));
    expect(first.ok && second.ok).toBe(true);
    expect(postRuns(stub)).toHaveLength(2);
  });

  it("APIFY_BATCH_DOWNLOAD off (default): one run per clip, unchanged behaviour", async () => {
    delete process.env.APIFY_BATCH_DOWNLOAD;
    const stub = apifyStub(seg3);
    service.apifyDeps = stub;
    const outcomes = await threeSegments(new ApifyJobContext(), new Set());
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(postRuns(stub)).toHaveLength(3);
    expect(postRuns(stub).every((r) => r.body.postURLs.length === 1)).toBe(true);
  });

  it("a whole-batch failure (input rejected) fails every waiting segment with the provider code", async () => {
    const stub = apifyStub(seg3);
    const base = stub.fetch!;
    stub.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.body && String(init.body).includes("postURLs")) return json({ error: { message: "Input is not valid" } }, 400);
      return base(input, init);
    }) as typeof fetch;
    service.apifyDeps = stub;
    const job = new ApifyJobContext();
    const outcomes = await threeSegments(job, new Set());
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(job.usage.runs).toBe(3); // searches only; the rejected batch never started a run
  });

  describe("search cache TTL (CR 3.2)", () => {
    it("a search-only result is reused for 24 h by default (normalised keyword), then paid again", async () => {
      const stub = apifyStub({ "kw-a": [item("1")] });
      service.apifyDeps = stub;
      await search(service, "kw-a", false);
      const now = Date.now();
      const spy = vi.spyOn(Date, "now").mockReturnValue(now + 23 * 3600_000);
      await search(service, "KW-A  ", false);
      const fresh = makeService();
      fresh.apifyDeps = stub;
      await search(fresh, "kw-a", false); // other process: file cache
      expect(stub.runs).toHaveLength(1);
      spy.mockReturnValue(now + 25 * 3600_000);
      const later = makeService();
      later.apifyDeps = stub;
      await search(later, "kw-a", false);
      expect(stub.runs).toHaveLength(2);
    });

    it("a result carrying download links keeps 15 min", async () => {
      const stub = apifyStub({ "kw-a": [item("1")] });
      service.apifyDeps = stub;
      await search(service, "kw-a", true);
      const now = Date.now();
      const spy = vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
      await search(service, "kw-a", true);
      expect(stub.runs).toHaveLength(1);
      spy.mockReturnValue(now + 20 * 60_000);
      await search(service, "kw-a", true);
      expect(stub.runs).toHaveLength(2);
    });

    it("APIFY_CACHE_TTL_MS=0 disables caching for both kinds", async () => {
      process.env.APIFY_CACHE_TTL_MS = "0";
      const stub = apifyStub({ "kw-z": [item("1")] });
      service.apifyDeps = stub;
      await search(service, "kw-z", false);
      await search(service, "kw-z", false);
      expect(stub.runs).toHaveLength(2);
    });
  });
});
