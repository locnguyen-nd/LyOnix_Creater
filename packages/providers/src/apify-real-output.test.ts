import { describe, expect, it, vi } from "vitest";
import { APIFY_MAX_ITEMS_QUERY_ACTORS, normalizeApifyItems, searchApify, type ApifyDeps } from "./apify.js";

// VE2E-49: fixtures mirror the FIELD SHAPES seen in the live probe (2026-09-30); every value is fake.
const TOKEN = "stub_token_value_1234567890abcdef";
const ctx = { query: "k", providerAccountId: "acct-1", fetchedAt: "2026-09-30T00:00:00.000Z" };
const actor = { actorId: "x/y", version: "1", role: "primary" as const, runId: "run1" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const tiktokRealShape = {
  id: "7000000000000000001",
  text: "fake caption",
  webVideoUrl: "https://www.tiktok.com/@fake/video/7000000000000000001",
  authorMeta: { name: "fake", profileUrl: "https://www.tiktok.com/@fake" },
  videoMeta: {
    // With shouldDownloadCovers/Videos the Actor rewrites these two to token-protected Key-Value-Store URLs.
    coverUrl: "https://api.apify.com/v2/key-value-stores/FAKEKVID/records/cover-7000000000000000001.jpg",
    downloadAddr: "https://api.apify.com/v2/key-value-stores/FAKEKVID/records/video-7000000000000000001.mp4",
    originalCoverUrl: "https://p16-common-sign.tiktokcdn.com/fake-cover~tplv-fake.jpeg?x-expires=1&x-signature=fake",
    duration: 30, width: 720, height: 1280,
  },
  mediaUrls: ["https://api.apify.com/v2/key-value-stores/FAKEKVID/records/video-7000000000000000001.mp4"],
};

const pinterestBackupShape = {
  type: "pin", id: "8000000001", url: "https://www.pinterest.com/pin/8000000001/",
  imageUrl: "https://i.pinimg.com/originals/fa/ke/fake.jpg",
  imageUrls: { "170x": "https://i.pinimg.com/170x/fake.jpg", "736x": "https://i.pinimg.com/736x/fake.jpg", original: "https://i.pinimg.com/originals/fa/ke/fake.jpg", thumbnail: "https://i.pinimg.com/236x/fake.jpg" },
  isVideo: false, width: 1024, height: 2048,
  pinner: { username: "fakepinner" },
};

function fakeApify(routes: Array<{ match: RegExp; method?: string; respond: () => Response }>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.find((r) => r.match.test(url) && (r.method ?? "GET") === method);
    if (!route) throw new Error(`unexpected call ${method} ${url}`);
    return route.respond();
  });
  const deps: ApifyDeps = { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined };
  return { calls, deps };
}

const succeedingRun = (actorPath: string, items: unknown[], runId = "run1", ds = "ds1") => [
  { match: new RegExp(`/v2/acts/${actorPath}/runs\\?`), method: "POST", respond: () => json({ data: { id: runId, status: "READY", defaultDatasetId: ds } }, 201) },
  { match: new RegExp(`/v2/actor-runs/${runId}\\?waitForFinish`), respond: () => json({ data: { id: runId, status: "SUCCEEDED", defaultDatasetId: ds } }) },
  { match: new RegExp(`/v2/datasets/${ds}/items`), respond: () => json(items) },
];

describe("TikTok real output shape (Defect A)", () => {
  it("uses originalCoverUrl (public signed CDN) as previewUrl, never the api.apify.com coverUrl", () => {
    const [r] = normalizeApifyItems("tiktok", [tiktokRealShape], actor, ctx);
    expect(r!.candidate.previewUrl).toBe(tiktokRealShape.videoMeta.originalCoverUrl);
    expect(new URL(r!.candidate.previewUrl).hostname).toBe("p16-common-sign.tiktokcdn.com");
    expect(r!.candidate.previewUrl).not.toContain("api.apify.com");
  });

  it("stays importable through the server-side api.apify.com download plan", () => {
    const [r] = normalizeApifyItems("tiktok", [tiktokRealShape], actor, ctx);
    expect(r!.candidate).toMatchObject({ accessMethod: "api_download", eligibility: { autoEligible: true } });
    expect(r!.download).toMatchObject({ url: tiktokRealShape.mediaUrls[0], policy: "apify_api", kind: "video", hostSuffixes: ["api.apify.com"] });
  });

  it("falls back to coverUrl only when its host is a public preview CDN; otherwise the preview is empty", () => {
    const cdnCover = { ...tiktokRealShape, videoMeta: { ...tiktokRealShape.videoMeta, originalCoverUrl: undefined, coverUrl: "https://p16.tiktokcdn-eu.com/fake.jpg" } };
    expect(normalizeApifyItems("tiktok", [cdnCover], actor, ctx)[0]!.candidate.previewUrl).toBe("https://p16.tiktokcdn-eu.com/fake.jpg");
    const kvOnly = { ...tiktokRealShape, videoMeta: { ...tiktokRealShape.videoMeta, originalCoverUrl: undefined } };
    const [r] = normalizeApifyItems("tiktok", [kvOnly], actor, ctx);
    expect(r!.candidate.previewUrl).toBe("");
    expect(r!.download).not.toBeNull();
  });
});

