import { describe, expect, it } from "vitest";
import { parseSocialCookies, socialCookiesExpiringSoon } from "./social-cookies.js";

const now = new Date("2026-10-08T00:00:00Z");
const future = Math.floor(new Date("2026-11-01T00:00:00Z").getTime() / 1000);
const soon = Math.floor(new Date("2026-10-09T00:00:00Z").getTime() / 1000);
const past = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);
const line = (domain: string, expiry: number, name = "sid", value = "secret-value") => [domain, "TRUE", "/", "TRUE", String(expiry), name, value].join("\t");

describe("parseSocialCookies (VE2E-145)", () => {
  it("keeps only the platform's lines and reports the expiry window", () => {
    const raw = ["# Netscape HTTP Cookie File", "# comment", line(".tiktok.com", future), `#HttpOnly_${line(".www.tiktok.com", soon, "sessionid")}`, line(".google.com", future), line(".bank.example", future), ""].join("\n");
    const parsed = parseSocialCookies(raw, "tiktok", now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.count).toBe(2);
    expect(parsed.droppedForeignLines).toBe(2);
    expect(parsed.text).not.toContain("bank.example");
    expect(parsed.text).not.toContain("google.com");
    expect(parsed.text.startsWith("# Netscape HTTP Cookie File\n")).toBe(true);
    expect(parsed.earliestExpiresAt).toBe("2026-10-09T00:00:00.000Z");
    expect(parsed.latestExpiresAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("YouTube keeps .youtube.com and .google.com; X accepts twitter.com", () => {
    const yt = parseSocialCookies([line(".youtube.com", future), line("accounts.google.com", future), line(".tiktok.com", future)].join("\n"), "youtube", now);
    expect(yt.ok && yt.count).toBe(2);
    const x = parseSocialCookies(line(".twitter.com", future, "auth_token"), "x", now);
    expect(x.ok && x.count).toBe(1);
  });

  it("does not treat look-alike domains as the platform", () => {
    expect(parseSocialCookies(line(".nottiktok.com", future), "tiktok", now)).toEqual({ ok: false, reason: "no_platform_cookies" });
    expect(parseSocialCookies(line(".tiktok.com.evil.io", future), "tiktok", now)).toEqual({ ok: false, reason: "no_platform_cookies" });
  });

  it("rejects non-Netscape input, all-expired sessions and huge files", () => {
    expect(parseSocialCookies('[{"name":"sid","value":"x"}]', "tiktok", now)).toEqual({ ok: false, reason: "not_netscape" });
    expect(parseSocialCookies("sid=abc; path=/", "tiktok", now)).toEqual({ ok: false, reason: "not_netscape" });
    expect(parseSocialCookies(line(".tiktok.com", past), "tiktok", now)).toEqual({ ok: false, reason: "all_expired" });
    expect(parseSocialCookies("x".repeat(300 * 1024), "tiktok", now)).toEqual({ ok: false, reason: "too_large" });
  });

  it("accepts session cookies (expiry 0) and CRLF / BOM exports", () => {
    const parsed = parseSocialCookies(`﻿# Netscape HTTP Cookie File\r\n${line(".pinterest.com", 0)}\r\n`, "pinterest", now);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.earliestExpiresAt).toBeNull();
  });

  it("flags cookies that expire within 3 days", () => {
    expect(socialCookiesExpiringSoon("2026-10-09T00:00:00.000Z", now)).toBe(true);
    expect(socialCookiesExpiringSoon("2026-11-01T00:00:00.000Z", now)).toBe(false);
    expect(socialCookiesExpiringSoon(null, now)).toBe(false);
  });
});
