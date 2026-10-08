import { describe, expect, it } from "vitest";
import {
  buildGalleryDlFetchArgs,
  buildYtDlpFetchArgs,
  buildYtDlpSearchArgs,
  classifyFetchFailure,
  firstFetchStep,
  gallerySearchUrl,
  lastJsonLine,
  nextFetchStep,
  parseGallerySearch,
  parseYtDlpSearch,
  redactCliText,
} from "./cli.js";

const noAccess = { cookiesPath: null, proxyUrl: null, impersonate: false };

describe("yt-dlp / gallery-dl arguments (VE2E-144)", () => {
  it("puts the URL after -- and adds access options only when asked", () => {
    const plain = buildYtDlpFetchArgs({ url: "https://www.tiktok.com/@a/video/1", outputTemplate: "/q/.fetch-1/media.%(ext)s", maxBytes: 1000, ffmpegPath: "ffmpeg", access: noAccess, section: null });
    expect(plain.at(-2)).toBe("--");
    expect(plain.at(-1)).toBe("https://www.tiktok.com/@a/video/1");
    expect(plain).toContain("--ignore-config");
    expect(plain).not.toContain("--cookies");
    expect(plain).not.toContain("--impersonate");
    expect(plain).not.toContain("--download-sections");
    const full = buildYtDlpFetchArgs({ url: "https://youtu.be/x", outputTemplate: "o", maxBytes: 1000, ffmpegPath: "ffmpeg", access: { cookiesPath: "/c.txt", proxyUrl: "socks5://p:1", impersonate: true }, section: { startMs: 1500, durationMs: 8000 } });
    expect(full.join(" ")).toContain("--cookies /c.txt --proxy socks5://p:1 --impersonate chrome");
    expect(full.join(" ")).toContain("--download-sections *1.5-9.5");
  });

  it("gallery-dl: first file only, metadata file, size cap in KiB, browser emulation instead of curl_cffi", () => {
    const args = buildGalleryDlFetchArgs({ url: "https://www.pinterest.com/pin/1/", directory: "/q/d", maxBytes: 20 * 1024 * 1024, access: { ...noAccess, impersonate: true } });
    expect(args.join(" ")).toContain("--range 1 -D /q/d -f media.{extension} --write-metadata --filesize-max 20480k");
    expect(args.join(" ")).toContain("-o browser=firefox");
    expect(args.at(-1)).toBe("https://www.pinterest.com/pin/1/");
  });

  it("search: ytsearchN:<query> after -- (an option-looking keyword stays data)", () => {
    const args = buildYtDlpSearchArgs({ query: "--exec rm", limit: 12, access: noAccess });
    expect(args.slice(-2)).toEqual(["--", "ytsearch12:--exec rm"]);
    expect(gallerySearchUrl("pinterest", "東京 夜景")).toBe("https://www.pinterest.com/search/pins/?q=%E6%9D%B1%E4%BA%AC%20%E5%A4%9C%E6%99%AF");
    expect(gallerySearchUrl("youtube", "x")).toBeNull();
  });
});

describe("classifyFetchFailure (VE2E-144)", () => {
  it.each([
    ["ERROR: [TikTok] 7400: Unable to download webpage: HTTP Error 403: Forbidden", "FETCH_FORBIDDEN"],
    ["ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies", "FETCH_BOT_CHECK"],
    ["WARNING: The provided YouTube account cookies are no longer valid. They have likely been rotated", "FETCH_COOKIES_INVALID"],
    ["ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests", "FETCH_RATE_LIMITED"],
    ["ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", "FETCH_UNAVAILABLE"],
    ["ERROR: [TikTok] 1: Unable to extract universal data for rehydration", "FETCH_EXTRACTOR_BROKEN"],
    ["ERROR: Unsupported URL: https://x.com/home", "FETCH_EXTRACTOR_BROKEN"],
    ["[download] File is larger than max-filesize (123 bytes > 100 bytes). Aborting.", "FETCH_TOO_LARGE"],
    ["ERROR: Unable to download: <urlopen error [Errno -3] Temporary failure in name resolution>", "FETCH_NETWORK"],
    ["something else entirely", "FETCH_FAILED"],
  ])("%s -> %s", (stderr, code) => {
    expect(classifyFetchFailure("yt-dlp", 1, stderr)).toBe(code);
  });

  it("uses gallery-dl exit bits when stderr says nothing specific", () => {
    expect(classifyFetchFailure("gallery-dl", 16, "")).toBe("FETCH_BOT_CHECK");
    expect(classifyFetchFailure("gallery-dl", 8, "")).toBe("FETCH_UNAVAILABLE");
    expect(classifyFetchFailure("gallery-dl", 64, "")).toBe("FETCH_EXTRACTOR_BROKEN");
    expect(classifyFetchFailure("gallery-dl", 4, "")).toBe("FETCH_FORBIDDEN");
    expect(classifyFetchFailure("gallery-dl", 1, "[pinterest][error] HttpError: '403 Forbidden' for 'https://...'")).toBe("FETCH_FORBIDDEN");
  });
});

