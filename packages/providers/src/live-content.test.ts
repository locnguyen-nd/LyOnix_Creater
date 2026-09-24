import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { generateLiveStructured, isLiveContentKind, verifyContentKey } from "./live-content.js";
import { SCRIPT_DRAFT_V1_JSON_SCHEMA } from "./script-draft-v1.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("verifyContentKey", () => {
  it("accepts openai, gemini and xai only", () => {
    expect(isLiveContentKind("openai")).toBe(true);
    expect(isLiveContentKind("fake")).toBe(false);
  });

  it("maps a models list without treating it as billed generation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 })));
    await expect(verifyContentKey("openai", "sk-test")).resolves.toMatchObject({ models: expect.arrayContaining(["gpt-4o-mini", "gpt-4o"]) });
  });

  it("maps 401 to PROVIDER_AUTH_INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(verifyContentKey("xai", "bad")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" } satisfies Partial<ProviderError>);
  });
});

describe("generateLiveStructured", () => {
  it("pins ScriptDraftV1 json_schema on OpenAI chat completions", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{\"title\":\"Messi\"}" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await generateLiveStructured("openai", "sk-test", "gpt-4o-mini", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body)) as { response_format: { type: string } };
    expect(body.response_format.type).toBe("json_schema");
  });

  it("maps OpenAI no-credits 429 to PROVIDER_QUOTA_EXHAUSTED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/" },
    }), { status: 429 })));
    await expect(generateLiveStructured("openai", "sk-test", "gpt-5", "prompt")).rejects.toMatchObject({
      code: "PROVIDER_QUOTA_EXHAUSTED",
    } satisfies Partial<ProviderError>);
  });

  it("retries Gemini generate on retired-model 404 using the hinted replacement", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("gemini-exp-gone")) {
        return new Response(JSON.stringify({
          error: { message: "This model models/gemini-exp-gone is no longer available to new users. Please update your code to use models/gemini-3.1-pro-preview for the latest features and improvements." },
        }), { status: 404 });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"title\":\"Messi\"}" }] } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateLiveStructured("gemini", "key", "gemini-exp-gone", "prompt")).resolves.toMatchObject({ output: { title: "Messi" } });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("gemini-3.1-pro-preview");
  });
});
