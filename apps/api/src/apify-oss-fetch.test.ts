import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
import type { SocialFetchOutcome, SocialFetchService } from "./social-fetch.service.js";

// VE2E-146 - TikTok phase 2 through yt-dlp (media worker) with Apify as the fallback. Apify is a local fetch stub, the worker a fake: NO live call.
const projectId = "project-1";
/** Quarantine token of the fake download (generated: a literal UUID trips secret scanners). */
const TOKEN = randomUUID();
const fakeAsset = { id: "asset-1", kind: "video", durationMs: 30_000 } as unknown as MediaAssetVersionSummary;
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const item = (id: string) => ({
  id, text: "東京 夜景", textLanguage: "ja", locationMeta: { countryCode: "1861060" }, isAd: false, isSponsored: false, hashtags: [{ name: "夜景" }],
  webVideoUrl: `https://www.tiktok.com/@fake/video/${id}`, authorMeta: { name: "creator" },
  videoMeta: { duration: 30, width: 720, height: 1280, originalCoverUrl: "https://p16-common-sign.tiktokcdn.com/fake.jpeg?x-signature=fake" },
});

type Stub = ApifyDeps & { runs: Array<{ body: any }> };
const apifyStub = (items: unknown[]): Stub => {
  const runs: Stub["runs"] = [];
  const results = new Map<string, unknown[]>();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url.includes("/runs?")) {
      const body = JSON.parse(String(init!.body));
      const id = `run${runs.length + 1}`;
      runs.push({ body });
      results.set(id, body.postURLs ? (body.postURLs as string[]).map((u) => ({ ...item(u.split("/").pop()!), mediaUrls: [`https://api.apify.com/v2/key-value-stores/KV/records/v-${u.split("/").pop()}.mp4`] })) : items);
      return json({ data: { id, status: "READY", defaultDatasetId: `ds${runs.length}` } }, 201);
    }
    const run = /actor-runs\/(run\d+)/.exec(url);
    if (run) return json({ data: { id: run[1], status: "SUCCEEDED", defaultDatasetId: `ds${run[1]!.slice(3)}`, usageTotalUsd: 0.02, stats: { runTimeSecs: 10 } } });
    const ds = /datasets\/ds(\d+)\/items/.exec(url);
    if (ds) return json(results.get(`run${ds[1]}`) ?? []);
    throw new Error(`unexpected ${url}`);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined, runs };
};

