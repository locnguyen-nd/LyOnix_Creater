/**
 * VE2E-45: Apify account preflight ONLY. A single read-only `GET /v2/users/me` proves the API
 * token is valid without starting an Actor run (no cost). Actor runs, search and import are
 * VE2E-34 and deliberately absent here.
 */
import { ProviderError } from "./index.js";

const API_BASE = "https://api.apify.com";
const timeoutMs = 30_000;

/** Redacts the exact token and anything token-like if it leaks into an error body. */
const redact = (value: string, token: string) => {
  const stripped = token ? value.split(token).join("[redacted]") : value;
  return stripped.replace(/[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 220);
};

const messageOf = (body: Record<string, unknown>): string => {
  const error = body.error;
  if (error && typeof error === "object") { const nested = (error as Record<string, unknown>).message; if (typeof nested === "string") return nested; }
  if (typeof body.message === "string") return body.message;
  return typeof error === "string" ? error : "";
};

export async function probeApifyAccount(accessToken: string): Promise<{ verifiedAt: string }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/v2/users/me`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ProviderError("PROVIDER_TIMEOUT", "Apify request timed out or network failed", true);
  }
  if (response.ok) return { verifiedAt: new Date().toISOString() };
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const message = messageOf(body);
  const suffix = message ? `: ${redact(message, accessToken)}` : "";
  const status = response.status;
  if (status === 401) throw new ProviderError("PROVIDER_AUTH_INVALID", `Apify authentication failed${suffix}`, false);
  if (status === 403) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Apify token lacks permission${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `Apify rate limit reached${suffix}`, true, Number(response.headers.get("retry-after") ?? 0) * 1000 || undefined);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `Apify request failed (${status})${suffix}`, status >= 500);
}
