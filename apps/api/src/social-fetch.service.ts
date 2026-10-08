import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  buildMediaFetchJobKey,
  buildMediaSearchJobKey,
  DEFAULT_MEDIA_FETCH_TIMEOUT_MS,
  FETCH_ACCESS_ERRORS,
  MediaJobClientError,
  type MediaFetchAttempt,
  type MediaFetchSuccess,
  type MediaJobErrorCode,
  type SocialFetchPlatform,
  type SocialFetchTool,
  type SocialSearchItem,
} from "@lyonix/media-jobs";
import { mediaRoot } from "./handoff-workspace.js";
import { MediaJobsGateway, type SocialFetcher } from "./media-jobs.gateway.js";
import { PlatformBreaker } from "./social-fetch-breaker.js";
import { SocialCookiesService, type CookieAccount } from "./social-cookies.service.js";

/** One worker job of the API-side ladder (CR-MEDIA-OSS-FETCH §3.2): which access was used and how it ended. */
export type SocialFetchStep = { via: "plain" | "cookies" | "proxy"; cookiesAccountId: string | null; code: MediaJobErrorCode | null; runs: MediaFetchAttempt[] };

export type SocialFetchOutcome =
  | { ok: true; result: MediaFetchSuccess; steps: SocialFetchStep[]; elapsedMs: number }
  | { ok: false; code: MediaJobErrorCode | "FETCH_DISABLED" | "FETCH_BREAKER_OPEN" | "FETCH_WORKER_UNAVAILABLE"; message: string; steps: SocialFetchStep[]; elapsedMs: number };

export type SocialSearchOutcome =
  | { ok: true; items: SocialSearchItem[]; steps: SocialFetchStep[]; elapsedMs: number }
  | { ok: false; code: MediaJobErrorCode | "FETCH_DISABLED" | "FETCH_BREAKER_OPEN" | "FETCH_WORKER_UNAVAILABLE"; message: string; steps: SocialFetchStep[]; elapsedMs: number };

const flag = (value: string | undefined): boolean => ["1", "true", "on", "yes"].includes((value ?? "").trim().toLowerCase());

/** `MEDIA_FETCH_YTDLP` (TikTok phase 2), `MEDIA_FETCH_GALLERYDL` (gallery tier), `MEDIA_SOURCE_YT_SHORTS` (Shorts tier): all default OFF. */
export const socialFetchEnabled = (what: "tiktok_download" | "gallery" | "youtube_shorts", env: NodeJS.ProcessEnv = process.env): boolean =>
  flag(what === "tiktok_download" ? env.MEDIA_FETCH_YTDLP : what === "gallery" ? env.MEDIA_FETCH_GALLERYDL : env.MEDIA_SOURCE_YT_SHORTS);

const jobTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const value = Number(env.MEDIA_FETCH_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 5_000 && value <= 10 * 60_000 ? value : DEFAULT_MEDIA_FETCH_TIMEOUT_MS;
};

/** At most this many cookie accounts are tried for one post (each is a full worker job). */
const MAX_COOKIE_ROTATIONS = 2;

/** Reads the first bytes of a quarantined download (enough for `sniffMediaMimeType`), never the whole file. */
export async function readQuarantineHead(token: string, bytes = 4096): Promise<Buffer> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("invalid quarantine token");
  const handle = await open(join(mediaRoot(), "_quarantine", token), "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function discardQuarantined(token: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return;
  await unlink(join(mediaRoot(), "_quarantine", token)).catch(() => undefined);
}

/**
 * VE2E-146 (CR-MEDIA-OSS-FETCH §3.2 steps 3-5, API side): downloads / searches one social post through the media worker's yt-dlp /
 * gallery-dl, with the recovery that needs secrets or global knowledge:
 *   plain (no cookies; the worker already retried once and tried impersonation)
 *   -> on an access failure (403 / bot check / cookies / 429): up to MAX_COOKIE_ROTATIONS cookie accounts of the platform, least recently
 *      used first; each outcome is fed back (invalid -> account failed, bot-check / 429 -> account cools down)
 *   -> still blocked and MEDIA_FETCH_USE_PROXY=1: one run through the worker's proxy (with the best cookies, if any)
 *   -> the caller falls back (Apify phase 2, next candidate, the L4-L6 ladder).
 * The per-platform breaker skips all of this while the platform is blocking us. Never throws.
 */
@Injectable()
export class SocialFetchService {
  readonly breaker = new PlatformBreaker();

  constructor(
    @Inject(MediaJobsGateway) private readonly gateway: SocialFetcher,
    @Optional() @Inject(SocialCookiesService) private readonly cookies?: SocialCookiesService,
  ) {}

