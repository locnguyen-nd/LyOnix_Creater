import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MediaJobClientError, type MediaFetchJobInput, type MediaFetchResult, type MediaSearchJobInput, type MediaSearchResult } from "@lyonix/media-jobs";
import type { SocialFetcher } from "./media-jobs.gateway.js";
import { PlatformBreaker } from "./social-fetch-breaker.js";
import type { CookieAccount, SocialCookiesService } from "./social-cookies.service.js";
import { SocialFetchService } from "./social-fetch.service.js";

// VE2E-146: the API-side ladder (plain -> cookies rotation -> proxy) and the per-platform breaker. The worker is a fake gateway.

const ok = (jobKey: string): MediaFetchResult => ({
  schemaVersion: "media-job.v1", type: "media.fetch.result", ok: true, jobKey, quarantineToken: randomUUID(), bytes: 1, sha256: "a".repeat(64), probe: null, info: {} as any,
  attempts: [{ step: "plain", code: null, elapsedMs: 1 }], tool: { name: "yt-dlp", version: "v", profileVersion: "media-fetch.v1" }, elapsedMs: 1, completedAt: "",
});
const fail = (jobKey: string, code: string): MediaFetchResult => ({ schemaVersion: "media-job.v1", type: "media.fetch.result", ok: false, jobKey, error: { code: code as any, message: code, retryable: true, attempts: 1 }, attempts: [{ step: "plain", code: code as any, elapsedMs: 1 }], completedAt: "" });

const gateway = (answer: (job: MediaFetchJobInput, n: number) => MediaFetchResult | Error) => {
  const jobs: MediaFetchJobInput[] = [];
  const fake: SocialFetcher = {
    fetchMedia: vi.fn(async (job: MediaFetchJobInput) => {
      jobs.push(job);
      const r = answer(job, jobs.length - 1);
      if (r instanceof Error) throw r;
      return r;
    }),
    searchMedia: vi.fn(async (_job: MediaSearchJobInput): Promise<MediaSearchResult> => ({ schemaVersion: "media-job.v1", type: "media.search.result", ok: true, jobKey: "s", items: [], attempts: [], tool: { name: "yt-dlp", version: "v", profileVersion: "media-fetch.v1" }, elapsedMs: 1, completedAt: "" })),
  };
  return { fake, jobs };
};

const cookiePool = (accounts: string[]) => {
  const reported: Array<[string, string | null]> = [];
  const disposed: string[] = [];
  const svc = {
    candidates: vi.fn(async () => accounts.map((id): CookieAccount => ({ id, name: id, platform: "tiktok", encryptedSecret: "x" }))),
    materialize: vi.fn(async (a: CookieAccount) => ({ accountId: a.id, relativePath: `_private/cookies/${a.id}.txt`, dispose: async () => { disposed.push(a.id); } })),
    reportOutcome: vi.fn(async (id: string, code: string | null) => { reported.push([id, code]); return null; }),
  } as unknown as SocialCookiesService;
  return { svc, reported, disposed };
};

const input = { platform: "tiktok" as const, tool: "yt-dlp" as const, url: "https://www.tiktok.com/@a/video/1", mediaType: "video" as const, userId: "u", role: "staff" as const };

