/**
 * Pure SSRF guard logic for article/media source URLs. No network I/O here —
 * DNS resolution/redirect-chain enforcement happens in the worker/service layer,
 * which must call `isPrivateOrBlockedIp` again on every resolved address and on
 * every redirect hop before following it.
 */

export type SsrfCheckResult = { ok: true } | { ok: false; reason: string };

const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];
const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "::1", "metadata.google.internal"]);

const isIPv4 = (host: string) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host);

export const isPrivateOrBlockedIpv4 = (host: string): boolean => {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // "this" network
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  return false;
};

export const isPrivateOrBlockedIpv6 = (host: string): boolean => {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80:")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local fc00::/7
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIPv4(mapped)) return isPrivateOrBlockedIpv4(mapped);
  }
  return false;
};

export const isBlockedHostname = (hostnameRaw: string): boolean => {
  const hostname = hostnameRaw.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  if (hostname.includes(":")) return isPrivateOrBlockedIpv6(hostname);
  if (isIPv4(hostname)) return isPrivateOrBlockedIpv4(hostname);
  return false;
};

/** Validate a candidate article/source URL before it is accepted or fetched. */
export const validateSourceUrl = (raw: string): SsrfCheckResult => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "unsupported_scheme" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  if (!url.hostname) return { ok: false, reason: "missing_host" };
  if (isBlockedHostname(url.hostname)) return { ok: false, reason: "private_or_loopback_host" };
  return { ok: true };
};

/** Re-check a resolved IP address (post-DNS or redirect hop) at the caller layer. */
export const validateResolvedAddress = (address: string): SsrfCheckResult =>
  isBlockedHostname(address) ? { ok: false, reason: "private_or_loopback_resolved_address" } : { ok: true };
