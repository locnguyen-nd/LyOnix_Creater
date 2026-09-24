import { ProviderError, type ContentGenerationInput, type ContentGenerationResult, type JsonSchema, type ProviderKind } from "./index.js";
import { mergeContentModels, normalizeModelId, resolveContentModel, suggestedModelFromError, type ContentKind } from "./content-models.js";

export type LiveContentInput = ContentGenerationInput & { apiKey: string };
const usage = (body: Record<string, unknown>, requestId: string | null) => {
  const data = (body.usage ?? body.usageMetadata ?? {}) as Record<string, unknown>;
  return { inputTokens: Number(data.input_tokens ?? data.promptTokenCount ?? 0) || null, outputTokens: Number(data.output_tokens ?? data.candidatesTokenCount ?? 0) || null, providerRequestId: requestId, cost: { amount: null, currency: null, unit: "tokens" } };
};
const timeoutMs = 120_000;
const redact = (value: string) => value.replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]").replace(/AIza[a-zA-Z0-9_-]+/g, "[redacted]").slice(0, 220);
const fail = (status: number, retryAfter: string | null, detail = "") => {
  const suffix = detail ? `: ${redact(detail)}` : "";
  const quota = /insufficient_quota|no credits remaining|you have no credits|quota exceeded/i.test(detail);
  const retired = status === 404 || /no longer available|is not found|not found for API version/i.test(detail);
  if (quota) throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED", `Provider quota exhausted${suffix}`, false);
  if (retired) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Model is no longer available${suffix}`, false);
  if (status === 401 || status === 403) throw new ProviderError("PROVIDER_AUTH_INVALID", `Provider authentication failed${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `Provider rate limit reached${suffix}`, true, Number(retryAfter ?? 0) * 1000 || undefined);
  if (status === 400) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `Provider rejected the generate payload${suffix}`, false);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `Provider request failed (${status})${suffix}`, status >= 500);
};
const json = async (response: Response) => {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const err = body.error as Record<string, unknown> | string | undefined;
    const detail = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : JSON.stringify(body).slice(0, 180);
    fail(response.status, response.headers.get("retry-after"), detail);
  }
  return body;
};
const timedFetch = (url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

export const liveContentKinds = ["openai", "gemini", "xai"] as const;
export type LiveContentKind = (typeof liveContentKinds)[number];
export const isLiveContentKind = (value: string): value is LiveContentKind =>
  (liveContentKinds as readonly string[]).includes(value);

const modelIds = (kind: LiveContentKind, body: Record<string, unknown>) => {
  const list = (body.data ?? body.models) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list)) return mergeContentModels(kind, []);
  return mergeContentModels(kind, list.map((item) => String(item.id ?? item.name ?? "")).filter(Boolean));
};

/** Lightweight credential check. Does not generate billed content. */
export async function verifyContentKey(kind: LiveContentKind | Extract<ProviderKind, "openai" | "gemini" | "xai">, apiKey: string) {
  const response = kind === "gemini"
    ? await timedFetch("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": apiKey } })
    : await timedFetch(kind === "openai" ? "https://api.openai.com/v1/models" : "https://api.x.ai/v1/models", { headers: { authorization: `Bearer ${apiKey}` } });
  const body = await json(response);
  return { models: modelIds(kind, body) };
}

const chatText = (body: Record<string, unknown>) => {
  if (typeof body.output_text === "string") return body.output_text;
  const choices = body.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === "string") return message.content;
  const candidates = body.candidates as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  if (typeof parts?.[0]?.text === "string") return parts[0].text;
  return null;
};

const geminiConfig = (schema?: JsonSchema) => ({
  responseMimeType: "application/json",
  ...(schema ? { responseJsonSchema: schema } : {}),
});

const chatFormat = (schema?: JsonSchema) =>
  schema
    ? { type: "json_schema", json_schema: { name: "script_draft_v1", strict: true, schema } }
    : { type: "json_object" };

