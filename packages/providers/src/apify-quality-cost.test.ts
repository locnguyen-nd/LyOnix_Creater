import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { APIFY_DOWNLOAD_RUN_TIMEOUT_SECS, buildActorInput, buildTikTokPostInput, fetchApifyTikTokPost, normalizeApifyItems, searchApify, type ApifyDeps } from "./apify.js";

// VE2E-51: fixtures mirror the FIELD SHAPES of the owner-job dataset (VE2E-50 diagnosis); every value is fake.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ctx = { query: "k", providerAccountId: "acct-1", fetchedAt: "2026-09-30T00:00:00.000Z" };
const actor = { actorId: "clockworks/tiktok-scraper", version: "0.0.611", role: "primary" as const, runId: "run1" };

const searchOnlyItem = (over: Record<string, unknown> = {}) => ({
  id: "7000000000000000001",
  text: "夜景 散歩",
  textLanguage: "ja",
  locationMeta: { countryCode: "1861060" },
  isAd: false,
  isSponsored: false,
  hashtags: [{ name: "夜景" }, "tokyo"],
  webVideoUrl: "https://www.tiktok.com/@fake/video/7000000000000000001",
  authorMeta: { name: "fake" },
  videoMeta: { duration: 30, width: 720, height: 1280, originalCoverUrl: "https://p16-common-sign.tiktokcdn.com/fake.jpeg?x-signature=fake" },
  ...over,
});
const withFile = (id: string) => ({ ...searchOnlyItem({ id, webVideoUrl: `https://www.tiktok.com/@fake/video/${id}` }), mediaUrls: [`https://api.apify.com/v2/key-value-stores/FAKEKV/records/video-${id}.mp4`] });

type RunScript = { status: string; usd?: number; secs?: number; items: unknown[] };
/** Stub Apify API: each POST /runs consumes the next script entry. */
function stub(scripts: RunScript[]) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  let started = -1;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST" && url.includes("/runs?")) { started += 1; return json({ data: { id: `run${started + 1}`, status: "READY", defaultDatasetId: `ds${started + 1}` } }, 201); }
    const run = /actor-runs\/run(\d+)/.exec(url);
    if (run) {
      const s = scripts[Number(run[1]) - 1]!;
      return json({ data: { id: `run${run[1]}`, status: s.status, defaultDatasetId: `ds${run[1]}`, usageTotalUsd: s.usd, stats: s.secs === undefined ? undefined : { runTimeSecs: s.secs } } });
    }
    const ds = /datasets\/ds(\d+)\/items/.exec(url);
    if (ds) return json(scripts[Number(ds[1]) - 1]!.items);
    throw new Error(`unexpected ${method} ${url}`);
  });
  const deps: ApifyDeps = { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined };
  return { deps, calls };
}
const input = { platform: "tiktok" as const, keyword: "東京 夜景", lang: "ja" as const, limit: 10, providerAccountId: "acct-1" };

describe("TikTok dataset quality signals (VE2E-51)", () => {
  it("extracts textLanguage, GeoNames country, ad flags, hashtags (strings or objects), dimensions and duration", () => {
    const [r] = normalizeApifyItems("tiktok", [searchOnlyItem({ isSponsored: true })], actor, ctx);
    expect(r!.social).toEqual({
      videoId: "7000000000000000001", text: "夜景 散歩", hashtags: ["夜景", "tokyo"], textLanguage: "ja", countryCode: "1861060",
      isAd: false, isSponsored: true, widthPx: 720, heightPx: 1280, durationSeconds: 30,
    });
  });

  it("search-only mode: an item without a stored file is a deferred candidate (page URL), not a preview-only one", () => {
    const [deferred] = normalizeApifyItems("tiktok", [searchOnlyItem()], actor, { ...ctx, deferDownload: true });
    expect(deferred!.download).toBeNull();
    expect(deferred!.deferredPostUrl).toBe("https://www.tiktok.com/@fake/video/7000000000000000001");
    expect(deferred!.candidate.eligibility).toEqual({ autoEligible: true });
    expect(deferred!.candidate.accessMethod).toBe("api_download");
    const [classic] = normalizeApifyItems("tiktok", [searchOnlyItem()], actor, ctx);
    expect(classic!.candidate.eligibility.autoEligible).toBe(false);
    expect(classic!.deferredPostUrl).toBeUndefined();
  });

  it("never defers a non-tiktok.com page URL", () => {
    const [r] = normalizeApifyItems("tiktok", [searchOnlyItem({ webVideoUrl: "https://evil.example/video/1" })], actor, { ...ctx, deferDownload: true });
    expect(r!.deferredPostUrl).toBeUndefined();
  });

  it("search-only input turns both downloads off; default input is unchanged", () => {
    expect(buildActorInput("clockworks/tiktok-scraper", "k", "ja", 10, { download: false })).toMatchObject({ shouldDownloadVideos: false, shouldDownloadCovers: false });
    expect(buildActorInput("clockworks/tiktok-scraper", "k", "ja", 10)).toMatchObject({ shouldDownloadVideos: true, shouldDownloadCovers: true });
  });
});

