import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  classifyOpenRouterModels,
  generateContentOnce,
  generateContentStructuredV2,
  generateLiveStructured,
  generateVisionStructuredOnce,
  isLiveContentKind,
  liveContentKinds,
  providerKinds,
  verifyContentKey,
  verifyOpenRouterKey,
  CURATED_CONTENT_MODELS,
} from "./index.js";
import { SCRIPT_DRAFT_V1_JSON_SCHEMA } from "./script-draft-v1.js";

afterEach(() => { vi.unstubAllGlobals(); });

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } as const;

/** OpenRouter chat-completions success body: text in choices[0].message.content, native token counts + prepaid cost in usage. */
const chatBody = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "gen-1",
  object: "chat.completion",
  model: "openai/gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165, cost: 0.0012 },
  ...extra,
});
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "x-request-id": "req_1" } });
type FetchCalls = { mock: { calls: unknown[][] } };
const sentUrl = (fetchMock: FetchCalls, index = 0) => String(fetchMock.mock.calls[index]?.[0]);
const sentInit = (fetchMock: FetchCalls, index = 0) => fetchMock.mock.calls[index]?.[1] as RequestInit;
const sentBody = (fetchMock: FetchCalls, index = 0) => JSON.parse(String(sentInit(fetchMock, index).body)) as Record<string, unknown>;
const headerOf = (fetchMock: FetchCalls, name: string, index = 0) => (sentInit(fetchMock, index).headers as Record<string, string>)[name];

describe("VE2E-79 OpenRouter: registration", () => {
  it("is a live content kind, a provider kind and has a curated ranking", () => {
    expect(isLiveContentKind("openrouter")).toBe(true);
    expect(liveContentKinds).toContain("openrouter");
    expect(providerKinds).toContain("openrouter");
    expect(CURATED_CONTENT_MODELS.openrouter.length).toBeGreaterThan(0);
  });

  it("does not disturb the existing openai/gemini/xai kinds", () => {
    for (const kind of ["openai", "gemini", "xai"] as const) expect(isLiveContentKind(kind)).toBe(true);
    expect(isLiveContentKind("fake")).toBe(false);
  });
});

describe("VE2E-79 OpenRouter: structured content generation (chat-completions)", () => {
  it("V2 posts chat/completions with a strict json_schema, provider.require_parameters and usage.include, over the OpenAI chat wire (not Responses)", async () => {
    const fetchMock = vi.fn(async () => ok(chatBody("{\"ok\":true}")));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateContentOnce("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt", schema);
    expect(result.output).toEqual({ ok: true });
    expect(sentUrl(fetchMock)).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = sentBody(fetchMock);
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body.messages).toEqual([{ role: "user", content: "prompt" }]);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "script_draft", strict: true, schema } });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.usage).toEqual({ include: true });
    expect(headerOf(fetchMock, "authorization")).toBe("Bearer sk-or-test");
    expect(headerOf(fetchMock, "HTTP-Referer")).toBeTruthy();
  });

  it("records real prompt_tokens/completion_tokens and the prepaid usage.cost (the former chat-completions null-token bug is fixed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(chatBody("{\"ok\":true}"))));
    const result = await generateContentOnce("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt", schema);
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 45, providerRequestId: "req_1" });
    expect(result.usage.cost).toEqual({ amount: "0.0012", currency: "USD", unit: "usd" });
  });

  it("V2 without a schema sends neither response_format nor provider (free text, mirroring the other providers)", async () => {
    const fetchMock = vi.fn(async () => ok(chatBody("{\"ok\":true}")));
    vi.stubGlobal("fetch", fetchMock);
    await generateContentOnce("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt");
    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("provider");
  });

  it("V1 sends the editor instructions as a system message and the script_draft_v1 schema name", async () => {
    const fetchMock = vi.fn(async () => ok(chatBody("{\"title\":\"Messi\"}")));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateLiveStructured("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA);
    expect(result.output).toEqual({ title: "Messi" });
    const body = sentBody(fetchMock);
    expect(body.messages).toEqual([
      { role: "system", content: expect.stringContaining("You are LyOnix, a short-form script editor") },
      { role: "user", content: "prompt" },
    ]);
    expect((body.response_format as { json_schema: { name: string } }).json_schema.name).toBe("script_draft_v1");
  });

  it("V1 retries a 400 schema rejection once in JSON mode (json_object), keeping the system instructions", async () => {
    const fetchMock = vi.fn(async () => (fetchMock.mock.calls.length === 1
      ? new Response(JSON.stringify({ error: { message: "response_format json_schema not supported" } }), { status: 400 })
      : ok(chatBody("{\"title\":\"Messi\"}"))));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateLiveStructured("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt", SCRIPT_DRAFT_V1_JSON_SCHEMA)).resolves.toMatchObject({ output: { title: "Messi" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 1).response_format).toEqual({ type: "json_object" });
    expect((sentBody(fetchMock, 1).messages as Array<Record<string, unknown>>)[0]).toMatchObject({ role: "system" });
  });

  it("V2 surfaces a schema rejection and retries once without the schema (schemaRejection set)", async () => {
    const fetchMock = vi.fn(async () => (fetchMock.mock.calls.length === 1
      ? new Response(JSON.stringify({ error: { message: "Invalid schema" } }), { status: 400 })
      : ok(chatBody("{\"ok\":true}"))));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateContentStructuredV2("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt", schema);
    expect(result.output).toEqual({ ok: true });
    expect(result.schemaRejection).toBeTruthy();
    expect(sentBody(fetchMock, 1)).not.toHaveProperty("response_format");
  });
});

