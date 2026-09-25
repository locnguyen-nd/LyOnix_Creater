/** SSRF-safe, bounded binary download used by URL and Pexels imports. */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { validateResolvedAddress, validateSourceUrl } from "@lyonix/domain";

export type BinaryFetchResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array>;
  destroy?: () => void;
};
export type BinaryFetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal }, pinnedAddress: string) => Promise<BinaryFetchResponse>;
export type LookupLike = (hostname: string) => Promise<{ address: string }[]>;

export type SafeBinaryFetchResult =
  | { ok: true; buffer: Buffer; mimeType: string; finalUrl: string }
  | { ok: false; reason: "ssrf_blocked" | "fetch_failed" | "too_large" | "too_many_redirects" | "domain_not_allowed" };

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const defaultLookup: LookupLike = async (hostname) => dnsLookup(hostname, { all: true });

/** Connect directly to the address validated by DNS, while URL hostname stays intact for Host, TLS SNI and certificate checks. */
const defaultFetch: BinaryFetchLike = async (rawUrl, init, pinnedAddress) => new Promise((resolve, reject) => {
  const url = new URL(rawUrl);
  const transport = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
  if (!transport) { reject(new Error("unsupported_protocol")); return; }
  const pinnedLookup = ((_: string, options: number | { family?: number; all?: boolean }, callback: (...args: any[]) => void) => {
    const family = isIP(pinnedAddress);
    if (!family || (typeof options === "object" && options.family && options.family !== family)) {
      callback(new Error("invalid_pinned_address"));
      return;
    }
    if (typeof options === "object" && options.all) callback(null, [{ address: pinnedAddress, family }]);
    else callback(null, pinnedAddress, family);
  }) as LookupFunction;
  const request = transport(url, { method: "GET", signal: init.signal, lookup: pinnedLookup }, (response) => {
    resolve({
      status: response.statusCode ?? 0,
      headers: { get: (name) => {
        const value = response.headers[name.toLowerCase()];
        return Array.isArray(value) ? value.join(", ") : value ?? null;
      } },
      body: response,
      destroy: () => response.destroy(),
    });
  });
  request.on("error", reject);
  request.end();
});

const resolvePinnedAddress = async (raw: string, lookup: LookupLike) => {
  const check = validateSourceUrl(raw);
  if (!check.ok) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  try {
    const addresses = await lookup(url.hostname);
    if (!addresses.length || addresses.some((entry) => !validateResolvedAddress(entry.address).ok)) return null;
    return addresses[0]!.address;
  } catch {
    return null;
  }
};

/** Each redirect hop is DNS-validated and that exact validated IP is pinned to the socket. */
export async function fetchBinarySafely(
  originalUrl: string,
  options: { maxBytes: number; allowedHostSuffix?: string; deps?: { fetch?: BinaryFetchLike; lookup?: LookupLike } },
): Promise<SafeBinaryFetchResult> {
  const doFetch = options.deps?.fetch ?? defaultFetch;
  const doLookup = options.deps?.lookup ?? defaultLookup;
  let currentUrl = originalUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const pinnedAddress = await resolvePinnedAddress(currentUrl, doLookup);
    if (!pinnedAddress) return { ok: false, reason: "ssrf_blocked" };
    if (options.allowedHostSuffix) {
      const host = new URL(currentUrl).hostname.toLowerCase();
      if (!host.endsWith(options.allowedHostSuffix)) return { ok: false, reason: "domain_not_allowed" };
    }
    let response: BinaryFetchResponse;
    try {
      response = await doFetch(currentUrl, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, pinnedAddress);
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
    const rawLength = response.headers.get("content-length");
    const contentLength = rawLength === null ? NaN : Number(rawLength);
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      response.destroy?.();
      return { ok: false, reason: "too_large" };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > options.maxBytes) {
          response.destroy?.();
          return { ok: false, reason: "too_large" };
        }
        chunks.push(bytes);
      }
    } catch {
      return { ok: false, reason: "fetch_failed" };
    }
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    return { ok: true, buffer: Buffer.concat(chunks, size), mimeType, finalUrl: currentUrl };
  }
  return { ok: false, reason: "too_many_redirects" };
}