describe("TIMED-OUT with items and usage (VE2E-51)", () => {
  it("uses the items of a TIMED-OUT run instead of retrying it, and reports usage", async () => {
    const s = stub([{ status: "TIMED-OUT", usd: 0.0412, secs: 120, items: [withFile("1"), withFile("2")] }]);
    const outcome = await searchApify("tok", input, s.deps);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.timedOutWithItems).toBe(true);
    expect(s.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(outcome.usage).toEqual({ runs: 1, seconds: 120, usd: 0.0412 });
  });

  it("a TIMED-OUT run WITHOUT items is still retried once, and both runs are counted", async () => {
    const s = stub([{ status: "TIMED-OUT", usd: 0.01, secs: 120, items: [] }, { status: "SUCCEEDED", usd: 0.02, secs: 30, items: [withFile("1")] }]);
    const outcome = await searchApify("tok", input, s.deps);
    expect(outcome.results).toHaveLength(1);
    expect(s.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(outcome.usage).toEqual({ runs: 2, seconds: 150, usd: 0.03 });
  });

  it("usage of failed runs reaches the caller's sink even when the search throws; usd stays null if Apify reports none", async () => {
    const s = stub([{ status: "FAILED", secs: 5, items: [] }, { status: "FAILED", secs: 6, items: [] }, { status: "FAILED", items: [] }, { status: "FAILED", items: [] }]);
    const sink = { runs: 0, seconds: 0, usd: null as number | null };
    await expect(searchApify("tok", { ...input, usageSink: sink }, s.deps)).rejects.toBeInstanceOf(ProviderError);
    expect(sink.runs).toBeGreaterThanOrEqual(2);
    expect(sink.usd).toBeNull();
  });

  it("search-only phase keeps the 120 s timeout; an explicit download timeout is passed through", async () => {
    const a = stub([{ status: "SUCCEEDED", items: [searchOnlyItem()] }]);
    await searchApify("tok", { ...input, download: false }, a.deps);
    expect(a.calls[0]!.url).toContain("timeout=120");
    expect(a.calls[0]!.body).toMatchObject({ shouldDownloadVideos: false });
    const b = stub([{ status: "SUCCEEDED", items: [withFile("1")] }]);
    await searchApify("tok", { ...input, runTimeoutSecs: APIFY_DOWNLOAD_RUN_TIMEOUT_SECS }, b.deps);
    expect(b.calls[0]!.url).toContain("timeout=240");
  });
});

describe("phase 2: fetchApifyTikTokPost (VE2E-51)", () => {
  const post = { postUrl: "https://www.tiktok.com/@fake/video/7000000000000000001", expectedVideoId: "7000000000000000001", lang: "ja" as const, providerAccountId: "acct-1" };

  it("builds the one-post input: URL list, one result, download on (field name overridable)", () => {
    expect(buildTikTokPostInput(post.postUrl, "ja")).toEqual({ postURLs: [post.postUrl], resultsPerPage: 1, proxyCountryCode: "JP", shouldDownloadVideos: true, shouldDownloadCovers: true, shouldDownloadSlideshowImages: false });
    expect(buildTikTokPostInput(post.postUrl, "ja", "startUrls")).toHaveProperty("startUrls");
  });

  it("downloads exactly the chosen post: 1 result, 240 s timeout, returns the stored file and usage", async () => {
    const s = stub([{ status: "SUCCEEDED", usd: 0.006, secs: 20, items: [withFile("7000000000000000001")] }]);
    const outcome = await fetchApifyTikTokPost("tok", post, s.deps);
    expect(s.calls[0]!.url).toContain("timeout=240");
    expect(s.calls[0]!.url).toContain("maxItems=1");
    expect(s.calls[0]!.body).toMatchObject({ postURLs: [post.postUrl], resultsPerPage: 1 });
    expect(outcome.results[0]!.download?.url).toContain("api.apify.com/v2/key-value-stores/");
    expect(outcome.usage).toEqual({ runs: 1, seconds: 20, usd: 0.006 });
  });

  it("rejects a result for another video (an Actor that ignored the input) or one without a stored file", async () => {
    const wrongId = stub([{ status: "SUCCEEDED", items: [withFile("999")] }]);
    await expect(fetchApifyTikTokPost("tok", post, wrongId.deps)).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
    const noFile = stub([{ status: "SUCCEEDED", items: [searchOnlyItem()] }]);
    await expect(fetchApifyTikTokPost("tok", post, noFile.deps)).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
  });

  it("refuses a non-tiktok.com URL without calling Apify", async () => {
    const s = stub([]);
    await expect(fetchApifyTikTokPost("tok", { ...post, postUrl: "https://evil.example/v/1" }, s.deps)).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
    expect(s.calls).toHaveLength(0);
  });
});