describe("nextFetchStep: in-worker recovery (VE2E-144 / CR §3.2 steps 1-2)", () => {
  const a = (step: "plain" | "retry" | "impersonate", code: Parameters<typeof nextFetchStep>[0][number]["code"]) => ({ step, code, elapsedMs: 1 });

  it("403: fresh re-extraction, then impersonation, then stop", () => {
    expect(nextFetchStep([a("plain", "FETCH_FORBIDDEN")], "auto", true)).toBe("retry");
    expect(nextFetchStep([a("plain", "FETCH_FORBIDDEN"), a("retry", "FETCH_FORBIDDEN")], "auto", true)).toBe("impersonate");
    expect(nextFetchStep([a("plain", "FETCH_FORBIDDEN"), a("retry", "FETCH_FORBIDDEN"), a("impersonate", "FETCH_FORBIDDEN")], "auto", true)).toBeNull();
  });

  it("bot check goes straight to impersonation; never when disabled or curl_cffi is missing", () => {
    expect(nextFetchStep([a("plain", "FETCH_BOT_CHECK")], "auto", true)).toBe("impersonate");
    expect(nextFetchStep([a("plain", "FETCH_BOT_CHECK")], "never", true)).toBeNull();
    expect(nextFetchStep([a("plain", "FETCH_BOT_CHECK")], "auto", false)).toBeNull();
  });

  it("does not retry what the API must handle or nothing can fix", () => {
    for (const code of ["FETCH_COOKIES_INVALID", "FETCH_RATE_LIMITED", "FETCH_UNAVAILABLE", "FETCH_TOO_LARGE", "FETCH_EXTRACTOR_BROKEN", "FETCH_TOOL_MISSING"] as const) {
      expect(nextFetchStep([a("plain", code)], "auto", true)).toBeNull();
    }
    expect(nextFetchStep([a("plain", null)], "auto", true)).toBeNull();
  });

  it("network errors get one retry only", () => {
    expect(nextFetchStep([a("plain", "FETCH_NETWORK")], "auto", true)).toBe("retry");
    expect(nextFetchStep([a("plain", "FETCH_NETWORK"), a("retry", "FETCH_NETWORK")], "auto", true)).toBeNull();
  });

  it("starts impersonated when the job says always", () => {
    expect(firstFetchStep("always")).toBe("impersonate");
    expect(firstFetchStep("auto")).toBe("plain");
  });
});

describe("output parsing (VE2E-144)", () => {
  it("reads the last JSON line of yt-dlp -j --no-simulate", () => {
    expect(lastJsonLine('[download] 100%\n{"id":"1","title":"a"}\n[info] done\n')).toEqual({ id: "1", title: "a" });
    expect(lastJsonLine("no json")).toBeNull();
  });

  it("parses ytsearch flat entries into canonical URLs, de-duplicated", () => {
    const out = JSON.stringify({
      entries: [
        { id: "abcdefghijk", url: "https://www.youtube.com/shorts/abcdefghijk", title: "メッシ", duration: 42, channel: "ch" },
        { id: "abcdefghijk", url: "https://www.youtube.com/shorts/abcdefghijk" },
        { id: "zyxwvutsrqp", url: "https://evil.example/x", duration: 300 },
        { id: "bad id!" },
      ],
    });
    const items = parseYtDlpSearch(out, 10);
    expect(items.map((i) => i.url)).toEqual(["https://www.youtube.com/shorts/abcdefghijk", "https://www.youtube.com/watch?v=zyxwvutsrqp"]);
    expect(items[0]).toMatchObject({ externalId: "abcdefghijk", durationSeconds: 42, channel: "ch", mediaType: "video" });
  });

  it("parses gallery-dl -j Url messages (Pinterest pins, X media), keeps the wanted media type, one item per post", () => {
    const out = JSON.stringify([
      [2, { category: "pinterest" }],
      [3, "https://i.pinimg.com/originals/a.jpg", { id: 111, grid_title: "夜景", extension: "jpg", width: 1000, height: 1500, pinner: { username: "u" } }],
      [3, "https://i.pinimg.com/originals/b.jpg", { id: 111, extension: "jpg" }],
      [3, "https://v.pinimg.com/x.mp4", { id: 222, extension: "mp4" }],
    ]);
    const items = parseGallerySearch("pinterest", out, "image", 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ url: "https://www.pinterest.com/pin/111/", title: "夜景", width: 1000, height: 1500, uploader: "u", mediaType: "image" });
    const x = parseGallerySearch("x", JSON.stringify([[3, "https://pbs.twimg.com/media/a.jpg", { tweet_id: 9, author: { name: "nhk" }, content: "地震", lang: "ja", extension: "jpg" }]]), "image", 5);
    expect(x[0]).toMatchObject({ url: "https://x.com/nhk/status/9", description: "地震", language: "ja" });
    expect(parseGallerySearch("x", "not json", "image", 5)).toEqual([]);
  });

  it("redacts signed-URL tokens, proxy credentials and long secrets", () => {
    const text = redactCliText("GET https://user:pass@proxy:1/ https://v16.tiktokcdn.com/v?x-expires=1&signature=abc&tt_chain_token=zzz " + "a".repeat(50));
    expect(text).not.toContain("pass");
    expect(text).not.toContain("signature=abc");
    expect(text).not.toContain("tt_chain_token=zzz");
    expect(text).not.toContain("a".repeat(50));
  });
});
