/**
 * VE2E-01: SSRF-safe article URL fetch + plain-text extraction for `SourceVersion` of type
 * `article_url`. `sources.service.ts` (VE2E-00) validates the URL and records provenance at
 * creation time but never performs outbound HTTP from that request handler; this module is
 * the deferred fetch/extract step it points to. Fetch/DNS lookup are dependency-injected so
 * unit tests never make a real network call (`FetchLike`/`LookupLike`).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { validateResolvedAddress, validateSourceUrl } from "@lyonix/domain";

export type FetchLike = (url: string, init?: { redirect: "manual"; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;
export type LookupLike = (hostname: string) => Promise<{ address: string }[]>;

export type ExtractArticleResult =
  | { ok: true; extractedText: string; finalUrl: string }
  | { ok: false; reason: "ssrf_blocked" | "fetch_failed" | "too_large" | "unsupported_content_type" | "empty" | "too_many_redirects" };

const MAX_REDIRECTS = 5;
const MAX_BYTES = 2_000_000;
export const MAX_EXTRACTED_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;

const isUsableHost = async (raw: string, lookup: LookupLike): Promise<boolean> => {
  const check = validateSourceUrl(raw);
  if (!check.ok) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  try {
    const addresses = await lookup(url.hostname);
    if (addresses.length === 0) return false;
    return addresses.every((entry) => validateResolvedAddress(entry.address).ok);
  } catch {
    return false;
  }
};

/** Strip script/style blocks and tags, decode a handful of common entities, collapse whitespace. */
export const htmlToPlainText = (html: string): string => {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = withoutScripts
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return decoded
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const defaultLookup: LookupLike = async (hostname) => dnsLookup(hostname, { all: true });
const defaultFetch: FetchLike = async (url, init) => fetch(url, init as RequestInit);

/**
 * Fetch `url`, following up to `MAX_REDIRECTS` redirects manually so every hop (including
 * the original URL) is re-validated against the SSRF guard and its DNS-resolved address —
 * this closes the "URL looked safe, but the DNS answer / a redirect points to a private
 * address" gap that `validateSourceUrl` alone (string-only, called at source creation) can't.
 */
export async function extractArticleText(
  originalUrl: string,
  deps: { fetch?: FetchLike; lookup?: LookupLike } = {},
): Promise<ExtractArticleResult> {
  const doFetch = deps.fetch ?? defaultFetch;
  const doLookup = deps.lookup ?? defaultLookup;
  let currentUrl = originalUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!(await isUsableHost(currentUrl, doLookup))) return { ok: false, reason: "ssrf_blocked" };
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(currentUrl, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      return { ok: false, reason: "fetch_failed" };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "fetch_failed" };
      currentUrl = new URL(location, currentUrl).toString();
      if (hop === MAX_REDIRECTS) return { ok: false, reason: "too_many_redirects" };
      continue;
    }
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: "fetch_failed" };
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType) && contentType !== "") {
      return { ok: false, reason: "unsupported_content_type" };
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BYTES) return { ok: false, reason: "too_large" };
    const raw = await response.text();
    if (raw.length > MAX_BYTES) return { ok: false, reason: "too_large" };
    const text = htmlToPlainText(raw).slice(0, MAX_EXTRACTED_CHARS);
    if (!text) return { ok: false, reason: "empty" };
    return { ok: true, extractedText: text, finalUrl: currentUrl };
  }
  return { ok: false, reason: "too_many_redirects" };
}
