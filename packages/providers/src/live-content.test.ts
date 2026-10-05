import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { generateContentOnce, generateLiveStructured, generateOpenAi, generateXai, isLiveContentKind, verifyContentKey } from "./live-content.js";
import { SCRIPT_DRAFT_V1_JSON_SCHEMA } from "./script-draft-v1.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("verifyContentKey", () => {
  it("accepts openai, gemini and xai only", () => {
    expect(isLiveContentKind("openai")).toBe(true);
    expect(isLiveContentKind("fake")).toBe(false);
  });

  it("maps a models list without treating it as billed generation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 })));
    await expect(verifyContentKey("openai", "sk-test")).resolves.toMatchObject({ models: ["gpt-4o-mini"] });
  });

  it("V00-10: is account-scoped discovery only - never adds a static-catalog model the account's own listing did not report", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 })));
    const { models } = await verifyContentKey("openai", "sk-test");
    expect(models).not.toContain("gpt-4o");
    expect(models).not.toContain("gpt-5");
  });

  it("V00-10: filters out a Gemini model that explicitly does not support generateContent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-count-tokens-only", supportedGenerationMethods: ["countTokens"] },
      ],
    }), { status: 200 })));
    await expect(verifyContentKey("gemini", "key")).resolves.toMatchObject({ models: ["gemini-2.5-flash"] });
  });

  it("maps 401 to PROVIDER_AUTH_INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(verifyContentKey("xai", "bad")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" } satisfies Partial<ProviderError>);
  });
});

/**
 * VE2E-122: the wire shape of a raw REST `/v1/responses` body. The text sits in `output[]` message parts; there is NO
 * top-level `output_text` (the official SDKs compute that client-side), so mocks must not invent one.
 */
const responsesBody = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  object: "response",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
  ],
  usage: { input_tokens: 120, output_tokens: 45, total_tokens: 165 },
  ...extra,
});
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "x-request-id": "req_1" } });
type FetchCalls = { mock: { calls: unknown[][] } };
const sentUrl = (fetchMock: FetchCalls, index = 0) => String(fetchMock.mock.calls[index]?.[0]);
const sentRaw = (fetchMock: FetchCalls, index = 0) => String((fetchMock.mock.calls[index]?.[1] as RequestInit).body);
const sentBody = (fetchMock: FetchCalls, index = 0) => JSON.parse(sentRaw(fetchMock, index)) as Record<string, unknown>;

describe("generateLiveStructured (Script V1)", () => {
  it("VE2E-122: OpenAI V1 calls the Responses API with the V1 instructions and the pinned script_draft_v1 schema, without temperature", async () => {
    const fetchMock = vi.fn(async () => ok(responsesBody("{\"title\":\"Messi\"}")));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateLiveStructured("openai", "sk-test", "gpt-4o-mini", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA);
    expect(result.output).toEqual({ title: "Messi" });
    expect(sentUrl(fetchMock)).toBe("https://api.openai.com/v1/responses");
    const body = sentBody(fetchMock);
    expect(body.instructions).toContain("You are LyOnix, a short-form script editor");
    expect(body.input).toBe("prompt");
    expect(body.text).toEqual({ format: { type: "json_schema", name: "script_draft_v1", strict: true, schema: SCRIPT_DRAFT_V1_JSON_SCHEMA } });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("response_format");
  });

  it("VE2E-122: records real Responses token usage (Chat Completions' prompt_tokens left it null before)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(responsesBody("{\"title\":\"Messi\"}"))));
    const result = await generateLiveStructured("openai", "sk-test", "gpt-4o-mini", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA);
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 45, providerRequestId: "req_1" });
  });

  it("VE2E-122: xAI V1 calls the xAI Responses API with the same V1 request shape", async () => {
    const fetchMock = vi.fn(async () => ok(responsesBody("{\"title\":\"Messi\"}")));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateLiveStructured("xai", "xai-test", "grok-4", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA)).resolves.toMatchObject({ output: { title: "Messi" } });
    expect(sentUrl(fetchMock)).toBe("https://api.x.ai/v1/responses");
    expect(sentBody(fetchMock).text).toMatchObject({ format: { type: "json_schema", name: "script_draft_v1" } });
    expect(sentBody(fetchMock).instructions).toContain("You are LyOnix");
  });

  it("VE2E-122: retries a 400 schema rejection once in JSON mode (json_object), keeping the instructions", async () => {
    const fetchMock = vi.fn(async () => (fetchMock.mock.calls.length === 1
      ? new Response(JSON.stringify({ error: { message: "Invalid schema for response_format 'script_draft_v1'" } }), { status: 400 })
      : ok(responsesBody("{\"title\":\"Messi\"}"))));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateLiveStructured("openai", "sk-test", "gpt-4o-mini", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA)).resolves.toMatchObject({ output: { title: "Messi" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 1).text).toEqual({ format: { type: "json_object" } });
    expect(sentBody(fetchMock, 1).instructions).toContain("You are LyOnix");
  });

  it("VE2E-122: a model refusal is PROVIDER_CONTENT_REFUSED and is not retried as a schema error", async () => {
    const fetchMock = vi.fn(async () => ok({
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateLiveStructured("openai", "sk-test", "gpt-4o-mini", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA)).rejects.toMatchObject({
      code: "PROVIDER_CONTENT_REFUSED",
      retryable: false,
    } satisfies Partial<ProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 401 on the Responses endpoint to PROVIDER_AUTH_INVALID without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateLiveStructured("openai", "sk-bad", "gpt-4o-mini", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA)).rejects.toMatchObject({
      code: "PROVIDER_AUTH_INVALID",
    } satisfies Partial<ProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("VE2E-122: Gemini V1 still uses generateContent, never the Responses API", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"title\":\"Messi\"}" }] } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await generateLiveStructured("gemini", "key", "gemini-2.5-flash", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA);
    expect(sentUrl(fetchMock)).toContain(":generateContent");
    expect(sentBody(fetchMock)).not.toHaveProperty("instructions");
  });
});

