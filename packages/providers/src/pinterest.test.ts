import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { pinterestPinToMediaCandidate, probePinterestAccount, searchPinterestPins } from "./pinterest.js";

afterEach(() => { vi.unstubAllGlobals(); });

const pinRow = {
  id: "pin123",
  created_at: "2026-01-01T00:00:00Z",
  link: "https://example.com/original-post",
  title: "Cozy autumn kitchen",
  description: "Warm lighting, pumpkin spice, falling leaves.",
  alt_text: "A kitchen counter styled for autumn",
  dominant_color: "#a0522d",
  board_id: "board-1",
  creative_type: "REGULAR",
  media: {
    media_type: "image",
    images: {
      "150x150": { url: "https://i.pinimg.com/150x150/pin123.jpg", width: 150, height: 150 },
      "1200x": { url: "https://i.pinimg.com/1200x/pin123.jpg", width: 1200, height: 1600 },
    },
  },
};

describe("probePinterestAccount", () => {
  it("calls search/partner/pins with a minimal limit=1 probe and returns verifiedAt", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/v5/search/partner/pins?");
      expect(String(input)).toContain("limit=1");
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer tok");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await probePinterestAccount("tok");
    expect(result.verifiedAt).toBeTruthy();
  });

  it("maps a 401 to PROVIDER_AUTH_INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Invalid token" }), { status: 401 })));
    await expect(probePinterestAccount("bad")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" } satisfies Partial<ProviderError>);
  });

  it("maps a 403 (no partner search scope) to PROVIDER_CAPABILITY_UNAVAILABLE, never a silent empty result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Permission denied" }), { status: 403 })));
    await expect(probePinterestAccount("tok")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" } satisfies Partial<ProviderError>);
  });

  it("maps a network/timeout failure to PROVIDER_TIMEOUT", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(probePinterestAccount("tok")).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" } satisfies Partial<ProviderError>);
  });
});

