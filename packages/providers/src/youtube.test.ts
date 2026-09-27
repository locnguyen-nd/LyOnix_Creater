import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { isYouTubeUrl, probeYouTubeAccount, searchYouTubeVideos, youtubeVideoToMediaCandidate } from "./youtube.js";

afterEach(() => { vi.unstubAllGlobals(); });

const searchItem = {
  id: { videoId: "abc123" },
  snippet: {
    title: "How to cook pasta",
    description: "A quick pasta recipe video.",
    channelTitle: "Cooking Channel",
    publishedAt: "2026-01-01T00:00:00Z",
    thumbnails: { high: { url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg" } },
  },
};

describe("probeYouTubeAccount", () => {
  it("calls the cheap videos.list(chart=mostPopular) endpoint and returns verifiedAt", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/videos?part=id&chart=mostPopular");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeYouTubeAccount("key");
    expect(result.verifiedAt).toBeTruthy();
  });

  it("maps a 401 to PROVIDER_AUTH_INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "API key invalid" } }), { status: 401 })));
    await expect(probeYouTubeAccount("bad")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" } satisfies Partial<ProviderError>);
  });

  it("maps a quota-scoped 403 to PROVIDER_QUOTA_EXHAUSTED, not a generic capability failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "The request cannot be completed because you have exceeded your quota." } }), { status: 403 })));
    await expect(probeYouTubeAccount("key")).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" } satisfies Partial<ProviderError>);
  });

  it("maps a non-quota 403 to PROVIDER_CAPABILITY_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Access Not Configured" } }), { status: 403 })));
    await expect(probeYouTubeAccount("key")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" } satisfies Partial<ProviderError>);
  });

  it("maps a network/timeout failure to PROVIDER_TIMEOUT", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(probeYouTubeAccount("key")).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" } satisfies Partial<ProviderError>);
  });
});

describe("searchYouTubeVideos", () => {
  it("passes videoDuration/query through and maps snippet fields, dropping items with no videoId", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain("type=video");
      expect(url).toContain("videoDuration=short");
      expect(url).toContain("q=pasta+recipe");
      return new Response(JSON.stringify({ items: [searchItem, { id: {}, snippet: {} }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await searchYouTubeVideos("key", "pasta recipe", { videoDuration: "short" });
    expect(results).toEqual([{
      videoId: "abc123",
      title: "How to cook pasta",
      description: "A quick pasta recipe video.",
      channelTitle: "Cooking Channel",
      publishedAt: "2026-01-01T00:00:00Z",
      thumbnailUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
    }]);
  });

  it("clamps maxResults to the documented 1..25 bound", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("maxResults=25");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await searchYouTubeVideos("key", "x", { maxResults: 999 });
  });

  it("maps a 429 to PROVIDER_RATE_LIMITED with retryAfterMs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "retry-after": "12" } })));
    await expect(searchYouTubeVideos("key", "x")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterMs: 12_000 } satisfies Partial<ProviderError>);
  });
});

describe("youtubeVideoToMediaCandidate", () => {
  it("maps to a discovery/embed-only, rights-unclear, never-auto-eligible MediaCandidate with no importUrl", () => {
    const candidate = youtubeVideoToMediaCandidate(
      { videoId: "abc123", title: "How to cook pasta", description: "A quick pasta recipe video.", channelTitle: "Cooking Channel", publishedAt: "2026-01-01T00:00:00Z", thumbnailUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg" },
      { query: "pasta recipe", providerAccountId: "acc-1", queriedAt: "2026-09-27T00:00:00.000Z" },
    );
    expect(candidate).toMatchObject({
      candidateId: "youtube:video:abc123",
      source: "youtube",
      mediaType: "video",
      accessMethod: "api_embed",
      embedUrl: "https://www.youtube.com/embed/abc123",
      importUrl: null,
      rightsStatus: "unclear",
      descriptorText: "How to cook pasta A quick pasta recipe video.",
      eligibility: { autoEligible: false, reason: "discovery_and_embed_only_no_import_capability" },
    });
  });
});

describe("isYouTubeUrl", () => {
  it("accepts youtube.com/ytimg.com hosts and rejects lookalikes/private hosts", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=abc123")).toBe(true);
    expect(isYouTubeUrl("https://i.ytimg.com/vi/abc123/hqdefault.jpg")).toBe(true);
    expect(isYouTubeUrl("https://youtube.com.evil.example/watch")).toBe(false);
    expect(isYouTubeUrl("http://127.0.0.1/x")).toBe(false);
  });
});
