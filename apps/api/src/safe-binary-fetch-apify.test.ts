import { describe, expect, it, vi } from "vitest";
import { fetchBinarySafely, type BinaryFetchLike, type LookupLike } from "./safe-binary-fetch.js";

const okLookup: LookupLike = async () => [{ address: "93.184.216.34" }];

const binResponse = (bytes: number[], headers: Record<string, string> = {}, status = 200) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  body: (async function* () { yield new Uint8Array(bytes); })(),
  destroy: vi.fn(),
});

describe("fetchBinarySafely - VE2E-34 Apify options", () => {
  it("accepts a subdomain of an allowed suffix and rejects look-alike hosts on a whole-label basis", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async () => binResponse([1], { "content-type": "image/jpeg" }) as never);
    const deps = { fetch: fetchMock, lookup: okLookup };
    expect((await fetchBinarySafely("https://i.pinimg.com/a.jpg", { maxBytes: 100, allowedHostSuffixes: ["pinimg.com"], deps })).ok).toBe(true);
    expect(await fetchBinarySafely("https://evilpinimg.com/a.jpg", { maxBytes: 100, allowedHostSuffixes: ["pinimg.com"], deps })).toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(await fetchBinarySafely("https://pinimg.com.evil.test/a.jpg", { maxBytes: 100, allowedHostSuffixes: ["pinimg.com"], deps })).toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-checks the suffix allowlist on every redirect hop", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async (url: string) =>
      (url.startsWith("https://i.pinimg.com") ? binResponse([], { location: "https://evil.example/a.jpg" }, 302) : binResponse([1])) as never);
    const result = await fetchBinarySafely("https://i.pinimg.com/a.jpg", { maxBytes: 100, allowedHostSuffixes: ["pinimg.com"], deps: { fetch: fetchMock, lookup: okLookup } });
    expect(result).toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-image Content-Type before reading the body when only images are allowed", async () => {
    const response = binResponse([1, 2], { "content-type": "text/html; charset=utf-8" });
    const fetchMock = vi.fn<BinaryFetchLike>(async () => response as never);
    const result = await fetchBinarySafely("https://blog.example.jp/a.jpg", { maxBytes: 100, allowedMimePrefixes: ["image/"], deps: { fetch: fetchMock, lookup: okLookup } });
    expect(result).toEqual({ ok: false, reason: "mime_not_allowed" });
    expect(response.destroy).toHaveBeenCalled();
  });

  it("public-web mode (no suffix list) still blocks private targets and enforces the size limit", async () => {
    const privateLookup: LookupLike = async () => [{ address: "169.254.169.254" }];
    const fetchMock = vi.fn<BinaryFetchLike>(async () => binResponse([1], { "content-length": "999999" }) as never);
    expect(await fetchBinarySafely("https://blog.example.jp/a.jpg", { maxBytes: 100, allowedMimePrefixes: ["image/"], deps: { fetch: fetchMock, lookup: privateLookup } })).toEqual({ ok: false, reason: "ssrf_blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fetchBinarySafely("https://blog.example.jp/a.jpg", { maxBytes: 100, deps: { fetch: fetchMock, lookup: okLookup } })).toEqual({ ok: false, reason: "too_large" });
  });

  it("sends host-scoped headers only to that host and drops them after a redirect elsewhere", async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchMock = vi.fn<BinaryFetchLike>(async (url: string, init) => {
      seen.push({ url, ...(init.headers ? { headers: init.headers } : {}) });
      return (url.startsWith("https://api.apify.com") ? binResponse([], { location: "https://files.apifyusercontent.com/x.mp4" }, 302) : binResponse([1, 2, 3], { "content-type": "video/mp4" })) as never;
    });
    const result = await fetchBinarySafely("https://api.apify.com/v2/key-value-stores/kv/records/a.mp4", {
      maxBytes: 100,
      hostScopedHeaders: { host: "api.apify.com", headers: { Authorization: "Bearer stub" } },
      deps: { fetch: fetchMock, lookup: okLookup },
    });
    expect(result.ok).toBe(true);
    expect(seen[0]!.headers).toEqual({ Authorization: "Bearer stub" });
    expect(seen[1]!.headers).toBeUndefined();
  });
});