describe("VE2E-79 OpenRouter: vision moderation (chat-completions image_url)", () => {
  const frames = [{ mimeType: "image/jpeg", base64: "AAAA" }, { mimeType: "image/png", base64: "BBBB" }];

  it("sends a text part plus image_url data URIs with the classifier instructions and vision_moderation schema", async () => {
    const fetchMock = vi.fn(async () => ok(chatBody("{\"ok\":true}")));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateVisionStructuredOnce("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt", frames, schema)).resolves.toMatchObject({ output: { ok: true } });
    expect(sentUrl(fetchMock)).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = sentBody(fetchMock);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("vision content classifier") });
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "prompt" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ],
    });
    expect((body.response_format as { json_schema: { name: string } }).json_schema.name).toBe("vision_moderation");
  });

  it("a model refusal is PROVIDER_CONTENT_REFUSED (callers fail closed to manual review)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ choices: [{ message: { role: "assistant", refusal: "I can't assess this image." }, finish_reason: "stop" }] })));
    await expect(generateVisionStructuredOnce("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt", frames, schema)).rejects.toMatchObject({ code: "PROVIDER_CONTENT_REFUSED" } satisfies Partial<ProviderError>);
  });

  it("a network failure is normalized to a retryable PROVIDER_TIMEOUT", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(generateVisionStructuredOnce("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt", frames, schema)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true } satisfies Partial<ProviderError>);
  });
});

describe("VE2E-79 OpenRouter: error mapping", () => {
  const generate = () => generateContentOnce("openrouter", "sk-or-test", "openai/gpt-4o-mini", "prompt", schema);

  it("maps 401 to PROVIDER_AUTH_INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "No auth credentials found" } }), { status: 401 })));
    await expect(generate()).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID", retryable: false } satisfies Partial<ProviderError>);
  });

  it("maps 402 (out of prepaid credits) to an account-scoped PROVIDER_QUOTA_EXHAUSTED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 })));
    await expect(generate()).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED", retryable: false, quotaScope: "account" } satisfies Partial<ProviderError>);
  });

  it("caps max_tokens explicitly so OpenRouter does not reserve the model's whole output window", async () => {
    const fetchMock = vi.fn(async () => ok(chatBody('{"ok":true}')));
    vi.stubGlobal("fetch", fetchMock);
    await generate();
    expect(sentBody(fetchMock).max_tokens).toBe(8192);
  });

  it("retries once with the affordable budget when a 402 says it can only afford fewer tokens", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 4000." } }), { status: 402 }))
      .mockResolvedValueOnce(ok(chatBody('{"ok":true}')));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generate()).resolves.toMatchObject({ output: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 1).max_tokens).toBe(3936);
  });

  it("does not retry when the affordable budget is too small to hold a useful answer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "You requested up to 8192 tokens, but can only afford 900." } }), { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generate()).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" } satisfies Partial<ProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 429 to a retryable PROVIDER_RATE_LIMITED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })));
    await expect(generate()).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true } satisfies Partial<ProviderError>);
  });

  it("maps an HTTP 200 body carrying an upstream error object, using its embedded code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ error: { code: 429, message: "upstream rate limited" } })));
    await expect(generate()).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" } satisfies Partial<ProviderError>);
  });

  it("a body without any assistant text is PROVIDER_SCHEMA_INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] })));
    await expect(generate()).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" } satisfies Partial<ProviderError>);
  });
});