describe("Responses API parser (VE2E-122, shared with V2 / model probe / keywords)", () => {
  it("reads the text from output[] message parts when the body has no top-level output_text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(responsesBody("{\"ok\":true}"))));
    await expect(generateOpenAi("sk-test", "gpt-4o-mini", "prompt")).resolves.toMatchObject({ output: { ok: true } });
  });

  it("joins several output_text parts of one message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"a\":" }, { type: "output_text", text: "1}" }] }],
    })));
    await expect(generateXai("xai-test", "grok-4", "prompt")).resolves.toMatchObject({ output: { a: 1 } });
  });

  it("still honours a top-level output_text string when a server sends one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ output_text: "{\"ok\":true}" })));
    await expect(generateXai("xai-test", "grok-4", "prompt")).resolves.toMatchObject({ output: { ok: true } });
  });

  it("an incomplete response is PROVIDER_SCHEMA_INVALID naming the reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(responsesBody("{\"title\":\"Mes", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))));
    await expect(generateOpenAi("sk-test", "gpt-4o-mini", "prompt")).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" } satisfies Partial<ProviderError>);
    await expect(generateOpenAi("sk-test", "gpt-4o-mini", "prompt")).rejects.toThrow(/max_output_tokens/);
  });

  it("a body without any text is PROVIDER_SCHEMA_INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ status: "completed", output: [{ type: "reasoning", summary: [] }] })));
    await expect(generateOpenAi("sk-test", "gpt-4o-mini", "prompt")).rejects.toMatchObject({
      code: "PROVIDER_SCHEMA_INVALID",
      message: "OpenAI did not return structured text",
    } satisfies Partial<ProviderError>);
  });

  it("the V2 request body is byte-identical to before VE2E-122 (no instructions, script_draft schema name, no format without schema)", async () => {
    // Top-level output_text on purpose: the pre-VE2E-122 parser only read that field, so this exact test also passes on the old code.
    const fetchMock = vi.fn(async () => ok({ output_text: "{\"ok\":true}" }));
    vi.stubGlobal("fetch", fetchMock);
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    await generateContentOnce("openai", "sk-test", "gpt-4o-mini", "prompt", schema);
    await generateContentOnce("openai", "sk-test", "gpt-4o-mini", "prompt");
    await generateContentOnce("xai", "xai-test", "grok-4", "prompt", schema);
    expect(sentRaw(fetchMock, 0)).toBe(JSON.stringify({ model: "gpt-4o-mini", input: "prompt", text: { format: { type: "json_schema", name: "script_draft", strict: true, schema } } }));
    expect(sentRaw(fetchMock, 1)).toBe(JSON.stringify({ model: "gpt-4o-mini", input: "prompt" }));
    expect(sentRaw(fetchMock, 2)).toBe(JSON.stringify({ model: "grok-4", input: "prompt", text: { format: { type: "json_schema", name: "script_draft", strict: true, schema } } }));
  });
});
