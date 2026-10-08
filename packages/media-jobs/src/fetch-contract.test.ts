import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildMediaFetchJob,
  buildMediaFetchJobKey,
  buildMediaSearchJob,
  buildMediaSearchJobKey,
  isAllowedSocialPostUrl,
  MEDIA_FETCH_RESULT_TYPE,
  MEDIA_JOB_SCHEMA_VERSION,
  MEDIA_SEARCH_RESULT_TYPE,
  parseMediaFetchResult,
  parseMediaSearchResult,
  validateMediaFetchJob,
  validateMediaSearchJob,
} from "./index.js";

const fetchJob = (over: Record<string, unknown> = {}) => ({
  ...buildMediaFetchJob({ jobKey: "fetch:abc", platform: "tiktok", tool: "yt-dlp", url: "https://www.tiktok.com/@a/video/7400000000000000000", mediaType: "video" }),
  ...over,
});

describe("media.fetch contract (VE2E-144)", () => {
  it("accepts a default TikTok job with safe defaults", () => {
    const v = validateMediaFetchJob(fetchJob());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value).toMatchObject({ maxBytes: 100 * 1024 * 1024, impersonate: "auto", useProxy: false, cookiesRelativePath: null, timeoutMs: 60_000, sectionStartMs: null });
  });

  it("only accepts https URLs on the platform's own hosts", () => {
    expect(isAllowedSocialPostUrl("tiktok", "https://vm.tiktok.com/ZMabc/")).toBe(true);
    expect(isAllowedSocialPostUrl("youtube", "https://youtu.be/abcdefghijk")).toBe(true);
    expect(isAllowedSocialPostUrl("youtube", "https://www.youtube.com/shorts/abcdefghijk")).toBe(true);
    expect(isAllowedSocialPostUrl("tiktok", "http://www.tiktok.com/@a/video/1")).toBe(false);
    expect(isAllowedSocialPostUrl("tiktok", "https://evil-tiktok.com/x")).toBe(false);
    expect(isAllowedSocialPostUrl("tiktok", "https://www.tiktok.com.evil.io/x")).toBe(false);
    expect(isAllowedSocialPostUrl("tiktok", "https://user:pw@www.tiktok.com/x")).toBe(false);
    expect(isAllowedSocialPostUrl("youtube", "https://www.tiktok.com/@a/video/1")).toBe(false);
    expect(validateMediaFetchJob(fetchJob({ url: "https://127.0.0.1/x" })).ok).toBe(false);
  });

  it("rejects cookies outside _private/cookies and path tricks", () => {
    expect(validateMediaFetchJob(fetchJob({ cookiesRelativePath: "_private/cookies/1.txt" })).ok).toBe(true);
    expect(validateMediaFetchJob(fetchJob({ cookiesRelativePath: "projects/p/assets/x.txt" })).ok).toBe(false);
    expect(validateMediaFetchJob(fetchJob({ cookiesRelativePath: "_private/cookies/../../etc/passwd" })).ok).toBe(false);
    expect(validateMediaFetchJob(fetchJob({ cookiesRelativePath: "/abs/cookies.txt" })).ok).toBe(false);
  });

  it("validates sections, budgets and size caps", () => {
    expect(validateMediaFetchJob(fetchJob({ sectionStartMs: 1000, sectionDurationMs: 8000 })).ok).toBe(true);
    expect(validateMediaFetchJob(fetchJob({ sectionStartMs: 1000 })).ok).toBe(false);
    expect(validateMediaFetchJob(fetchJob({ tool: "gallery-dl", sectionStartMs: 0, sectionDurationMs: 8000 })).ok).toBe(false);
    expect(validateMediaFetchJob(fetchJob({ timeoutMs: 100 })).ok).toBe(false);
    expect(validateMediaFetchJob(fetchJob({ maxBytes: 10 })).ok).toBe(false);
    expect(validateMediaFetchJob(fetchJob({ impersonate: "sometimes" })).ok).toBe(false);
  });

  it("derives stable job keys per post and window", () => {
    const a = buildMediaFetchJobKey({ platform: "tiktok", url: "https://www.tiktok.com/@a/video/1" });
    expect(a).toMatch(/^fetch:[0-9a-f]{40}$/);
    expect(buildMediaFetchJobKey({ platform: "tiktok", url: "https://www.tiktok.com/@a/video/1" })).toBe(a);
    expect(buildMediaFetchJobKey({ platform: "tiktok", url: "https://www.tiktok.com/@a/video/1", attempt: "cookies:2" })).not.toBe(a);
  });

  it("parses results and rejects malformed ones", () => {
    const ok = { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: MEDIA_FETCH_RESULT_TYPE, ok: true, jobKey: "k", quarantineToken: randomUUID(), bytes: 10, sha256: "a".repeat(64), info: {}, attempts: [] };
    expect(parseMediaFetchResult(ok)).not.toBeNull();
    expect(parseMediaFetchResult({ ...ok, quarantineToken: "../x" })).toBeNull();
    expect(parseMediaFetchResult({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: MEDIA_FETCH_RESULT_TYPE, ok: false, jobKey: "k", error: { code: "FETCH_FORBIDDEN", message: "", retryable: true, attempts: 2 } })).not.toBeNull();
    expect(parseMediaFetchResult({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: MEDIA_FETCH_RESULT_TYPE, ok: false, jobKey: "k", error: { code: "NOPE" } })).toBeNull();
  });
});

describe("media.search contract (VE2E-144)", () => {
  const job = (over: Record<string, unknown> = {}) => ({ ...buildMediaSearchJob({ jobKey: "search:1", platform: "youtube", tool: "yt-dlp", query: "メッシ 引退", mediaType: "video" }), ...over });

  it("accepts the supported (tool, platform) pairs only", () => {
    expect(validateMediaSearchJob(job()).ok).toBe(true);
    expect(validateMediaSearchJob(job({ tool: "gallery-dl", platform: "pinterest", mediaType: "image" })).ok).toBe(true);
    expect(validateMediaSearchJob(job({ platform: "tiktok" })).ok).toBe(false);
    expect(validateMediaSearchJob(job({ tool: "gallery-dl", platform: "youtube" })).ok).toBe(false);
  });

  it("rejects multi-line / empty queries and out-of-range limits", () => {
    expect(validateMediaSearchJob(job({ query: "a\n--exec x" })).ok).toBe(false);
    expect(validateMediaSearchJob(job({ query: "  " })).ok).toBe(false);
    expect(validateMediaSearchJob(job({ limit: 0 })).ok).toBe(false);
    expect(validateMediaSearchJob(job({ limit: 31 })).ok).toBe(false);
  });

  it("normalises the query in the key and parses results", () => {
    expect(buildMediaSearchJobKey({ platform: "youtube", tool: "yt-dlp", query: "ＭＥＳＳＩ", limit: 10 })).toBe(buildMediaSearchJobKey({ platform: "youtube", tool: "yt-dlp", query: "messi", limit: 10 }));
    expect(parseMediaSearchResult({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: MEDIA_SEARCH_RESULT_TYPE, ok: true, jobKey: "k", items: [{ url: "https://youtu.be/x" }], attempts: [] })).not.toBeNull();
    expect(parseMediaSearchResult({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: MEDIA_SEARCH_RESULT_TYPE, ok: true, jobKey: "k", items: [{}], attempts: [] })).toBeNull();
  });
});
