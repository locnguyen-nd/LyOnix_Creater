import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import {
  getPexelsPhoto,
  getPexelsVideo,
  isPexelsCdnUrl,
  pickPexelsVideoFile,
  probePexelsAccount,
  searchPexelsPhotos,
  searchPexelsVideos,
} from "./pexels.js";

afterEach(() => { vi.unstubAllGlobals(); });

const photoRow = {
  id: 42,
  width: 1080,
  height: 1920,
  url: "https://www.pexels.com/photo/some-photo-42/",
  photographer: "Jane Doe",
  photographer_url: "https://www.pexels.com/@jane-doe",
  src: { small: "https://images.pexels.com/photos/42/small.jpg", large: "https://images.pexels.com/photos/42/large.jpg", original: "https://images.pexels.com/photos/42/original.jpg" },
};

const videoRow = {
  id: 7,
  width: 1080,
  height: 1920,
  duration: 12,
  url: "https://www.pexels.com/video/some-video-7/",
  user: { name: "Studio X", url: "https://www.pexels.com/@studio-x" },
  video_pictures: [{ picture: "https://images.pexels.com/videos/7/thumb.jpg" }],
  video_files: [
    { quality: "sd", width: 540, height: 960, file_type: "video/mp4", link: "https://videos.pexels.com/video-files/7/7-sd.mp4" },
    { quality: "hd", width: 1080, height: 1920, file_type: "video/mp4", link: "https://videos.pexels.com/video-files/7/7-hd.mp4" },
    { quality: "uhd", width: 2160, height: 3840, file_type: "video/mp4", link: "https://videos.pexels.com/video-files/7/7-uhd.mp4" },
  ],
};

describe("probePexelsAccount", () => {
  it("calls the cheap curated endpoint and returns verifiedAt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ photos: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probePexelsAccount("key");
    expect(result.verifiedAt).toBeTruthy();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("/v1/curated");
  });

  it("maps 401 to PROVIDER_AUTH_INVALID (no fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));
    await expect(probePexelsAccount("bad")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" } satisfies Partial<ProviderError>);
  });

  it("maps 429 to PROVIDER_RATE_LIMITED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "retry-after": "2" } })));
    await expect(probePexelsAccount("key")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" } satisfies Partial<ProviderError>);
  });

  it("maps network failure to PROVIDER_TIMEOUT", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(probePexelsAccount("key")).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" } satisfies Partial<ProviderError>);
  });
});

describe("searchPexelsPhotos", () => {
  it("returns attribution and thumbnail/preview/download urls, forces portrait orientation", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ photos: [photoRow] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const results = await searchPexelsPhotos("key", "sunset");
    expect(results).toEqual([{
      externalId: "42",
      width: 1080,
      height: 1920,
      attribution: { photographerName: "Jane Doe", photographerUrl: "https://www.pexels.com/@jane-doe", pexelsPageUrl: "https://www.pexels.com/photo/some-photo-42/" },
      thumbnailUrl: "https://images.pexels.com/photos/42/small.jpg",
      previewUrl: "https://images.pexels.com/photos/42/large.jpg",
      downloadUrl: "https://images.pexels.com/photos/42/original.jpg",
    }]);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("orientation=portrait");
  });
});

describe("searchPexelsVideos / getPexelsVideo", () => {
  it("returns attribution and mp4 file options only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ videos: [videoRow] }), { status: 200 })));
    const results = await searchPexelsVideos("key", "city");
    expect(results[0]!.attribution).toEqual({ photographerName: "Studio X", photographerUrl: "https://www.pexels.com/@studio-x", pexelsPageUrl: "https://www.pexels.com/video/some-video-7/" });
    expect(results[0]!.fileOptions).toHaveLength(3);
    expect(results[0]!.thumbnailUrl).toBe("https://images.pexels.com/videos/7/thumb.jpg");
  });

  it("re-fetches a single video by id for authoritative download links", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(videoRow), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getPexelsVideo("key", "7");
    expect(result.externalId).toBe("7");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("/videos/videos/7");
  });
});

describe("getPexelsPhoto", () => {
  it("re-fetches a single photo by id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(photoRow), { status: 200 })));
    const result = await getPexelsPhoto("key", "42");
    expect(result.externalId).toBe("42");
    expect(result.downloadUrl).toBe("https://images.pexels.com/photos/42/original.jpg");
  });
});

describe("pickPexelsVideoFile", () => {
  it("prefers the smallest mp4 variant whose height already reaches HD (1280+)", () => {
    const picked = pickPexelsVideoFile(videoRow.video_files.map((f) => ({ quality: f.quality, width: f.width, height: f.height, fileType: f.file_type, link: f.link })));
    expect(picked?.quality).toBe("hd");
  });

  it("falls back to the largest available variant when none reach HD", () => {
    const files = [
      { quality: "sd", width: 320, height: 568, fileType: "video/mp4", link: "https://videos.pexels.com/a.mp4" },
      { quality: "sd2", width: 540, height: 960, fileType: "video/mp4", link: "https://videos.pexels.com/b.mp4" },
    ];
    expect(pickPexelsVideoFile(files)?.quality).toBe("sd2");
  });

  it("returns null when there is no usable mp4 file", () => {
    expect(pickPexelsVideoFile([{ quality: "hls", width: 0, height: 0, fileType: "video/mp4", link: "" }])).toBeNull();
  });
});

describe("isPexelsCdnUrl", () => {
  it("accepts images.pexels.com and videos.pexels.com", () => {
    expect(isPexelsCdnUrl("https://images.pexels.com/photos/42/original.jpg")).toBe(true);
    expect(isPexelsCdnUrl("https://videos.pexels.com/video-files/7/7-hd.mp4")).toBe(true);
  });

  it("rejects a lookalike domain (defense in depth beyond the generic SSRF guard)", () => {
    expect(isPexelsCdnUrl("https://images.pexels.com.evil.example/photos/42/original.jpg")).toBe(false);
    expect(isPexelsCdnUrl("https://evil.example/images.pexels.com")).toBe(false);
  });

  it("rejects a private/loopback host even if it happens to end with the suffix by trick", () => {
    expect(isPexelsCdnUrl("http://127.0.0.1/x")).toBe(false);
  });
});