describe("searchPinterestPins", () => {
  it("calls search/partner/pins (never search/pins) with term/country_code and maps pin fields", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain("/v5/search/partner/pins?");
      expect(url).not.toMatch(/\/v5\/search\/pins\?/);
      expect(url).toContain("term=autumn+kitchen");
      expect(url).toContain("country_code=US");
      return new Response(JSON.stringify({ items: [pinRow, { id: "" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const results = await searchPinterestPins("tok", "autumn kitchen", "US");
    expect(results).toEqual([{
      externalId: "pin123",
      createdAt: "2026-01-01T00:00:00Z",
      link: "https://example.com/original-post",
      title: "Cozy autumn kitchen",
      description: "Warm lighting, pumpkin spice, falling leaves.",
      altText: "A kitchen counter styled for autumn",
      dominantColor: "#a0522d",
      boardId: "board-1",
      creativeType: "REGULAR",
      mediaType: "image",
      previewUrl: "https://i.pinimg.com/1200x/pin123.jpg",
      widthPx: 1200,
      heightPx: 1600,
      downloadUrl: "https://i.pinimg.com/1200x/pin123.jpg",
    }]);
  });

  it("drops items with no pin id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "" }, { media: {} }] }), { status: 200 })));
    const results = await searchPinterestPins("tok", "x", "US");
    expect(results).toEqual([]);
  });

  it("parses a video pin using media.video_url, not an image bucket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [{ id: "vid1", media: { media_type: "video", video_url: "https://v.pinimg.com/videos/vid1.mp4", images: { "1200x": { url: "https://i.pinimg.com/1200x/vid1.jpg", width: 1200, height: 1600 } } } }],
    }), { status: 200 })));
    const [result] = await searchPinterestPins("tok", "x", "US");
    expect(result).toMatchObject({ mediaType: "video", downloadUrl: "https://v.pinimg.com/videos/vid1.mp4", previewUrl: "https://i.pinimg.com/1200x/vid1.jpg" });
  });

  it("degrades a malformed/missing media field to empty preview/import data instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "no-media" }] }), { status: 200 })));
    const [result] = await searchPinterestPins("tok", "x", "US");
    expect(result).toMatchObject({ externalId: "no-media", mediaType: "unknown", previewUrl: "", downloadUrl: null, widthPx: null, heightPx: null });
  });

  it("clamps limit to the documented 1..25 bound and passes bookmark/locale through", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain("limit=25");
      expect(url).toContain("bookmark=cursor1");
      expect(url).toContain("locale=en-US");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await searchPinterestPins("tok", "x", "US", { limit: 999, bookmark: "cursor1", locale: "en-US" });
  });

  it("maps a 429 to PROVIDER_RATE_LIMITED with retryAfterMs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "rate limited" }), { status: 429, headers: { "retry-after": "8" } })));
    await expect(searchPinterestPins("tok", "x", "US")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterMs: 8_000 } satisfies Partial<ProviderError>);
  });

  it("maps a 403 to PROVIDER_CAPABILITY_UNAVAILABLE and never falls back to a different endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "Permission denied" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchPinterestPins("tok", "x", "US")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" } satisfies Partial<ProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("pinterestPinToMediaCandidate", () => {
  it("maps to a rights-unclear, never-auto-eligible MediaCandidate that still carries preview/import/attribution data", () => {
    const candidate = pinterestPinToMediaCandidate(
      {
        externalId: "pin123",
        createdAt: "2026-01-01T00:00:00Z",
        link: "https://example.com/original-post",
        title: "Cozy autumn kitchen",
        description: "Warm lighting, pumpkin spice, falling leaves.",
        altText: "A kitchen counter styled for autumn",
        dominantColor: "#a0522d",
        boardId: "board-1",
        creativeType: "REGULAR",
        mediaType: "image",
        previewUrl: "https://i.pinimg.com/1200x/pin123.jpg",
        widthPx: 1200,
        heightPx: 1600,
        downloadUrl: "https://i.pinimg.com/1200x/pin123.jpg",
      },
      { query: "autumn kitchen", providerAccountId: "acc-1", queriedAt: "2026-09-27T00:00:00.000Z" },
    );
    expect(candidate).toMatchObject({
      candidateId: "pinterest:photo:pin123",
      source: "pinterest",
      mediaType: "photo",
      accessMethod: "api_download",
      previewUrl: "https://i.pinimg.com/1200x/pin123.jpg",
      importUrl: "https://i.pinimg.com/1200x/pin123.jpg",
      rightsStatus: "unclear",
      attribution: { name: "Pinterest", sourcePageUrl: "https://example.com/original-post" },
      descriptorText: "Cozy autumn kitchen Warm lighting, pumpkin spice, falling leaves. A kitchen counter styled for autumn",
      eligibility: { autoEligible: false, reason: "rights_unresolved" },
    });
  });

  it("marks a candidate with no parsed direct asset URL as discovery_only, still rights-unclear", () => {
    const candidate = pinterestPinToMediaCandidate(
      { externalId: "no-media", createdAt: "", link: "", title: "", description: "", altText: "", dominantColor: "", boardId: "", creativeType: "", mediaType: "unknown", previewUrl: "", widthPx: null, heightPx: null, downloadUrl: null },
      { query: "x", providerAccountId: "acc-1" },
    );
    expect(candidate).toMatchObject({ accessMethod: "discovery_only", importUrl: null, rightsStatus: "unclear", eligibility: { autoEligible: false, reason: "rights_unresolved" } });
  });

  it("never marks a Pinterest candidate rights-cleared or auto-eligible, unlike Pexels", () => {
    const candidate = pinterestPinToMediaCandidate(
      { externalId: "pin1", createdAt: "", link: "", title: "", description: "", altText: "", dominantColor: "", boardId: "", creativeType: "", mediaType: "image", previewUrl: "https://i.pinimg.com/x.jpg", widthPx: 100, heightPx: 100, downloadUrl: "https://i.pinimg.com/x.jpg" },
      { query: "x", providerAccountId: "acc-1" },
    );
    expect(candidate.rightsStatus).not.toBe("cleared");
    expect(candidate.eligibility.autoEligible).toBe(false);
  });
});
