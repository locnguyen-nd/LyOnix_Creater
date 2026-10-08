import type { MediaDeliveryIssueResponse } from "@lyonix/contracts";
import { API_ORIGIN } from "../api";

/** API routes that stream files to the browser: signed media delivery and an internal render's video / cover. */
const BROWSER_STREAM_PATH = /^\/api\/v1\/(?:media-delivery|render-jobs)\//;

/**
 * The server builds file URLs from PUBLIC_BASE_URL, which is the address *providers* use (a tunnel in dev). The browser must
 * not depend on it - an expired tunnel blanked every Studio thumbnail - so our own streaming routes are re-pointed at the
 * API origin the app already talks to. Any other URL (provider CDN, blob:, data:) is returned unchanged.
 */
export function browserApiUrl(url: string, origin?: string): string;
export function browserApiUrl(url: string | null | undefined, origin?: string): string | null;
export function browserApiUrl(url: string | null | undefined, origin: string = API_ORIGIN): string | null {
  if (!url) return null;
  const base = origin.replace(/\/$/, "");
  if (url.startsWith("/")) return BROWSER_STREAM_PATH.test(url) ? `${base}${url}` : url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(parsed.protocol) || !BROWSER_STREAM_PATH.test(parsed.pathname)) return url;
  return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** The URL a `<video>` / `<img>` should load for an issued delivery token (`path` from a current API, `url` from an older one). */
export const deliveryUrlForBrowser = (issued: Pick<MediaDeliveryIssueResponse, "url"> & Partial<Pick<MediaDeliveryIssueResponse, "path">>, origin: string = API_ORIGIN): string =>
  browserApiUrl(issued.path || issued.url, origin);
