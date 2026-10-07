import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { fetchApifyConcurrencyLimit, probeApifyAccount } from "./apify.js";

afterEach(() => { vi.unstubAllGlobals(); });
const TOKEN = "stub_token_value_1234567890abcdef";
const stub = (status: number, body: unknown = {}) => {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
};

describe("probeApifyAccount", () => {
  it("issues one read-only GET /v2/users/me with a Bearer token", async () => {
    const mock = stub(200, { data: { id: "u" } });
    const result = await probeApifyAccount(TOKEN);
    expect(Date.parse(result.verifiedAt)).not.toBeNaN();
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.apify.com/v2/users/me");
    expect(init.method ?? "GET").toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    [401, "PROVIDER_AUTH_INVALID", false],
    [403, "PROVIDER_CAPABILITY_UNAVAILABLE", false],
    [429, "PROVIDER_RATE_LIMITED", true],
    [500, "PROVIDER_UNAVAILABLE", true],
    [418, "PROVIDER_UNAVAILABLE", false],
  ])("maps HTTP %i to %s", async (status, code, retryable) => {
    stub(status, { error: { message: "Real upstream message" } });
    const error = await probeApifyAccount(TOKEN).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, retryable });
    expect(error.message).toContain("Real upstream message");
  });

  it("redacts the token if the provider echoes it back", async () => {
    stub(401, { error: { message: `Token ${TOKEN} is invalid` } });
    const error = await probeApifyAccount(TOKEN).catch((e) => e);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("[redacted]");
  });

  it("maps a network failure to PROVIDER_TIMEOUT without leaking the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`boom ${TOKEN}`); }));
    const error = await probeApifyAccount(TOKEN).catch((e) => e);
    expect(error).toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("fetchApifyConcurrencyLimit (VE2E-131)", () => {
  it("reads maxConcurrentActorJobs from the read-only limits endpoint (stub, not a live probe)", async () => {
    const mock = stub(200, { data: { limits: { maxConcurrentActorJobs: 32 } } });
    expect(await fetchApifyConcurrencyLimit(TOKEN)).toBe(32);
    expect(String((mock.mock.calls as unknown[][])[0]![0])).toBe("https://api.apify.com/v2/users/me/limits");
  });
  it("returns null (caller keeps the env value) on errors or an unexpected shape", async () => {
    stub(403, {});
    expect(await fetchApifyConcurrencyLimit(TOKEN)).toBeNull();
    stub(200, { data: {} });
    expect(await fetchApifyConcurrencyLimit(TOKEN)).toBeNull();
  });
});