describe("ApifyService TikTok phase 2 via yt-dlp - VE2E-146", () => {
  let root: string;
  let prevRoot: string | undefined;
  let prevKey: string | undefined;
  let media: { registerAsset: ReturnType<typeof vi.fn> };
  let prisma: any;
  const account = () => ({ id: "acct-1", encryptedSecret: encryptSecret("stub_apify_token_value_000000") });
  const brief = () => deriveSceneBrief({ language: "ja", scenes: [{ sceneId: "s1", narration: "", screenText: "", visualQuery: "東京 夜景", durationHintMs: 5000 }] }, 0);
  const auto = () => ({ platform: "tiktok" as const, keyword: "東京 夜景", brief: brief(), sceneId: "s1", usedExternalIds: new Set<string>(), scriptLanguage: "ja", segmentDurationSeconds: 10, job: new ApifyJobContext() });
  const postRuns = (stub: Stub) => stub.runs.filter((r) => r.body.postURLs);

  /** A fake worker: writes `bytes` into _quarantine/<token> like media.fetch does, or fails with `code`. */
  const fakeFetch = (behaviour: { bytes?: Buffer; code?: string }) => {
    const fetchPost = vi.fn(async (): Promise<SocialFetchOutcome> => {
      if (behaviour.code) return { ok: false, code: behaviour.code as any, message: "blocked", steps: [{ via: "plain", cookiesAccountId: null, code: behaviour.code as any, runs: [] }], elapsedMs: 900 };
      const token = TOKEN;
      await mkdir(join(root, "_quarantine"), { recursive: true });
      await writeFile(join(root, "_quarantine", token), behaviour.bytes!);
      return {
        ok: true,
        steps: [{ via: "plain", cookiesAccountId: null, code: null, runs: [{ step: "plain", code: null, elapsedMs: 800 }] }],
        elapsedMs: 850,
        result: {
          schemaVersion: "media-job.v1", type: "media.fetch.result", ok: true, jobKey: "fetch:x", quarantineToken: token, bytes: behaviour.bytes!.byteLength, sha256: "a".repeat(64),
          probe: { durationMs: 30_000, width: 1080, height: 1920, videoCodec: "h264" }, info: {} as any, attempts: [], tool: { name: "yt-dlp", version: "2026.08.19", profileVersion: "media-fetch.v1" }, elapsedMs: 800, completedAt: "",
        },
      };
    });
    return { fetchPost } as unknown as SocialFetchService & { fetchPost: typeof fetchPost };
  };
  const makeService = (social?: SocialFetchService) => new ApifyService(prisma, { forUser: async () => ({ projectIds: [projectId] }) } as any, media as unknown as MediaService, undefined, undefined, undefined, social);

  beforeEach(async () => {
    process.env.APIFY_TWO_PHASE = "1";
    process.env.MEDIA_FETCH_YTDLP = "1";
    prevKey = process.env.PERSISTENCE_ENCRYPTION_KEY;
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    root = await mkdtemp(join(tmpdir(), "lyonix-oss-"));
    prevRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = root;
    media = { registerAsset: vi.fn(async () => fakeAsset) };
    prisma = { project: { findUnique: async () => ({ id: projectId }) }, providerAccount: { findFirst: async () => null }, mediaAssetVersion: { findFirst: vi.fn(async () => null) } };
    vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: MP4, mimeType: "video/mp4", finalUrl: "x" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const name of ["APIFY_TWO_PHASE", "MEDIA_FETCH_YTDLP"]) delete process.env[name];
    process.env.PERSISTENCE_ENCRYPTION_KEY = prevKey;
    if (prevRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("yt-dlp downloads the chosen post: no Actor download run, asset registered like an Apify import with the downloader in provenance", async () => {
    const stub = apifyStub([item("7")]);
    const social = fakeFetch({ bytes: MP4 });
    const service = makeService(social);
    service.apifyDeps = stub;
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.externalId).toBe("7");
    expect(outcome.data.quality.downloader).toBe("yt-dlp");
    expect(postRuns(stub)).toHaveLength(0); // only the search ran
    expect(social.fetchPost).toHaveBeenCalledWith(expect.objectContaining({ platform: "tiktok", tool: "yt-dlp", url: "https://www.tiktok.com/@fake/video/7" }));
    const registered = media.registerAsset.mock.calls[0]![3];
    expect(registered).toMatchObject({ origin: "apify", originalFileName: "apify-tiktok-7.mp4", widthPx: 1080, heightPx: 1920, durationMs: 30_000, quarantineToken: TOKEN });
    expect(registered.serverProvenance.downloader).toMatchObject({ tool: "yt-dlp", version: "2026.08.19" });
    expect(registered.serverProvenance.audioPolicy).toBe("strip_audio");
  });

  it("yt-dlp blocked (403) -> Apify phase 2 downloads it, the reason is kept for diagnostics", async () => {
    const stub = apifyStub([item("8")]);
    const service = makeService(fakeFetch({ code: "FETCH_FORBIDDEN" }));
    service.apifyDeps = stub;
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(postRuns(stub)).toHaveLength(1);
    expect(outcome.data.quality).toMatchObject({ downloader: "apify", ossFetchCode: "FETCH_FORBIDDEN", phase2: "ok" });
  });

  it("bytes that are not a video are deleted from quarantine and Apify takes over", async () => {
    const stub = apifyStub([item("9")]);
    const service = makeService(fakeFetch({ bytes: Buffer.from("<html>login</html>") }));
    service.apifyDeps = stub;
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto());
    expect(outcome.ok).toBe(true);
    expect(postRuns(stub)).toHaveLength(1);
    expect(outcome.ok && outcome.data.quality.ossFetchCode).toBe("register_failed:UNSUPPORTED_MEDIA");
    expect(await readdir(join(root, "_quarantine")).then((names) => names.filter((n) => n === TOKEN))).toEqual([]);
  });

  it("MEDIA_FETCH_YTDLP off (default): yt-dlp is never asked, behaviour unchanged", async () => {
    delete process.env.MEDIA_FETCH_YTDLP;
    const stub = apifyStub([item("10")]);
    const social = fakeFetch({ bytes: MP4 });
    const service = makeService(social);
    service.apifyDeps = stub;
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), auto());
    expect(outcome.ok).toBe(true);
    expect(social.fetchPost).not.toHaveBeenCalled();
    expect(postRuns(stub)).toHaveLength(1);
    expect(outcome.ok && outcome.data.quality.downloader).toBeUndefined();
  });
});