export async function generateLiveStructured<T>(kind: LiveContentKind, apiKey: string, modelId: string, prompt: string, schema?: JsonSchema): Promise<ContentGenerationResult<T>> {
  const resolved = resolveContentModel(kind as ContentKind, modelId);
  try {
    return await generateLiveStructuredOnce<T>(kind, apiKey, resolved, prompt, schema);
  } catch (error) {
    if (schema && error instanceof ProviderError && error.code === "PROVIDER_SCHEMA_INVALID") {
      return generateLiveStructuredOnce<T>(kind, apiKey, resolved, prompt);
    }
    const hinted = error instanceof ProviderError ? suggestedModelFromError(error.message) : null;
    if (error instanceof ProviderError && error.code === "PROVIDER_CAPABILITY_UNAVAILABLE" && hinted && hinted !== resolved) {
      return generateLiveStructuredOnce<T>(kind, apiKey, hinted, prompt, schema);
    }
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("PROVIDER_TIMEOUT", "Provider generate timed out or network failed", true);
  }
}

async function generateLiveStructuredOnce<T>(kind: LiveContentKind, apiKey: string, modelId: string, prompt: string, schema?: JsonSchema): Promise<ContentGenerationResult<T>> {
  const model = normalizeModelId(modelId);
  if (kind === "gemini") {
    const response = await timedFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: geminiConfig(schema) }),
    });
    const body = await json(response);
    const text = chatText(body);
    if (!text) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Gemini did not return structured text", false);
    try { return { output: JSON.parse(text) as T, usage: usage(body, response.headers.get("x-request-id")) }; }
    catch { throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Gemini did not return valid JSON", false); }
  }
  const url = kind === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://api.x.ai/v1/chat/completions";
  const response = await timedFetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      response_format: chatFormat(schema),
      messages: [
        { role: "system", content: "You are LyOnix, a short-form script editor. Reply with a single JSON object only. Follow the requested creative direction; do not repeat a previous draft." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = await json(response);
  const text = chatText(body);
  if (!text) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Provider did not return structured text", false);
  try { return { output: JSON.parse(text) as T, usage: usage(body, response.headers.get("x-request-id")) }; }
  catch { throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Provider did not return valid JSON", false); }
}

export async function generateOpenAi<T>(input: LiveContentInput, schema: JsonSchema): Promise<ContentGenerationResult<T>> {
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: input.config.modelId, input: input.prompt, text: { format: { type: "json_schema", name: "script_draft", strict: true, schema } } }) });
  const body = await json(response); const output = body.output_text;
  if (typeof output !== "string") throw new ProviderError("PROVIDER_SCHEMA_INVALID", "OpenAI did not return structured text", false);
  return { output: JSON.parse(output) as T, usage: usage(body, response.headers.get("x-request-id")) };
}

export async function generateGemini<T>(input: LiveContentInput, schema: JsonSchema): Promise<ContentGenerationResult<T>> {
  const model = encodeURIComponent(input.config.modelId);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": input.apiKey, "content-type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: input.prompt }] }], generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema } }) });
  const body = await json(response); const candidates = body.candidates as Array<Record<string, unknown>> | undefined; const content = candidates?.[0]?.content as Record<string, unknown> | undefined; const parts = content?.parts as Array<Record<string, unknown>> | undefined; const text = parts?.[0]?.text;
  if (typeof text !== "string") throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Gemini did not return structured text", false);
  return { output: JSON.parse(text) as T, usage: usage(body, response.headers.get("x-request-id")) };
}

export async function generateXai<T>(input: LiveContentInput, schema: JsonSchema): Promise<ContentGenerationResult<T>> {
  const response = await fetch("https://api.x.ai/v1/responses", { method: "POST", headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: input.config.modelId, input: input.prompt, text: { format: { type: "json_schema", name: "script_draft", strict: true, schema } } }) });
  const body = await json(response); const output = body.output_text;
  if (typeof output !== "string") throw new ProviderError("PROVIDER_SCHEMA_INVALID", "xAI did not return structured text", false);
  return { output: JSON.parse(output) as T, usage: usage(body, response.headers.get("x-request-id")) };
}
