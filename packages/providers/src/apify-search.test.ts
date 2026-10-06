import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { APIFY_ACTOR_ALLOWLIST, buildActorInput, hostMatchesSuffix, normalizeApifyItems, searchApify, type ApifyDeps } from "./apify.js";

const TOKEN = "stub_token_value_1234567890abcdef";
const ctx = { query: "東京 夜景", providerAccountId: "acct-1", fetchedAt: "2026-09-30T00:00:00.000Z" };
const actor = { actorId: "x/y", version: "1", role: "primary" as const, runId: "run1" };

type Route = { match: RegExp; method?: string; respond: (url: string, body: unknown) => Response };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Fake Apify API: records every call; unmatched routes fail the test. */
function fakeApify(routes: Route[]) {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
    const route = routes.find((r) => r.match.test(url) && (r.method ?? "GET") === method);
    if (!route) throw new Error(`unexpected call ${method} ${url}`);
    return route.respond(url, body);
  });
  const deps: ApifyDeps = { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined };
  return { calls, deps };
}

const succeedingRun = (actorPath: string, items: unknown[], runId = "run1", ds = "ds1"): Route[] => [
  { match: new RegExp(`/v2/acts/${actorPath}/runs\\?`), method: "POST", respond: () => json({ data: { id: runId, status: "READY", defaultDatasetId: ds } }, 201) },
  { match: new RegExp(`/v2/actor-runs/${runId}\\?waitForFinish`), respond: () => json({ data: { id: runId, status: "SUCCEEDED", defaultDatasetId: ds } }) },
  { match: new RegExp(`/v2/datasets/${ds}/items`), respond: () => json(items) },
];

const tiktokItem = {
  id: "7001", text: "夜景 Tokyo", webVideoUrl: "https://www.tiktok.com/@u/video/7001",
  authorMeta: { name: "creator", profileUrl: "https://www.tiktok.com/@creator" },
  videoMeta: { duration: 12, width: 720, height: 1280, coverUrl: "https://p16.tiktokcdn-eu.com/cover.jpg" },
  mediaUrls: ["https://api.apify.com/v2/key-value-stores/kv1/records/video-7001.mp4"],
};

describe("Apify allowlist / helpers", () => {
  it("pins the four approved primary Actors with versions and a backup for each", () => {
    expect(APIFY_ACTOR_ALLOWLIST.tiktok.primary).toEqual({ actorId: "clockworks/tiktok-scraper", version: "0.0.611" });
    expect(APIFY_ACTOR_ALLOWLIST.pinterest.primary.actorId).toBe("fatihtahta/pinterest-scraper-search");
    expect(APIFY_ACTOR_ALLOWLIST.x.primary.actorId).toBe("apidojo/tweet-scraper");
    expect(APIFY_ACTOR_ALLOWLIST.x.backup?.actorId).toBe("kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest");
    expect(APIFY_ACTOR_ALLOWLIST.google_image.primary.actorId).toBe("damilo/google-images-scraper");
    for (const pin of Object.values(APIFY_ACTOR_ALLOWLIST)) expect(pin.primary.version).toMatch(/^\d/);
  });

  it("rejects an Actor id that is not on the allowlist", () => {
    expect(() => buildActorInput("evil/actor", "x", "ja", 5)).toThrow(ProviderError);
  });

  it("matches host suffixes on label boundaries only and never IP literals", () => {
    expect(hostMatchesSuffix("i.pinimg.com", ["pinimg.com"])).toBe(true);
    expect(hostMatchesSuffix("pinimg.com", ["pinimg.com"])).toBe(true);
    expect(hostMatchesSuffix("evilpinimg.com", ["pinimg.com"])).toBe(false);
    expect(hostMatchesSuffix("pinimg.com.evil.test", ["pinimg.com"])).toBe(false);
    expect(hostMatchesSuffix("127.0.0.1", ["pinimg.com"])).toBe(false);
  });

  it("builds bounded inputs (always a small result cap)", () => {
    expect(buildActorInput("clockworks/tiktok-scraper", "k", "ja", 7)).toMatchObject({ resultsPerPage: 7, proxyCountryCode: "JP", shouldDownloadVideos: true });
    expect(buildActorInput("fatihtahta/pinterest-scraper-search", "k", "ja", 7)).toMatchObject({ limit: 7 });
    expect(buildActorInput("kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest", "k", "ja", 7)).toMatchObject({ maxItems: 7, lang: "ja", queryType: "Videos" });
    expect(buildActorInput("apidojo/tweet-scraper", "阪神", "ja", 7)).toEqual({ searchTerms: ["阪神"], sort: "Top", onlyVideo: true, tweetLanguage: "ja", maxItems: 50 });
    expect(buildActorInput("johnvc/google-short-videos-api", "k", "ja", 7)).toMatchObject({ max_pages: 1 });
  });
});