  async fetchPost(input: {
    platform: SocialFetchPlatform;
    tool: SocialFetchTool;
    url: string;
    mediaType: "video" | "image";
    userId: string;
    role: "admin" | "staff";
    section?: { startMs: number; durationMs: number } | null;
  }): Promise<SocialFetchOutcome> {
    return this.ladder(input.platform, input.userId, input.role, async (access, attempt) => {
      const result = await this.gateway.fetchMedia({
        jobKey: buildMediaFetchJobKey({ platform: input.platform, url: input.url, sectionStartMs: input.section?.startMs ?? null, sectionDurationMs: input.section?.durationMs ?? null, attempt }),
        platform: input.platform,
        tool: input.tool,
        url: input.url,
        mediaType: input.mediaType,
        sectionStartMs: input.section?.startMs ?? null,
        sectionDurationMs: input.section?.durationMs ?? null,
        cookiesRelativePath: access.cookiesRelativePath,
        useProxy: access.useProxy,
        timeoutMs: jobTimeoutMs(),
      });
      return result.ok ? { ok: true as const, value: result, runs: result.attempts } : { ok: false as const, code: result.error.code, message: result.error.message, runs: result.attempts ?? [] };
    }) as Promise<SocialFetchOutcome>;
  }

  async search(input: { platform: SocialFetchPlatform; tool: SocialFetchTool; query: string; limit: number; mediaType: "video" | "image"; userId: string; role: "admin" | "staff" }): Promise<SocialSearchOutcome> {
    const outcome = await this.ladder(input.platform, input.userId, input.role, async (access, attempt) => {
      const result = await this.gateway.searchMedia({
        jobKey: buildMediaSearchJobKey({ platform: input.platform, tool: input.tool, query: input.query, limit: input.limit, nonce: attempt }),
        platform: input.platform,
        tool: input.tool,
        query: input.query,
        limit: input.limit,
        mediaType: input.mediaType,
        cookiesRelativePath: access.cookiesRelativePath,
        useProxy: access.useProxy,
        timeoutMs: jobTimeoutMs(),
      });
      return result.ok ? { ok: true as const, value: result.items, runs: result.attempts } : { ok: false as const, code: result.error.code, message: result.error.message, runs: result.attempts ?? [] };
    });
    return outcome.ok ? { ok: true, items: outcome.result, steps: outcome.steps, elapsedMs: outcome.elapsedMs } : outcome;
  }

  private async ladder<T>(
    platform: SocialFetchPlatform,
    userId: string,
    role: "admin" | "staff",
    run: (
      access: { cookiesRelativePath: string | null; useProxy: boolean },
      attempt: string,
    ) => Promise<{ ok: true; value: T; runs: MediaFetchAttempt[] } | { ok: false; code: MediaJobErrorCode; message: string; runs: MediaFetchAttempt[] }>,
  ): Promise<{ ok: true; result: T; steps: SocialFetchStep[]; elapsedMs: number } | Extract<SocialFetchOutcome, { ok: false }>> {
    const startedAt = Date.now();
    const steps: SocialFetchStep[] = [];
    const done = (code: Extract<SocialFetchOutcome, { ok: false }>["code"], message: string) => ({ ok: false as const, code, message, steps, elapsedMs: Date.now() - startedAt });
    if (!this.breaker.allow(platform)) return done("FETCH_BREAKER_OPEN", `${platform}: too many recent 403 / bot checks, using the fallback for now`);

    const once = async (via: SocialFetchStep["via"], cookies: CookieAccount | null, useProxy: boolean) => {
      const materialized = cookies && this.cookies ? await this.cookies.materialize(cookies) : null;
      try {
        const r = await run({ cookiesRelativePath: materialized?.relativePath ?? null, useProxy }, `${steps.length}:${cookies?.id ?? "none"}:${useProxy ? "proxy" : "direct"}`);
        steps.push({ via, cookiesAccountId: cookies?.id ?? null, code: r.ok ? null : r.code, runs: r.runs });
        if (cookies && this.cookies) await this.cookies.reportOutcome(cookies.id, r.ok ? null : r.code).catch(() => undefined);
        return r;
      } finally {
        await materialized?.dispose();
      }
    };

    try {
      let last = await once("plain", null, false);
      if (!last.ok && FETCH_ACCESS_ERRORS.has(last.code) && this.cookies) {
        const pool = (await this.cookies.candidates(platform, userId, role).catch(() => [] as CookieAccount[])).slice(0, MAX_COOKIE_ROTATIONS);
        for (const account of pool) {
          last = await once("cookies", account, false);
          if (last.ok || !FETCH_ACCESS_ERRORS.has(last.code)) break;
        }
      }
      if (!last.ok && FETCH_ACCESS_ERRORS.has(last.code) && flag(process.env.MEDIA_FETCH_USE_PROXY)) {
        const best = this.cookies ? (await this.cookies.candidates(platform, userId, role).catch(() => [] as CookieAccount[]))[0] ?? null : null;
        last = await once("proxy", best, true);
      }
      if (last.ok) {
        this.breaker.record(platform, false);
        return { ok: true, result: last.value, steps, elapsedMs: Date.now() - startedAt };
      }
      if (FETCH_ACCESS_ERRORS.has(last.code)) this.breaker.record(platform, true);
      return done(last.code, last.message);
    } catch (error) {
      // Transport problem (worker not running, broker down, no answer in time): not a platform signal, the breaker is untouched.
      if (error instanceof MediaJobClientError) return done("FETCH_WORKER_UNAVAILABLE", `${error.code}: ${error.message}`);
      return done("FETCH_FAILED", error instanceof Error ? error.message : "unexpected error");
    }
  }
}