describe("SocialFetchService ladder (VE2E-146)", () => {
  it("plain success: no cookies touched", async () => {
    const { fake, jobs } = gateway((job) => ok(job.jobKey));
    const pool = cookiePool(["c1"]);
    const out = await new SocialFetchService(fake as any, pool.svc).fetchPost(input);
    expect(out.ok).toBe(true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ cookiesRelativePath: null, useProxy: false });
    expect(pool.svc.candidates).not.toHaveBeenCalled();
  });

  it("403 plain -> rotates cookies (bad one marked, next one works), every cookie file disposed", async () => {
    const { fake, jobs } = gateway((job, n) => (n === 0 ? fail(job.jobKey, "FETCH_FORBIDDEN") : n === 1 ? fail(job.jobKey, "FETCH_COOKIES_INVALID") : ok(job.jobKey)));
    const pool = cookiePool(["c1", "c2", "c3"]);
    const out = await new SocialFetchService(fake as any, pool.svc).fetchPost(input);
    expect(out.ok).toBe(true);
    expect(jobs.map((j) => j.cookiesRelativePath)).toEqual([null, "_private/cookies/c1.txt", "_private/cookies/c2.txt"]);
    expect(pool.reported).toEqual([["c1", "FETCH_COOKIES_INVALID"], ["c2", null]]);
    expect(pool.disposed).toEqual(["c1", "c2"]);
    expect(new Set(jobs.map((j) => j.jobKey)).size).toBe(3); // each step its own job key
    expect(out.steps.map((s) => s.via)).toEqual(["plain", "cookies", "cookies"]);
  });

  it("non-access failure (deleted post) stops at once: no cookies, no proxy", async () => {
    const { fake, jobs } = gateway((job) => fail(job.jobKey, "FETCH_UNAVAILABLE"));
    const pool = cookiePool(["c1"]);
    const out = await new SocialFetchService(fake as any, pool.svc).fetchPost(input);
    expect(out).toMatchObject({ ok: false, code: "FETCH_UNAVAILABLE" });
    expect(jobs).toHaveLength(1);
  });

  it("still blocked after cookies -> one proxy run when MEDIA_FETCH_USE_PROXY=1", async () => {
    process.env.MEDIA_FETCH_USE_PROXY = "1";
    try {
      const { fake, jobs } = gateway((job, n) => (n < 3 ? fail(job.jobKey, "FETCH_BOT_CHECK") : ok(job.jobKey)));
      const pool = cookiePool(["c1", "c2"]);
      const out = await new SocialFetchService(fake as any, pool.svc).fetchPost(input);
      expect(out.ok).toBe(true);
      expect(jobs.map((j) => j.useProxy)).toEqual([false, false, false, true]);
      expect(out.steps.at(-1)!.via).toBe("proxy");
    } finally {
      delete process.env.MEDIA_FETCH_USE_PROXY;
    }
  });

  it("worker not running -> FETCH_WORKER_UNAVAILABLE, breaker untouched", async () => {
    const { fake } = gateway(() => new MediaJobClientError("MEDIA_WORKER_NOT_CONFIGURED", "no broker"));
    const svc = new SocialFetchService(fake as any);
    const out = await svc.fetchPost(input);
    expect(out).toMatchObject({ ok: false, code: "FETCH_WORKER_UNAVAILABLE" });
    expect(svc.breaker.snapshot().tiktok?.recent ?? 0).toBe(0);
  });

  it("repeated blocking opens the platform breaker: later posts go straight to the fallback without a worker job", async () => {
    const { fake, jobs } = gateway((job) => fail(job.jobKey, "FETCH_FORBIDDEN"));
    const svc = new SocialFetchService(fake as any);
    for (let i = 0; i < 4; i += 1) await svc.fetchPost({ ...input, url: `https://www.tiktok.com/@a/video/${i}` });
    const before = jobs.length;
    const out = await svc.fetchPost({ ...input, url: "https://www.tiktok.com/@a/video/99" });
    expect(out).toMatchObject({ ok: false, code: "FETCH_BREAKER_OPEN" });
    expect(jobs.length).toBe(before);
  });
});

describe("PlatformBreaker (VE2E-146)", () => {
  const cfg = { windowMs: 60_000, ratio: 0.5, minSamples: 4, cooldownMs: 30_000 };

  it("opens at the ratio, refuses during the cool-down, lets ONE probe through, closes on success", () => {
    let t = 0;
    const b = new PlatformBreaker(cfg, () => t);
    b.record("tiktok", false);
    b.record("tiktok", true);
    b.record("tiktok", false);
    expect(b.allow("tiktok")).toBe(true);
    b.record("tiktok", true); // 2/4 blocked -> open
    expect(b.allow("tiktok")).toBe(false);
    expect(b.allow("youtube")).toBe(true); // per platform
    t = 31_000;
    expect(b.allow("tiktok")).toBe(true); // half-open probe
    expect(b.allow("tiktok")).toBe(false); // only one probe at a time
    b.record("tiktok", false);
    expect(b.allow("tiktok")).toBe(true);
  });

  it("a failed probe re-opens for another cool-down; old samples age out of the window", () => {
    let t = 0;
    const b = new PlatformBreaker(cfg, () => t);
    for (let i = 0; i < 4; i += 1) b.record("x", true);
    t = 31_000;
    expect(b.allow("x")).toBe(true);
    b.record("x", true);
    expect(b.allow("x")).toBe(false);
    const c = new PlatformBreaker(cfg, () => t);
    c.record("p", true);
    c.record("p", true);
    t += 120_000; // both aged out
    c.record("p", false);
    c.record("p", true);
    expect(c.allow("p")).toBe(true);
  });
});