describe("Pinterest real output shape and run parameters (Defect B)", () => {
  it("backup output (imageUrl / imageUrls / isVideo=false) is an importable pinimg.com photo with a preview", () => {
    const [r] = normalizeApifyItems("pinterest", [pinterestBackupShape], actor, ctx);
    expect(r!.candidate).toMatchObject({ mediaType: "photo", eligibility: { autoEligible: true } });
    expect(r!.candidate.previewUrl).toMatch(/^https:\/\/i\.pinimg\.com\//);
    expect(r!.download).toMatchObject({ kind: "image", policy: "suffix", hostSuffixes: ["pinimg.com"] });
  });

  it("backup output with isVideo=true and no mp4 is preview-only, not importable", () => {
    const [r] = normalizeApifyItems("pinterest", [{ ...pinterestBackupShape, isVideo: true }], actor, ctx);
    expect(r!.download).toBeNull();
    expect(r!.candidate.eligibility).toMatchObject({ autoEligible: false });
  });

  it("does not send the maxItems max-charge query param to the pay-per-event primary; bounds via Actor input instead", async () => {
    const fake = fakeApify([
      ...succeedingRun("fatihtahta~pinterest-scraper-search", [pinterestBackupShape]),
    ]);
    const outcome = await searchApify(TOKEN, { platform: "pinterest", keyword: "k", lang: "ja", limit: 5, providerAccountId: "a" }, fake.deps);
    const start = fake.calls[0]!;
    expect(start.url).toBe("https://api.apify.com/v2/acts/fatihtahta~pinterest-scraper-search/runs?build=1.1.8&timeout=120");
    expect(start.url).not.toContain("maxItems");
    expect(start.body).toMatchObject({ limit: 5 });
    expect(outcome.actor.role).toBe("primary");
  });

  it("only the verified TikTok Actor keeps the maxItems query param", async () => {
    expect([...APIFY_MAX_ITEMS_QUERY_ACTORS]).toEqual(["clockworks/tiktok-scraper"]);
    const fake = fakeApify(succeedingRun("clockworks~tiktok-scraper", [tiktokRealShape]));
    await searchApify(TOKEN, { platform: "tiktok", keyword: "k", lang: "ja", limit: 5, providerAccountId: "a" }, fake.deps);
    expect(fake.calls[0]!.url).toContain("&maxItems=5");
  });

  it("keeps the backup fallback and primaryError when the primary still answers HTTP 400", async () => {
    const fake = fakeApify([
      { match: /\/v2\/acts\/fatihtahta~pinterest-scraper-search\/runs\?/, method: "POST", respond: () => json({ error: { message: "Maximum cost per run is less than the allowed minimum of $1.00" } }, 400) },
      ...succeedingRun("silentflow~pinterest-scraper-ppr", [pinterestBackupShape], "runB", "dsB"),
    ]);
    const outcome = await searchApify(TOKEN, { platform: "pinterest", keyword: "k", lang: "ja", limit: 5, providerAccountId: "a" }, fake.deps);
    expect(outcome.actor).toMatchObject({ actorId: "silentflow/pinterest-scraper-ppr", role: "backup" });
    expect(outcome.primaryError).toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
    expect(outcome.primaryError!.message).toContain("400");
    expect(outcome.results[0]!.download).toMatchObject({ kind: "image" });
    const backupStart = fake.calls.find((c) => c.url.includes("silentflow~pinterest-scraper-ppr/runs?"))!;
    expect(backupStart.url).not.toContain("maxItems");
    expect(backupStart.body).toMatchObject({ maxItems: 5 });
  });
});
