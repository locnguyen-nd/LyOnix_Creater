import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { CONTENT_MODEL_FRESHNESS_TTL_MS, findModelSnapshotEntry, isFreshCheckedAt, pickUsableContentModel, probeContentModel } from "./content-probe.js";

afterEach(() => { vi.unstubAllGlobals(); });

const okResponse = () => new Response(JSON.stringify({ output_text: JSON.stringify({ ok: true }) }), { status: 200 });

describe("probeContentModel", () => {
  it("calls the exact Responses API generate endpoint, not the /models list endpoint", async () => {
    const fetchMock = vi.fn(async (url: string) => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeContentModel("openai", "sk-test", "gpt-4o-mini");
    expect(result.modelId).toBe("gpt-4o-mini");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/responses");
  });
});

describe("pickUsableContentModel", () => {
  it("returns the preferred model when it is usable on the first try", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));
    const result = await pickUsableContentModel("openai", "sk-test", "gpt-4o-mini");
    expect(result.modelId).toBe("gpt-4o-mini");
  });

  it("falls through to the next curated model when the preferred model is retired (404)", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      if (body.model === "retired-model") {
        return new Response(JSON.stringify({ error: { message: "This model is no longer available" } }), { status: 404 });
      }
      return okResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pickUsableContentModel("openai", "sk-test", "retired-model", ["gpt-4o-mini"]);
    expect(result.modelId).toBe("gpt-4o-mini");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops immediately on an account-wide auth failure instead of trying more models", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(pickUsableContentModel("openai", "bad-key", "gpt-4o-mini", ["gpt-4o"])).rejects.toMatchObject({
      code: "PROVIDER_AUTH_INVALID",
    } satisfies Partial<ProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on account-wide quota exhaustion", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(pickUsableContentModel("openai", "sk-test", "gpt-4o-mini", ["gpt-4o"])).rejects.toMatchObject({
      code: "PROVIDER_QUOTA_EXHAUSTED",
    } satisfies Partial<ProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws PROVIDER_CAPABILITY_UNAVAILABLE when every candidate model fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 })));
    await expect(pickUsableContentModel("gemini", "key", null, ["gemini-2.5-flash", "gemini-2.0-flash"])).rejects.toMatchObject({
      code: "PROVIDER_CAPABILITY_UNAVAILABLE",
    } satisfies Partial<ProviderError>);
  });

  it("records the retired candidate as `attempted` (not silently dropped) when falling through to a usable one", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("gemini-2.5-pro")) return new Response(JSON.stringify({ error: { message: "model not found, use models/gemini-3.1-pro-preview" } }), { status: 404 });
      return okResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pickUsableContentModel("gemini", "key", "gemini-2.5-pro", ["gemini-3.1-pro-preview"]);
    expect(result.modelId).toBe("gemini-3.1-pro-preview");
    expect(result.attempted).toEqual([
      expect.objectContaining({ modelId: "gemini-2.5-pro", status: "retired", source: "probed" }),
    ]);
  });
});

describe("freshness helpers", () => {
  it("treats a snapshot entry as fresh only within the TTL window", () => {
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    expect(isFreshCheckedAt("2026-09-24T11:00:00.000Z", CONTENT_MODEL_FRESHNESS_TTL_MS, now)).toBe(true);
    expect(isFreshCheckedAt("2026-09-23T00:00:00.000Z", CONTENT_MODEL_FRESHNESS_TTL_MS, now)).toBe(false);
    expect(isFreshCheckedAt(undefined, CONTENT_MODEL_FRESHNESS_TTL_MS, now)).toBe(false);
    expect(isFreshCheckedAt("not-a-date", CONTENT_MODEL_FRESHNESS_TTL_MS, now)).toBe(false);
  });

  it("finds a snapshot entry by normalized model id", () => {
    const snapshot = [{ modelId: "gpt-4o-mini", status: "usable" as const, checkedAt: "2026-09-24T00:00:00.000Z", source: "probed" as const }];
    expect(findModelSnapshotEntry(snapshot, "gpt-4o-mini")?.status).toBe("usable");
    expect(findModelSnapshotEntry(snapshot, "models/gpt-4o-mini")?.status).toBe("usable");
    expect(findModelSnapshotEntry(snapshot, "gpt-4o")).toBeUndefined();
    expect(findModelSnapshotEntry(undefined, "gpt-4o-mini")).toBeUndefined();
  });
});