describe("normalizeApifyItems", () => {
  it("TikTok: Key-Value-Store file on api.apify.com is the import source; provenance and rights are set", () => {
    const [result] = normalizeApifyItems("tiktok", [tiktokItem], actor, ctx);
    expect(result!.candidate).toMatchObject({
      candidateId: "apify:tiktok:video:7001", source: "apify:tiktok", mediaType: "video", accessMethod: "api_download",
      rightsStatus: "owner_accepted_risk", eligibility: { autoEligible: true }, durationSeconds: 12,
      previewUrl: "https://p16.tiktokcdn-eu.com/cover.jpg",
      attribution: { name: "creator", sourcePageUrl: "https://www.tiktok.com/@u/video/7001" },
    });
    expect(result!.candidate.provenance.apify).toMatchObject({ platform: "tiktok", actorId: "x/y", actorVersion: "1", runId: "run1", datasetItemIndex: 0, author: "creator", fetchedAt: "2026-09-30T00:00:00.000Z" });
    expect(result!.download).toMatchObject({ policy: "apify_api", kind: "video", hostSuffixes: ["api.apify.com"] });
  });

  it("TikTok: a signed CDN link is never an import source (preview-only) and slideshows/errors are dropped", () => {
    const signedOnly = { ...tiktokItem, mediaUrls: [], videoMeta: { ...tiktokItem.videoMeta, downloadAddr: "https://v16.tiktokcdn.com/v.mp4?x-signature=abc" } };
    const out = normalizeApifyItems("tiktok", [signedOnly, { ...tiktokItem, id: "2", isSlideshow: true }, { ...tiktokItem, id: "3", error: "boom" }], actor, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.download).toBeNull();
    expect(out[0]!.candidate).toMatchObject({ accessMethod: "discovery_only", eligibility: { autoEligible: false, reason: "no_apify_stored_file" } });
  });

  it("TikTok: a mediaUrls entry that is not an api.apify.com key-value-store URL is ignored", () => {
    const out = normalizeApifyItems("tiktok", [{ ...tiktokItem, mediaUrls: ["https://evil.example/v.mp4"] }, { ...tiktokItem, id: "9", mediaUrls: ["https://api.apify.com/v2/users/me"] }], actor, ctx);
    expect(out.map((r) => r.download)).toEqual([null, null]);
  });

  it("Pinterest: image from pinimg.com is importable; HLS-only video is preview-only; direct mp4 is importable", () => {
    const image = { id: "p1", url: "https://www.pinterest.com/pin/p1/", media: { images: { original: { url: "https://i.pinimg.com/originals/a.jpg", width: 900, height: 1600 }, medium: { url: "https://i.pinimg.com/474x/a.jpg" } } }, creator: { username: "u1" } };
    const hls = { id: "p2", pin: { is_video: true }, media: { video: { hls_url: "https://v1.pinimg.com/videos/a.m3u8", duration: 9, thumbnail: "https://i.pinimg.com/x.jpg" } } };
    const mp4 = { id: "p3", pin: { is_video: true }, media: { video: { url: "https://v1.pinimg.com/videos/a.mp4", duration: 9, thumbnail: "https://i.pinimg.com/x.jpg" } } };
    const [a, b, c] = normalizeApifyItems("pinterest", [image, hls, mp4], actor, ctx);
    expect(a!.download).toMatchObject({ kind: "image", policy: "suffix", hostSuffixes: ["pinimg.com"] });
    expect(a!.candidate.mediaType).toBe("photo");
    expect(b!.download).toBeNull();
    expect(b!.candidate).toMatchObject({ mediaType: "video", accessMethod: "discovery_only", eligibility: { autoEligible: false, reason: "hls_only_preview" } });
    expect(c!.download).toMatchObject({ kind: "video", url: "https://v1.pinimg.com/videos/a.mp4" });
  });

  it("Pinterest: an image URL on a foreign host is not accepted", () => {
    expect(normalizeApifyItems("pinterest", [{ id: "p9", media: { images: { original: { url: "https://evil.example/a.jpg" } } } }], actor, ctx)).toEqual([]);
  });

  it("X: picks the highest-bitrate mp4 variant on twimg.com; without a recognisable media field the item is dropped", () => {
    const tweet = {
      id: "t1", url: "https://x.com/u/status/t1", text: "夜景", author: { userName: "u", url: "https://x.com/u" },
      extendedEntities: { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/thumb.jpg", video_info: { variants: [
        { url: "https://video.twimg.com/low.mp4", bitrate: 100, content_type: "video/mp4" },
        { url: "https://video.twimg.com/high.mp4", bitrate: 900, content_type: "video/mp4" },
        { url: "https://video.twimg.com/pl.m3u8", content_type: "application/x-mpegURL" },
      ] } }] },
    };
    const out = normalizeApifyItems("x", [tweet, { id: "t2", text: "no media" }], actor, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.download).toMatchObject({ url: "https://video.twimg.com/high.mp4", policy: "suffix", hostSuffixes: ["twimg.com"] });
  });

  it("Google image: arbitrary host -> public_web policy, preview only from gstatic.com, hash id", () => {
    const [r] = normalizeApifyItems("google_image", [{ title: "夜景", imageUrl: "https://blog.example.jp/a.jpg", thumbnailUrl: "https://encrypted-tbn0.gstatic.com/images?q=1", link: "https://blog.example.jp/post" }], actor, ctx);
    expect(r!.download).toMatchObject({ policy: "public_web", kind: "image", hostSuffixes: [] });
    expect(r!.candidate.previewUrl).toBe("https://encrypted-tbn0.gstatic.com/images?q=1");
    expect(r!.candidate.externalId).toMatch(/^[0-9a-f]{8}$/);
    const noThumb = normalizeApifyItems("google_image", [{ imageUrl: "https://blog.example.jp/b.jpg", thumbnailUrl: "https://tracker.example/t.jpg" }], actor, ctx);
    expect(noThumb[0]!.candidate.previewUrl).toBe("");
  });

  it("Google image: http (non-https) and credentialed URLs are dropped", () => {
    expect(normalizeApifyItems("google_image", [{ imageUrl: "http://a.example/a.jpg" }, { imageUrl: "https://user:pw@a.example/a.jpg" }], actor, ctx)).toEqual([]);
  });

  it("Google video: discovery/preview only, never importable or auto-eligible", () => {
    const [r] = normalizeApifyItems("google_video", [{ result_type: "short_video", title: "t", link: "https://www.youtube.com/shorts/abc", clip: "https://encrypted-vtbn0.gstatic.com/video?q=tbn:x", duration: "0:47", source: "YouTube" }, { result_type: "people_also_search_for", link: "https://x.example/" }], actor, ctx);
    expect(r!.download).toBeNull();
    expect(r!.candidate).toMatchObject({ accessMethod: "discovery_only", importUrl: null, durationSeconds: 47, eligibility: { autoEligible: false, reason: "google_video_discovery_only" } });
  });

  it("drops non-object items, duplicates and clips over-long strings", () => {
    const long = "x".repeat(2000);
    const out = normalizeApifyItems("tiktok", [null, "str", 5, { ...tiktokItem, text: long }, tiktokItem], actor, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidate.descriptorText!.length).toBeLessThanOrEqual(500);
  });

  it("caps at 20 items", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ ...tiktokItem, id: String(i + 1) }));
    expect(normalizeApifyItems("tiktok", items, actor, ctx)).toHaveLength(20);
  });
});

