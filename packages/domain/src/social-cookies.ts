/**
 * VE2E-145 (CR-MEDIA-OSS-FETCH §3.3): cookies.txt (Netscape format, what yt-dlp `--cookies` and gallery-dl `--cookies` read) for the
 * social download tools. Pure: parses, keeps ONLY the lines of the platform's own domains (a browser export usually contains every
 * site the user visited), and reports the expiry so the UI can warn before the session dies. Never logs or returns cookie values.
 */

export const socialCookiePlatforms = ["tiktok", "youtube", "pinterest", "x", "instagram"] as const;
export type SocialCookiePlatform = (typeof socialCookiePlatforms)[number];
export const isSocialCookiePlatform = (value: unknown): value is SocialCookiePlatform => typeof value === "string" && (socialCookiePlatforms as readonly string[]).includes(value);

/** Cookie domains each platform's session lives on (YouTube's login cookies sit on .youtube.com, the Google account ones on .google.com). */
export const SOCIAL_COOKIE_DOMAINS: Record<SocialCookiePlatform, readonly string[]> = {
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "google.com"],
  pinterest: ["pinterest.com", "pinterest.jp"],
  x: ["x.com", "twitter.com"],
  instagram: ["instagram.com"],
};

export const MAX_COOKIES_TEXT_BYTES = 256 * 1024;
const HEADER = "# Netscape HTTP Cookie File";

export type ParsedSocialCookies =
  | {
      ok: true;
      /** Canonical file content: header + the platform's lines only. */
      text: string;
      count: number;
      /** Earliest expiry among persistent cookies (null = only session cookies); the session is likely gone after it. */
      earliestExpiresAt: string | null;
      /** Latest expiry: after it nothing in the file can still work. */
      latestExpiresAt: string | null;
      droppedForeignLines: number;
    }
  | { ok: false; reason: "too_large" | "not_netscape" | "no_platform_cookies" | "all_expired" };

const domainMatches = (cookieDomain: string, suffixes: readonly string[]): boolean => {
  const d = cookieDomain.replace(/^#HttpOnly_/i, "").replace(/^\./, "").toLowerCase();
  return suffixes.some((s) => d === s || d.endsWith(`.${s}`));
};

/**
 * Parses a Netscape cookies.txt. A line is `domain \t includeSubdomains \t path \t secure \t expiry \t name \t value` (7 tab-separated
 * fields; `#HttpOnly_` prefixed lines are cookies, other `#` lines are comments). Expiry 0 = session cookie.
 */
export const parseSocialCookies = (raw: string, platform: SocialCookiePlatform, now: Date = new Date()): ParsedSocialCookies => {
  if (new TextEncoder().encode(raw).length > MAX_COOKIES_TEXT_BYTES) return { ok: false, reason: "too_large" };
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/);
  const suffixes = SOCIAL_COOKIE_DOMAINS[platform];
  const kept: string[] = [];
  let cookieLines = 0;
  let dropped = 0;
  const expiries: number[] = [];
  let unexpired = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (line.startsWith("#") && !/^#HttpOnly_/i.test(line)) continue;
    const fields = line.split("\t");
    if (fields.length !== 7) continue;
    const [domain, flag, , secure, expiry] = fields as [string, string, string, string, string, string, string];
    if (!/^(TRUE|FALSE)$/i.test(flag) || !/^(TRUE|FALSE)$/i.test(secure) || !/^\d+$/.test(expiry.trim())) continue;
    cookieLines += 1;
    if (!domainMatches(domain, suffixes)) {
      dropped += 1;
      continue;
    }
    const expirySec = Number(expiry.trim());
    if (expirySec === 0 || expirySec * 1000 > now.getTime()) unexpired += 1;
    if (expirySec > 0) expiries.push(expirySec * 1000);
    kept.push(line);
  }
  if (cookieLines === 0) return { ok: false, reason: "not_netscape" };
  if (kept.length === 0) return { ok: false, reason: "no_platform_cookies" };
  if (unexpired === 0) return { ok: false, reason: "all_expired" };
  const future = expiries.filter((ms) => ms > now.getTime());
  return {
    ok: true,
    text: `${HEADER}\n${kept.join("\n")}\n`,
    count: kept.length,
    earliestExpiresAt: future.length ? new Date(Math.min(...future)).toISOString() : null,
    latestExpiresAt: expiries.length ? new Date(Math.max(...expiries)).toISOString() : null,
    droppedForeignLines: dropped,
  };
};

/** UI hint: the stored cookies expire within `warnDays` (default 3). */
export const socialCookiesExpiringSoon = (earliestExpiresAt: string | null, now: Date = new Date(), warnDays = 3): boolean =>
  earliestExpiresAt !== null && new Date(earliestExpiresAt).getTime() - now.getTime() < warnDays * 24 * 60 * 60_000;
