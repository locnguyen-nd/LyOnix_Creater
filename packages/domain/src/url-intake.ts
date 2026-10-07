/**
 * VE2E-96: the "Nguồn nội dung" URL box of the create-video page - which kind of source a pasted URL is. Pure, browser-safe
 * (subpath `@lyonix/domain/url-intake`); the API decides what to read for each kind:
 *  - `yahoo_news`: looked up in the source's public feed only (the article page is never fetched - the source's terms);
 *  - `tiktok`: a video; its transcript needs a provider LyOnix does not have yet;
 *  - `article`: any other web page, read by the same SSRF-safe extractor the Auto run uses for an article URL.
 */
export const INTAKE_URL_KINDS = ["tiktok", "yahoo_news", "article"] as const;
export type IntakeUrlKind = (typeof INTAKE_URL_KINDS)[number];

export const INTAKE_URL_MAX_CHARS = 2_000;

const TIKTOK_HOST = /(^|\.)tiktok\.com$/;
const YAHOO_NEWS_HOST = /^news\.yahoo\.co\.jp$/;

/** Hosts a TikTok video link may have (short links included). */
export const TIKTOK_VIDEO_HOSTS = ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"] as const;

export type TikTokUrl = { kind: "video"; videoId: string; url: string } | { kind: "short"; url: string };

/**
 * A TikTok VIDEO link: `https://www.tiktok.com/@user/video/<id>` (canonical form returned), `m.tiktok.com/v/<id>.html`, or a short link
 * (`vm.tiktok.com/<code>`, `vt.tiktok.com/<code>`, `www.tiktok.com/t/<code>`) that must be resolved first. Anything else (a profile,
 * a photo post, another host) is null.
 */
export function parseTikTokUrl(raw: string): TikTokUrl | null {
  const classified = classifyIntakeUrl(raw);
  if (!classified.ok || classified.kind !== "tiktok") return null;
  const url = new URL(classified.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!(TIKTOK_VIDEO_HOSTS as readonly string[]).includes(host)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") return /^\/[A-Za-z0-9]{5,20}$/.test(path) ? { kind: "short", url: `https://${host}${path}/` } : null;
  const video = /^\/@([A-Za-z0-9._-]{1,40})\/video\/(\d{8,25})$/.exec(path);
  if (video) return { kind: "video", videoId: video[2]!, url: `https://www.tiktok.com/@${video[1]}/video/${video[2]}` };
  const mobile = /^\/v\/(\d{8,25})\.html$/.exec(path);
  if (mobile) return { kind: "video", videoId: mobile[1]!, url: `https://m.tiktok.com/v/${mobile[1]}.html` };
  const short = /^\/t\/([A-Za-z0-9]{5,20})$/.exec(path);
  return short ? { kind: "short", url: `https://www.tiktok.com/t/${short[1]}/` } : null;
}

/** "example.com/a" is taken as https; only http(s) without credentials is accepted. */
export function classifyIntakeUrl(raw: string): { ok: true; kind: IntakeUrlKind; url: string } | { ok: false; reason: "invalid_url" } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > INTAKE_URL_MAX_CHARS || /\s/.test(text)) return { ok: false, reason: "invalid_url" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname.includes(".")) return { ok: false, reason: "invalid_url" };
  const host = url.hostname.toLowerCase();
  const kind: IntakeUrlKind = TIKTOK_HOST.test(host) ? "tiktok" : YAHOO_NEWS_HOST.test(host) ? "yahoo_news" : "article";
  return { ok: true, kind, url: url.toString() };
}