describe("searchApify", () => {
  it("runs the pinned primary Actor asynchronously with build, timeout and maxItems, reading the dataset", async () => {
    const fake = fakeApify(succeedingRun("clockworks~tiktok-scraper", [tiktokItem]));
    const outcome = await searchApify(TOKEN, { platform: "tiktok", keyword: " 東京  夜景 ", lang: "ja", limit: 500, providerAccountId: "acct-1" }, fake.deps);
    const start = fake.calls[0]!;
    expect(start.url).toBe("https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?build=0.0.611&timeout=120&maxItems=20");
    expect(start.auth).toBe(`Bearer ${TOKEN}`);
    expect(start.body).toMatchObject({ searchQueries: ["東京 夜景"], resultsPerPage: 20 });
    expect(fake.calls.at(-1)!.url).toContain("limit=20");
    expect(outcome.actor).toEqual({ actorId: "clockworks/tiktok-scraper", version: "0.0.611", role: "primary" });
    expect(outcome.runId).toBe("run1");
    expect(outcome.results[0]!.candidate.provenance.apify).toMatchObject({ runId: "run1", actorRole: "primary" });
    expect(fake.calls.every((c) => c.url.startsWith("https://api.apify.com/"))).toBe(true);
    expect(fake.calls.every((c) => !c.url.includes(TOKEN))).toBe(true);
  });

  it("retries a failed run once, then succeeds without touching the backup", async () => {
    let runs = 0;
    const fake = fakeApify([
      { match: /\/v2\/acts\/clockworks~tiktok-scraper\/runs\?/, method: "POST", respond: () => { runs += 1; return json({ data: { id: `run${runs}`, status: "READY", defaultDatasetId: "ds1" } }, 201); } },
      { match: /\/v2\/actor-runs\/run1\?/, respond: () => json({ data: { id: "run1", status: "FAILED" } }) },
      { match: /\/v2\/actor-runs\/run2\?/, respond: () => json({ data: { id: "run2", status: "SUCCEEDED", defaultDatasetId: "ds1" } }) },
      { match: /\/v2\/datasets\/ds1\/items/, respond: () => json([tiktokItem]) },
    ]);
    const outcome = await searchApify(TOKEN, { platform: "tiktok", keyword: "k", lang: "ja", providerAccountId: "a" }, fake.deps);
    expect(runs).toBe(2);
    expect(outcome.actor.role).toBe("primary");
    expect(fake.calls.some((c) => c.url.includes("apidojo"))).toBe(false);
  });

  it("falls back to the pinned backup only after the primary (and its retry) failed, recording the primary error", async () => {
    const fake = fakeApify([
      { match: /\/v2\/acts\/clockworks~tiktok-scraper\/runs\?/, method: "POST", respond: () => json({ error: { message: "boom" } }, 500) },
      ...succeedingRun("apidojo~tiktok-scraper", [{ id: "b1", title: "t", postPage: "https://www.tiktok.com/@u/video/b1", video: { url: "https://v45.tiktokcdn-eu.com/v.mp4?sig=1", cover: "https://p.tiktokcdn.com/c.jpg", duration: 8 } }], "runB", "dsB"),
    ]);
    const outcome = await searchApify(TOKEN, { platform: "tiktok", keyword: "k", lang: "en", providerAccountId: "a" }, fake.deps);
    expect(outcome.actor).toEqual({ actorId: "apidojo/tiktok-scraper", version: "0.0.1111", role: "backup" });
    expect(outcome.primaryError).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    // backup output never yields an import source from a signed CDN link
    expect(outcome.results[0]!.download).toBeNull();
    expect(fake.calls.filter((c) => c.url.includes("clockworks") && c.method === "POST")).toHaveLength(2);
  });

  it("does not try the backup on an auth error (same token) and passes the real message through, redacted", async () => {
    const fake = fakeApify([{ match: /\/runs\?/, method: "POST", respond: () => json({ error: { message: `Token ${TOKEN} invalid` } }, 401) }]);
    const error = await searchApify(TOKEN, { platform: "pinterest", keyword: "k", lang: "ja", providerAccountId: "a" }, fake.deps).catch((e) => e);
    expect(error).toMatchObject({ code: "PROVIDER_AUTH_INVALID" });
    expect(error.message).not.toContain(TOKEN);
    expect(fake.calls).toHaveLength(1);
  });

  it("falls back when the primary returns nothing usable", async () => {
    const fake = fakeApify([
      ...succeedingRun("fatihtahta~pinterest-scraper-search", []),
      ...succeedingRun("silentflow~pinterest-scraper-ppr", [{ id: "s1", imageUrl: "https://i.pinimg.com/originals/s.jpg", url: "https://www.pinterest.com/pin/s1/" }], "runB", "dsB"),
    ]);
    const outcome = await searchApify(TOKEN, { platform: "pinterest", keyword: "k", lang: "ja", providerAccountId: "a" }, fake.deps);
    expect(outcome.actor.role).toBe("backup");
    expect(outcome.results[0]!.download).toMatchObject({ kind: "image" });
  });

  it("aborts the run and reports PROVIDER_TIMEOUT when it exceeds 120 s", async () => {
    let clock = 0;
    const fake = fakeApify([
      { match: /\/v2\/acts\/damilo~google-images-scraper\/runs\?/, method: "POST", respond: () => json({ data: { id: "runT", status: "READY" } }, 201) },
      { match: /\/v2\/actor-runs\/runT\?/, respond: () => json({ data: { id: "runT", status: "RUNNING" } }) },
      { match: /\/v2\/actor-runs\/runT\/abort/, method: "POST", respond: () => json({ data: {} }) },
      { match: /\/v2\/acts\/hooli~google-images-scraper\/runs\?/, method: "POST", respond: () => json({ error: { message: "nope" } }, 500) },
    ]);
    fake.deps.now = () => clock;
    fake.deps.sleep = async (ms) => { clock += ms * 60; };
    const error = await searchApify(TOKEN, { platform: "google_image", keyword: "k", lang: "ja", providerAccountId: "a" }, fake.deps).catch((e) => e);
    expect(fake.calls.some((c) => c.url.endsWith("/v2/actor-runs/runT/abort"))).toBe(true);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe("PROVIDER_TIMEOUT");
  });

  it("rejects an empty keyword and an unknown platform without calling Apify", async () => {
    const fake = fakeApify([]);
    await expect(searchApify(TOKEN, { platform: "tiktok", keyword: "   ", lang: "ja", providerAccountId: "a" }, fake.deps)).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
    await expect(searchApify(TOKEN, { platform: "evil" as never, keyword: "k", lang: "ja", providerAccountId: "a" }, fake.deps)).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
    expect(fake.calls).toHaveLength(0);
  });
});
