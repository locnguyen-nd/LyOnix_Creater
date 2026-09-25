import { describe, expect, it, vi } from "vitest";
import { fetchBinarySafely, type BinaryFetchLike, type LookupLike } from "./safe-binary-fetch.js";

const okLookup: LookupLike = async () => [{ address: "93.184.216.34" }];
const pexelsLookup: LookupLike = async () => [{ address: "203.0.113.5" }];
const privateLookup: LookupLike = async () => [{ address: "127.0.0.1" }];

const binResponse = (bytes: number[], headers: Record<string, string> = {}) => ({
  status: 200,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  body: (async function* () { yield new Uint8Array(bytes); })(),
  destroy: vi.fn(),
});

describe("fetchBinarySafely", () => {
  it("downloads bytes from an allowed URL", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async () => binResponse([1, 2, 3], { "content-type": "image/jpeg" }) as never);
    const result = await fetchBinarySafely("https://example.com/a.jpg", { maxBytes: 100, deps: { fetch: fetchMock, lookup: okLookup } });
    expect(result).toEqual({ ok: true, buffer: Buffer.from([1, 2, 3]), mimeType: "image/jpeg", finalUrl: "https://example.com/a.jpg" });
  });

  it("blocks a URL whose DNS answer resolves to a private address", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async () => binResponse([1]) as never);
    const result = await fetchBinarySafely("https://example.com/a.jpg", { maxBytes: 100, deps: { fetch: fetchMock, lookup: privateLookup } });
    expect(result).toEqual({ ok: false, reason: "ssrf_blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins the validated DNS answer to the actual request even if a later lookup would differ", async () => {
    const lookup = vi.fn<LookupLike>().mockResolvedValueOnce([{ address: "93.184.216.34" }]).mockResolvedValueOnce([{ address: "127.0.0.1" }]);
    const fetchMock = vi.fn<BinaryFetchLike>(async () => binResponse([1]) as never);
    const result = await fetchBinarySafely("https://example.com/a.jpg", { maxBytes: 100, deps: { fetch: fetchMock, lookup } });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.any(Object), "93.184.216.34");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("re-validates every redirect hop and blocks a private redirect target", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async (url: string) => {
      if (url === "https://example.com/a.jpg") {
      return { status: 302, headers: { get: (n: string) => (n.toLowerCase() === "location" ? "http://169.254.169.254/latest/meta-data/" : null) }, body: (async function* () {})() } as never;
      }
      return binResponse([9]) as never;
    });
    const result = await fetchBinarySafely("https://example.com/a.jpg", { maxBytes: 100, deps: { fetch: fetchMock, lookup: okLookup } });
    expect(result).toEqual({ ok: false, reason: "ssrf_blocked" });
  });

  it("enforces the byte cap via content-length before downloading", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async () => binResponse([1, 2, 3], { "content-length": "1000" }) as never);
    const result = await fetchBinarySafely("https://example.com/a.jpg", { maxBytes: 10, deps: { fetch: fetchMock, lookup: okLookup } });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("enforces the byte cap on the actual downloaded size even without content-length", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async () => binResponse(new Array(20).fill(1)) as never);
    const result = await fetchBinarySafely("https://example.com/a.jpg", { maxBytes: 10, deps: { fetch: fetchMock, lookup: okLookup } });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("stops streaming at the cap when content-length is missing or lies", async () => {
    const destroy = vi.fn();
    const body = (async function* () { yield new Uint8Array(8); yield new Uint8Array(8); yield new Uint8Array(100); })();
    const fetchMock = vi.fn<BinaryFetchLike>(async () => ({ status: 200, headers: { get: () => null }, body, destroy }));
    const result = await fetchBinarySafely("https://example.com/a.jpg", { maxBytes: 10, deps: { fetch: fetchMock, lookup: okLookup } });
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects a URL outside the extra provider domain allowlist even when SSRF-safe", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async () => binResponse([1]) as never);
    const result = await fetchBinarySafely("https://evil.example/looks-like-a-cdn-link.jpg", { maxBytes: 100, allowedHostSuffix: ".pexels.com", deps: { fetch: fetchMock, lookup: pexelsLookup } });
    expect(result).toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a URL that matches the provider domain allowlist", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async () => binResponse([1, 2], { "content-type": "video/mp4" }) as never);
    const result = await fetchBinarySafely("https://videos.pexels.com/video-files/7/7-hd.mp4", { maxBytes: 100, allowedHostSuffix: ".pexels.com", deps: { fetch: fetchMock, lookup: pexelsLookup } });
    expect(result).toEqual({ ok: true, buffer: Buffer.from([1, 2]), mimeType: "video/mp4", finalUrl: "https://videos.pexels.com/video-files/7/7-hd.mp4" });
  });

  it("maps a network/timeout failure to fetch_failed", async () => {
    const fetchMock = vi.fn<BinaryFetchLike>(async () => { throw new DOMException("aborted", "AbortError"); });
    const result = await fetchBinarySafely("https://example.com/a.jpg", { maxBytes: 100, deps: { fetch: fetchMock, lookup: okLookup } });
    expect(result).toEqual({ ok: false, reason: "fetch_failed" });
  });
});