describe("VE2E-79 OpenRouter: authenticated key verification", () => {
  const modelsPayload = {
    data: [
      { id: "openai/gpt-4o", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["response_format", "structured_outputs"] },
      { id: "openai/gpt-4o-mini", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["structured_outputs"] },
      { id: "some/text-only-no-structured", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["temperature"] },
      { id: "black-forest-labs/flux", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, supported_parameters: [] },
    ],
  };

  it("proves the key with an authenticated GET /key before listing /models (the keyless /models cannot prove it)", async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url).endsWith("/key")
      ? ok({ data: { label: "sk-or-...abcd", usage: 1.5, limit: 10, is_free_tier: false } })
      : ok(modelsPayload)));
    vi.stubGlobal("fetch", fetchMock);
    const result = await verifyOpenRouterKey("sk-or-test");
    expect(sentUrl(fetchMock, 0)).toBe("https://openrouter.ai/api/v1/key");
    expect(headerOf(fetchMock, "authorization", 0)).toBe("Bearer sk-or-test");
    expect(sentUrl(fetchMock, 1)).toBe("https://openrouter.ai/api/v1/models");
    // content role → structured-output-capable text models only
    expect(result.models).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
    // image-input models for moderation
    expect(result.visionModels).toEqual(["openai/gpt-4o"]);
    expect(result.credits).toMatchObject({ usage: 1.5, limit: 10, limitRemaining: 8.5, isFreeTier: false });
  });

  it("a 401 on GET /key is PROVIDER_AUTH_INVALID and /models is never listed", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyContentKey("openrouter", "bad")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" } satisfies Partial<ProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentUrl(fetchMock, 0)).toBe("https://openrouter.ai/api/v1/key");
  });

  it("verifyContentKey('openrouter') returns the structured-capable model list", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).endsWith("/key") ? ok({ data: {} }) : ok(modelsPayload))));
    await expect(verifyContentKey("openrouter", "sk-or-test")).resolves.toEqual({ models: ["openai/gpt-4o", "openai/gpt-4o-mini"] });
  });
});

describe("VE2E-79 OpenRouter: classifyOpenRouterModels (pure)", () => {
  it("splits text / structured / vision and drops image-output-only models", () => {
    const caps = classifyOpenRouterModels([
      { id: "a/text-structured", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["structured_outputs"] },
      { id: "a/vision", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["response_format"] },
      { id: "a/image-gen", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
    ]);
    expect(caps.text).toEqual(["a/text-structured", "a/vision"]);
    expect(caps.structured).toEqual(["a/text-structured", "a/vision"]);
    expect(caps.vision).toEqual(["a/vision"]);
  });

  it("is lenient when capability fields are absent (counts as text + structured, matching the real probe being the source of truth)", () => {
    const caps = classifyOpenRouterModels([{ id: "x/unknown-shape" }]);
    expect(caps.text).toEqual(["x/unknown-shape"]);
    expect(caps.structured).toEqual(["x/unknown-shape"]);
    expect(caps.vision).toEqual([]);
  });

  it("derives modalities from the `in->out` modality string when explicit arrays are missing", () => {
    const caps = classifyOpenRouterModels([{ id: "y/multimodal", architecture: { modality: "text+image->text" }, supported_parameters: ["structured_outputs"] }]);
    expect(caps.vision).toEqual(["y/multimodal"]);
    expect(caps.structured).toEqual(["y/multimodal"]);
  });
});
