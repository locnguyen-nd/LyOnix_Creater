import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMediaFetchJob, buildMediaSearchJob } from "@lyonix/media-jobs";
import { BinaryNotFoundError, type ProcessRunner } from "../process.js";
import { SocialFetchProcessor, sweepStaleFetchDirs } from "./processor.js";

type Call = { binary: string; args: readonly string[] };

/**
 * Fake CLIs: `script` decides, per call, what yt-dlp / gallery-dl "does" (write the file into the -o / -D directory, print JSON,
 * fail with a stderr). ffprobe answers a fixed vertical H.264 stream.
 */
const fakeRunner = (script: (call: Call, index: number) => Promise<{ exitCode: number; stdout?: string; stderr?: string }> | { exitCode: number; stdout?: string; stderr?: string }) => {
  const calls: Call[] = [];
  let toolCalls = 0;
  const runner: ProcessRunner = async (binary, args) => {
    if (args[0] === "--version") return { exitCode: 0, stdout: binary.includes("gallery") ? "1.32.15\n" : "2026.08.19\n", stderrTail: "" };
    if (binary === "ffprobe") {
      return { exitCode: 0, stdout: JSON.stringify({ format: { duration: "12.5", format_name: "mp4" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1" }] }), stderrTail: "" };
    }
    calls.push({ binary, args });
    const r = await script({ binary, args }, toolCalls++);
    return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderrTail: r.stderr ?? "" };
  };
  return { runner, calls };
};

const outDirOf = (args: readonly string[]): string => {
  const o = args.indexOf("-o");
  if (o >= 0 && args[o + 1]!.includes("%(ext)s")) return args[o + 1]!.replace(/[\\/]media\.%\(ext\)s$/, "");
  return args[args.indexOf("-D") + 1]!;
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lyonix-fetch-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const processor = (runner: ProcessRunner, now?: () => number) =>
  new SocialFetchProcessor({
    config: { mediaRoot: root, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
    fetch: { enabled: true, queue: "q", prefetch: 2, ytDlpPath: "yt-dlp", galleryDlPath: "gallery-dl", proxyUrl: "socks5://proxy:1080" },
    runner,
    ...(now ? { now } : {}),
  });

const tiktok = (over: Partial<Parameters<typeof buildMediaFetchJob>[0]> = {}) =>
  buildMediaFetchJob({ jobKey: "fetch:t1", platform: "tiktok", tool: "yt-dlp", url: "https://www.tiktok.com/@a/video/7400000000000000001", mediaType: "video", ...over });

describe("SocialFetchProcessor media.fetch (VE2E-144)", () => {
  it("downloads into _quarantine/<uuid> with metadata, probe and sha256; no temp dir left", async () => {
    const { runner, calls } = fakeRunner(async ({ args }) => {
      await writeFile(join(outDirOf(args), "media.mp4"), Buffer.from("fake-mp4-bytes"));
      return { exitCode: 0, stdout: `[download] ok\n${JSON.stringify({ id: "7400000000000000001", title: "メッシ", uploader: "fan", duration: 12.5, width: 1080, height: 1920, tags: ["messi"] })}\n` };
    });
    const result = await processor(runner).handleFetch(tiktok());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toEqual([{ step: "plain", code: null, elapsedMs: expect.any(Number) }]);
    expect(result.info).toMatchObject({ externalId: "7400000000000000001", title: "メッシ", uploader: "fan", tags: ["messi"] });
    expect(result.probe).toEqual({ durationMs: 12500, width: 1080, height: 1920, videoCodec: "h264" });
    expect(result.tool).toMatchObject({ name: "yt-dlp", version: "2026.08.19" });
    expect(await readFile(join(root, "_quarantine", result.quarantineToken), "utf8")).toBe("fake-mp4-bytes");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await readdir(join(root, "_quarantine"))).filter((n) => n.startsWith(".fetch-"))).toEqual([]);
    expect(calls[0]!.args).not.toContain("--impersonate");
  });

  it("403 -> fresh re-extraction -> impersonation succeeds", async () => {
    const { runner, calls } = fakeRunner(async ({ args }, i) => {
      if (i < 2) return { exitCode: 1, stderr: "ERROR: [TikTok] 1: HTTP Error 403: Forbidden" };
      await writeFile(join(outDirOf(args), "media.mp4"), "x");
      return { exitCode: 0, stdout: "{}" };
    });
    const result = await processor(runner).handleFetch(tiktok());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts.map((a) => [a.step, a.code])).toEqual([["plain", "FETCH_FORBIDDEN"], ["retry", "FETCH_FORBIDDEN"], ["impersonate", null]]);
    expect(calls[2]!.args).toContain("--impersonate");
  });

  it("returns the final code + every run when recovery is exhausted (API then rotates cookies / falls back to Apify)", async () => {
    const { runner } = fakeRunner(() => ({ exitCode: 1, stderr: "ERROR: [youtube] x: Sign in to confirm you're not a bot" }));
    const result = await processor(runner).handleFetch(tiktok({ platform: "youtube", url: "https://www.youtube.com/shorts/abcdefghijk" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "FETCH_BOT_CHECK", retryable: true, attempts: 2 });
    expect(result.attempts?.map((a) => a.step)).toEqual(["plain", "impersonate"]);
  });

  it("stops at once on cookies invalid / unavailable (no pointless retries)", async () => {
    const { runner, calls } = fakeRunner(() => ({ exitCode: 1, stderr: "ERROR: Video unavailable. This video is private" }));
    const result = await processor(runner).handleFetch(tiktok());
    expect(result.ok ? null : result.error.code).toBe("FETCH_UNAVAILABLE");
    expect(calls).toHaveLength(1);
  });

  it("skips impersonation for later jobs once curl_cffi is reported missing", async () => {
    let n = 0;
    const { runner } = fakeRunner(() => {
      n += 1;
      return { exitCode: 1, stderr: n === 2 ? "ERROR: Impersonate target \"chrome\" is not available. HTTP Error 403: Forbidden" : "ERROR: HTTP Error 403: Forbidden" };
    });
    const p = processor(runner);
    await p.handleFetch(tiktok());
    const second = await p.handleFetch(tiktok({ jobKey: "fetch:t2", url: "https://www.tiktok.com/@a/video/7400000000000000002" }));
    expect(second.ok ? [] : second.attempts?.map((a) => a.step)).toEqual(["plain", "retry"]);
  });

  it("exit 0 without a file because of --max-filesize -> FETCH_TOO_LARGE", async () => {
    const { runner } = fakeRunner(() => ({ exitCode: 0, stdout: "{}", stderr: "[download] File is larger than max-filesize (999 bytes > 10 bytes). Aborting." }));
    const result = await processor(runner).handleFetch(tiktok());
    expect(result.ok ? null : result.error.code).toBe("FETCH_TOO_LARGE");
  });

  it("missing binary -> FETCH_TOOL_MISSING (not retryable)", async () => {
    const runner: ProcessRunner = async (binary) => {
      throw new BinaryNotFoundError(binary);
    };
    const result = await processor(runner).handleFetch(tiktok());
    expect(result.ok ? null : result.error).toMatchObject({ code: "FETCH_TOOL_MISSING", retryable: false });
  });

  it("passes cookies + proxy only when the job asks, and rejects a missing cookies file", async () => {
    await mkdir(join(root, "_private/cookies"), { recursive: true });
    await writeFile(join(root, "_private/cookies/c1.txt"), "# Netscape HTTP Cookie File\n");
    const { runner, calls } = fakeRunner(async ({ args }) => {
      await writeFile(join(outDirOf(args), "media.mp4"), "x");
      return { exitCode: 0, stdout: "{}" };
    });
    const p = processor(runner);
    const ok = await p.handleFetch(tiktok({ cookiesRelativePath: "_private/cookies/c1.txt", useProxy: true }));
    expect(ok.ok).toBe(true);
    const joined = calls[0]!.args.join(" ");
    expect(joined).toContain("--cookies");
    expect(joined).toContain("--proxy socks5://proxy:1080");
    const missing = await p.handleFetch(tiktok({ jobKey: "fetch:t3", cookiesRelativePath: "_private/cookies/none.txt" }));
    expect(missing.ok ? null : missing.error.code).toBe("FETCH_COOKIES_INVALID");
  });

  it("gallery-dl image: reads the .json metadata file, no ffprobe", async () => {
    const { runner } = fakeRunner(async ({ args }) => {
      const dir = outDirOf(args);
      await writeFile(join(dir, "media.jpg"), "jpg");
      await writeFile(join(dir, "media.jpg.json"), JSON.stringify({ id: 55, grid_title: "東京", width: 800, height: 1200 }));
      return { exitCode: 0 };
    });
    const result = await processor(runner).handleFetch(buildMediaFetchJob({ jobKey: "fetch:p1", platform: "pinterest", tool: "gallery-dl", url: "https://www.pinterest.com/pin/55/", mediaType: "image" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe).toBeNull();
    expect(result.info).toMatchObject({ externalId: "55", title: "東京", webpageUrl: "https://www.pinterest.com/pin/55/" });
  });

  it("de-duplicates concurrent deliveries of one jobKey", async () => {
    const { runner, calls } = fakeRunner(async ({ args }) => {
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(join(outDirOf(args), "media.mp4"), "x");
      return { exitCode: 0, stdout: "{}" };
    });
    const p = processor(runner);
    const [a, b] = await Promise.all([p.handleFetch(tiktok()), p.handleFetch(tiktok())]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("invalid job -> INVALID_JOB without running anything", async () => {
    const { runner, calls } = fakeRunner(() => ({ exitCode: 0 }));
    const result = await processor(runner).handleFetch({ ...tiktok(), url: "https://evil.example/v.mp4" });
    expect(result.ok ? null : result.error.code).toBe("INVALID_JOB");
    expect(calls).toHaveLength(0);
  });
});

describe("SocialFetchProcessor media.search (VE2E-144)", () => {
  it("yt-dlp ytsearch -> items", async () => {
    const { runner, calls } = fakeRunner(() => ({ exitCode: 0, stdout: JSON.stringify({ entries: [{ id: "abcdefghijk", url: "https://www.youtube.com/shorts/abcdefghijk", title: "t", duration: 30 }] }) }));
    const result = await processor(runner).handleSearch(buildMediaSearchJob({ jobKey: "search:1", platform: "youtube", tool: "yt-dlp", query: "メッシ", limit: 5, mediaType: "video" }));
    expect(result.ok ? result.items.map((i) => i.url) : null).toEqual(["https://www.youtube.com/shorts/abcdefghijk"]);
    expect(calls[0]!.args.at(-1)).toBe("ytsearch5:メッシ");
  });

  it("gallery-dl Pinterest search with recovery on 403", async () => {
    const { runner, calls } = fakeRunner((_c, i) =>
      i === 0 ? { exitCode: 4, stderr: "[pinterest][error] HttpError: '403 Forbidden'" } : { exitCode: 0, stdout: JSON.stringify([[3, "https://i.pinimg.com/a.jpg", { id: 1, extension: "jpg" }]]) },
    );
    const result = await processor(runner).handleSearch(buildMediaSearchJob({ jobKey: "search:2", platform: "pinterest", tool: "gallery-dl", query: "夜景", limit: 5, mediaType: "image" }));
    expect(result.ok ? result.items.length : -1).toBe(1);
    expect(result.ok ? result.attempts.map((a) => a.step) : []).toEqual(["plain", "retry"]);
    expect(calls[1]!.args.at(-1)).toBe("https://www.pinterest.com/search/pins/?q=%E5%A4%9C%E6%99%AF");
  });
});

describe("sweepStaleFetchDirs", () => {
  it("removes only old .fetch-* directories", async () => {
    const q = join(root, "_quarantine");
    await mkdir(join(q, ".fetch-old"), { recursive: true });
    await mkdir(join(q, ".fetch-new"), { recursive: true });
    await writeFile(join(q, "keep-token"), "x");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(join(q, ".fetch-old"), old, old);
    expect(await sweepStaleFetchDirs(root, 60 * 60_000)).toBe(1);
    expect((await readdir(q)).sort()).toEqual([".fetch-new", "keep-token"]);
  });
});
