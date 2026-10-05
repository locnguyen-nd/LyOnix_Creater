import { describe, expect, it } from "vitest";
import { isBlockedHostname, validateResolvedAddress, validateSourceUrl } from "./ssrf.js";

describe("validateSourceUrl", () => {
  it("accepts a normal https article URL", () => {
    expect(validateSourceUrl("https://news.example.com/article/1")).toEqual({ ok: true });
  });
  it("rejects non-http(s) schemes", () => {
    expect(validateSourceUrl("file:///etc/passwd")).toEqual({ ok: false, reason: "unsupported_scheme" });
    expect(validateSourceUrl("ftp://example.com/a")).toEqual({ ok: false, reason: "unsupported_scheme" });
  });
  it("rejects malformed URLs", () => {
    expect(validateSourceUrl("not a url")).toEqual({ ok: false, reason: "invalid_url" });
  });
  it("rejects credentials embedded in the URL", () => {
    expect(validateSourceUrl("https://user:pass@example.com/a")).toEqual({ ok: false, reason: "credentials_in_url" });
  });
  it("rejects localhost and loopback", () => {
    expect(validateSourceUrl("http://localhost/x")).toEqual({ ok: false, reason: "private_or_loopback_host" });
    expect(validateSourceUrl("http://127.0.0.1/x")).toEqual({ ok: false, reason: "private_or_loopback_host" });
    expect(validateSourceUrl("http://[::1]/x")).toEqual({ ok: false, reason: "private_or_loopback_host" });
  });
  it("rejects private IPv4 ranges including cloud metadata", () => {
    for (const host of ["10.0.0.5", "172.16.5.1", "192.168.1.1", "169.254.169.254", "100.64.0.1"]) {
      expect(validateSourceUrl(`http://${host}/x`)).toEqual({ ok: false, reason: "private_or_loopback_host" });
    }
  });
  it("rejects internal-looking hostnames", () => {
    expect(validateSourceUrl("http://service.internal/x")).toEqual({ ok: false, reason: "private_or_loopback_host" });
    expect(validateSourceUrl("http://box.local/x")).toEqual({ ok: false, reason: "private_or_loopback_host" });
  });
  it("accepts a public IPv4 literal", () => {
    expect(validateSourceUrl("http://93.184.216.34/x")).toEqual({ ok: true });
  });
});

describe("isBlockedHostname / validateResolvedAddress", () => {
  it("blocks resolved private addresses so redirect/DNS hops can be re-checked", () => {
    expect(isBlockedHostname("10.1.2.3")).toBe(true);
    expect(validateResolvedAddress("10.1.2.3")).toEqual({ ok: false, reason: "private_or_loopback_resolved_address" });
    expect(validateResolvedAddress("8.8.8.8")).toEqual({ ok: true });
  });
});
