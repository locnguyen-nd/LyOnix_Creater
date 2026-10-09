import { ProviderError, type ContentGenerationInput, type ContentGenerationResult, type JsonSchema, type ProviderKind } from "./index.js";
import { discoveredContentModels, normalizeModelId, resolveContentModel, suggestedModelFromError, type ContentKind } from "./content-models.js";
import { classifyOpenRouterModels, type OpenRouterModelCapabilities } from "./openrouter-models.js";

export type LiveContentInput = ContentGenerationInput & { apiKey: string };
const usage = (body: Record<string, unknown>, requestId: string | null) => {
  const data = (body.usage ?? body.usageMetadata ?? {}) as Record<string, unknown>;
  // VE2E-79: OpenAI Responses reports input_tokens/output_tokens, Gemini promptTokenCount/candidatesTokenCount, and
  // OpenRouter (chat-completions) prompt_tokens/completion_tokens - read all three shapes so chat-completions no longer
  // records null tokens (the former bug). `usage.cost` (OpenRouter, requested via `usage.include`) is the prepaid-credit
  // spend in USD; the other providers do not send it, so their usage stays { amount: null, currency: null, unit: "tokens" }.
  const inputTokens = Number(data.input_tokens ?? data.promptTokenCount ?? data.prompt_tokens ?? 0) || null;
  const outputTokens = Number(data.output_tokens ?? data.candidatesTokenCount ?? data.completion_tokens ?? 0) || null;
  const costValue = typeof data.cost === "number" && Number.isFinite(data.cost) ? data.cost : null;
  return {
    inputTokens,
    outputTokens,
    providerRequestId: requestId,
    cost: costValue !== null ? { amount: String(costValue), currency: "USD", unit: "usd" } : { amount: null, currency: null, unit: "tokens" },
  };
};
/** VE2E-138: per-call timeout (env `CONTENT_CALL_TIMEOUT_MS`, default 90 s; was a fixed 120 s that let one slow reasoning model hold a job for minutes). */
const callTimeoutMs = () => { const v = Number(process.env.CONTENT_CALL_TIMEOUT_MS); return Number.isFinite(v) && v >= 5_000 ? v : 90_000; };
const redact = (value: string) => value.replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]").replace(/AIza[a-zA-Z0-9_-]+/g, "[redacted]").slice(0, 220);
/** VE2E-56: Gemini 429 bodies carry "Please retry in 34.5s" / `"retryDelay": "34s"`; returns ms or undefined. */
export const parseRetryDelayMs = (detail: string): number | undefined => {
  const m = /retry in ([0-9.]+)\s*s/i.exec(detail) ?? /retryDelay"?\s*:\s*"?([0-9.]+)s/i.exec(detail);
  const seconds = m ? Number(m[1]) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
};
const parseRetryAfterMs = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(header);
  return Number.isFinite(date) && date > Date.now() ? date - Date.now() : undefined;
};
/** A model's quota with no free allowance at all (`limit: 0` / quotaValue "0"): it will not recover by the next minute. */
const NO_ALLOWANCE_RETRY_MS = 24 * 60 * 60_000;

/**
 * Where a 429 / quota error applies. Gemini quotas are per project AND per model (`...PerProjectPerModel...`, "model: x" in the
 * message): one model running out must only bench that model, even though Google's text also says "check your plan and billing".
 * Only billing / credit / key-wide errors WITHOUT a model in them reach the whole account.
 */
export const classifyQuotaScope = (detail: string): "daily" | "minute" | "account" | undefined => {
  const modelScoped = /PerModel|model:\s*[\w.-]+|model=[\w.-]+/i.test(detail);
  const daily = /PerDay|per day|daily/i.test(detail);
  const minute = /PerMinute|per minute/i.test(detail);
  if (modelScoped) return daily ? "daily" : "minute";
  if (/insufficient_quota|current quota|no credits remaining|you have no credits|billing/i.test(detail)) return "account";
  return daily ? "daily" : minute ? "minute" : undefined;
};

const fail = (status: number, retryAfter: string | null, detail = "") => {
  const suffix = detail ? `: ${redact(detail)}` : "";
  const quota = /insufficient_quota|no credits remaining|you have no credits|quota exceeded|RESOURCE_EXHAUSTED/i.test(detail) && status !== 400;
  const retired = status === 404 || /no longer available|is not found|not found for API version/i.test(detail);
  // Interactions-only agent models (antigravity / deep-research) answer generateContent with 400: not a payload problem, the model is unusable here.
  const wrongApi = /only supports Interactions API|not supported for generateContent|does not support (?:generateContent|chat)/i.test(detail);
  const scope = classifyQuotaScope(detail);
  const noAllowance = /limit[:=]\s*0\b|quotaValue[:=]"?0"?(?:\D|$)/i.test(detail);
  const retryAfterMs = parseRetryAfterMs(retryAfter) ?? parseRetryDelayMs(detail) ?? (noAllowance ? NO_ALLOWANCE_RETRY_MS : undefined);
  if (wrongApi) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Model does not support this API${suffix}`, false);
  if (quota) throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED", `Provider quota exhausted${suffix}`, false, retryAfterMs, scope);
  if (retired) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Model is no longer available${suffix}`, false);
  // VE2E-79: OpenRouter 402 = the prepaid balance cannot cover THIS request. Cost depends on the model (a reasoning model such as
  // gpt-5 can be unaffordable while gpt-4o-mini is fine), so it is model-scoped: only that model is benched (2 min) and the next
  // model/account is tried. It must not cool the whole key or the cheaper models are never reached.
  if (status === 402) throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED", `Provider quota exhausted${suffix}`, false, retryAfterMs ?? 120_000, "minute");
  if (status === 401 || status === 403) throw new ProviderError("PROVIDER_AUTH_INVALID", `Provider authentication failed${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `Provider rate limit reached${suffix}`, true, retryAfterMs, scope);
  if (status === 400) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `Provider rejected the generate payload${suffix}`, false);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `Provider request failed (${status})${suffix}`, status >= 500);
};
const json = async (response: Response) => {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const err = body.error as Record<string, unknown> | string | undefined;
    const message = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : JSON.stringify(body).slice(0, 180);
    fail(response.status, response.headers.get("retry-after"), `${message}${typeof err === "object" && err ? quotaDetail(err) : ""}`);
  }
  return body;
};
const timedFetch = (url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(callTimeoutMs()) });

/**
 * Google RPC error details (`QuotaFailure.violations`, `RetryInfo.retryDelay`) as a short machine-readable suffix, so the
 * classifier sees the quota id / model / limit / delay even when the human message is generic. No secret is in these fields.
 */
export function quotaDetail(error: Record<string, unknown>): string {
  const details = Array.isArray(error.details) ? error.details as Array<Record<string, unknown>> : [];
  const parts: string[] = [];
  // OpenAI-style error identifiers (`type` / `code`: insufficient_quota, rate_limit_exceeded...) live outside the message.
  for (const field of ["type", "code"] as const) {
    const value = error[field];
    if (typeof value === "string" && /^[a-z_]{3,48}$/.test(value)) parts.push(`${field}=${value}`);
  }
  for (const entry of details) {
    for (const violation of Array.isArray(entry.violations) ? entry.violations as Array<Record<string, unknown>> : []) {
      const model = violation.quotaDimensions && typeof violation.quotaDimensions === "object" ? (violation.quotaDimensions as Record<string, unknown>).model : undefined;
      parts.push(`quota=${String(violation.quotaId ?? violation.quotaMetric ?? "?")}${typeof model === "string" ? ` model=${model}` : ""}${violation.quotaValue !== undefined ? ` quotaValue="${String(violation.quotaValue)}"` : ""}`);
    }
    if (typeof entry.retryDelay === "string") parts.push(`retryDelay: "${entry.retryDelay}"`);
  }
  return parts.length ? ` [${parts.join("; ")}]` : "";
}

export const liveContentKinds = ["openai", "gemini", "xai", "openrouter"] as const;
export type LiveContentKind = (typeof liveContentKinds)[number];
export const isLiveContentKind = (value: string): value is LiveContentKind =>
  (liveContentKinds as readonly string[]).includes(value);

/**
 * V00-10: this is account-scoped discovery only (real `/models` response for this key), never
 * unioned with a static catalog. Gemini additionally reports `supportedGenerationMethods` per
 * model - a model listed but missing `generateContent` cannot actually serve
 * `verifyContentKey`/`generateContentOnce`'s call shape, so it is filtered out here rather than
 * discovered as "usable" and failing later at generate time.
 */
const modelIds = (kind: LiveContentKind, body: Record<string, unknown>) => {
  const list = (body.data ?? body.models) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(list)) return [] as string[];
  const ids = list
    .filter((item) => {
      if (kind !== "gemini") return true;
      const methods = item.supportedGenerationMethods;
      // Be lenient when the field is absent (not every response includes it); only filter when it explicitly excludes generateContent.
      return !Array.isArray(methods) || methods.includes("generateContent");
    })
    .map((item) => String(item.id ?? item.name ?? ""))
    .filter(Boolean);
  return discoveredContentModels(kind, ids);
};

// --- VE2E-79: OpenRouter (chat-completions) ---

/**
 * OpenRouter is one key fronting many upstream vendors over the OpenAI chat-completions wire
 * contract (NOT the Responses API that openai/xai use here, nor Gemini's generateContent). It is a
 * `content`-role account type additive to openai/gemini/xai - their call paths are untouched.
 * Structured output is `response_format: json_schema` plus `provider.require_parameters` so
 * OpenRouter only routes to an upstream endpoint that honours the schema; without a schema the
 * request mirrors each caller's existing no-schema fallback (V1 JSON mode, V2 free text).
 */
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
/** OpenRouter's recommended attribution headers (optional); fixed here, made configurable in the VE2E-80 wiring. */
const OPENROUTER_ATTRIBUTION = { "HTTP-Referer": "https://lyonix.app", "X-Title": "LyOnix Creater" } as const;
const openRouterHeaders = (apiKey: string) => ({ authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...OPENROUTER_ATTRIBUTION });

/** Chat-completions `response_format`: strict json_schema with a schema, JSON mode or nothing without one. */
const chatCompletionsFormat = (schema: JsonSchema | undefined, options: ResponsesOptions) => {
  if (schema) return { type: "json_schema", json_schema: { name: options.schemaName ?? "script_draft", strict: true, schema } };
  return options.jsonModeWithoutSchema ? { type: "json_object" } : undefined;
};

/** One chat-completions user-message content: a plain prompt string, or mixed text + image_url parts (vision). */
type ChatCompletionsContent = string | ReadonlyArray<Record<string, unknown>>;
const openRouterImagePart = (part: VisionInputPart) => ({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.base64}` } });

/**
 * Text of a chat-completions body. OpenRouter can answer HTTP 200 with a top-level `error` object
 * (an upstream failure after the gateway accepted the request); that is mapped through the same
 * `fail()` as a non-200, using the error's embedded HTTP code when present. A model refusal or a
 * `length` finish is reported as such rather than a generic "no structured text".
 */
const chatCompletionsText = (body: Record<string, unknown>, label: string): string => {
  const topError = body.error as Record<string, unknown> | string | undefined;
  if (topError) {
    const detail = typeof topError === "string" ? topError : typeof topError.message === "string" ? topError.message : JSON.stringify(topError).slice(0, 180);
    const status = typeof topError === "object" && typeof topError.code === "number" ? (topError.code as number) : 502;
    fail(status, null, detail);
  }
  const choices = body.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (typeof message?.refusal === "string" && message.refusal) {
    throw new ProviderError("PROVIDER_CONTENT_REFUSED", `${label} refused the request: ${redact(message.refusal)}`, false);
  }
  if (choice?.finish_reason === "length") {
    throw new ProviderError("PROVIDER_SCHEMA_INVALID", `${label} returned an incomplete response (length)`, false);
  }
  const content = message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = (content as Array<Record<string, unknown>>).map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
    if (joined.trim()) return joined;
  }
  throw new ProviderError("PROVIDER_SCHEMA_INVALID", `${label} did not return structured text`, false);
};

/** One structured chat-completions call to OpenRouter (text prompt or vision parts). Callers normalize network/abort failures to PROVIDER_TIMEOUT. */
/** Output-token ceiling per OpenRouter call: enough for a full script/keyword JSON, small enough not to reserve the model's whole window against the credit balance. */
const OPENROUTER_MAX_OUTPUT_TOKENS = 8_192;
async function generateOpenRouter<T>(apiKey: string, modelId: string, content: ChatCompletionsContent, schema: JsonSchema | undefined, options: ResponsesOptions): Promise<ContentGenerationResult<T>> {
  const messages: Array<Record<string, unknown>> = [];
  if (options.instructions) messages.push({ role: "system", content: options.instructions });
  messages.push({ role: "user", content });
  const format = chatCompletionsFormat(schema, options);
  const post = async (maxTokens: number) => {
    const response = await timedFetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: openRouterHeaders(apiKey),
      body: JSON.stringify({
        model: modelId,
        messages,
        // Without an explicit cap OpenRouter reserves the model's full output window (e.g. 65536) against the prepaid balance and 402s.
        max_tokens: maxTokens,
        ...(format ? { response_format: format } : {}),
        // require_parameters makes OpenRouter skip any upstream endpoint that would ignore the schema (OpenRouter docs, 2026-10-04).
        ...(schema ? { provider: { require_parameters: true } } : {}),
        // Ask OpenRouter to return the prepaid-credit cost in `usage` (source for the VE2E-28 cost ceilings).
        usage: { include: true },
      }),
    });
    return { response, body: await json(response) };
  };
  const { response, body } = await post(OPENROUTER_MAX_OUTPUT_TOKENS);
  const text = chatCompletionsText(body, "OpenRouter");
  try { return { output: JSON.parse(text) as T, usage: usage(body, response.headers.get("x-request-id")) }; }
  catch { throw new ProviderError("PROVIDER_SCHEMA_INVALID", "OpenRouter did not return valid JSON", false); }
}

/** Prepaid-credit snapshot from `GET /key` (`data.limit`/`data.usage`); any field OpenRouter omits stays null. */
export type OpenRouterCredits = { usage: number | null; limit: number | null; limitRemaining: number | null; isFreeTier: boolean | null };
const readOpenRouterCredits = (body: Record<string, unknown>): OpenRouterCredits | null => {
  const data = body.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return null;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const usageValue = num(data.usage);
  const limit = num(data.limit);
  return {
    usage: usageValue,
    limit,
    limitRemaining: num(data.limit_remaining) ?? (limit !== null && usageValue !== null ? limit - usageValue : null),
    isFreeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
  };
};

export type OpenRouterVerifyResult = { models: string[]; visionModels: string[]; capabilities: OpenRouterModelCapabilities; credits: OpenRouterCredits | null };

/**
 * VE2E-79 / V00-10: OpenRouter's `GET /models` works without a key, so it cannot prove the key is
 * valid. The key is proven with an authenticated `GET /key` (401 on a bad key) - a free metadata
 * call, no billed generation - and `/models` is then listed and split into usable sets. The content
 * role needs structured output, so `models` is the structured-capable set (falling back to all
 * text models when the listing reports no capability fields); `visionModels` feeds image moderation.
 */
export async function verifyOpenRouterKey(apiKey: string): Promise<OpenRouterVerifyResult> {
  const keyResponse = await timedFetch(`${OPENROUTER_BASE}/key`, { headers: openRouterHeaders(apiKey) });
  const keyBody = await json(keyResponse);
  const credits = readOpenRouterCredits(keyBody);
  const modelsResponse = await timedFetch(`${OPENROUTER_BASE}/models`, { headers: openRouterHeaders(apiKey) });
  const modelsBody = await json(modelsResponse);
  const list = Array.isArray(modelsBody.data) ? (modelsBody.data as unknown[]) : [];
  const capabilities = classifyOpenRouterModels(list);
  return { models: capabilities.structured.length ? capabilities.structured : capabilities.text, visionModels: capabilities.vision, capabilities, credits };
}

/** Lightweight credential check. Does not generate billed content. Discovery evidence only - see `modelIds`. */
export async function verifyContentKey(kind: LiveContentKind | Extract<ProviderKind, "openai" | "gemini" | "xai" | "openrouter">, apiKey: string) {
  if (kind === "openrouter") {
    const { models } = await verifyOpenRouterKey(apiKey);
    return { models };
  }
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

/** V1 editor persona; was the Chat Completions `system` message before VE2E-122, now the Responses `instructions`. */
const SCRIPT_V1_INSTRUCTIONS = "You are LyOnix, a short-form script editor. Reply with a single JSON object only. Follow the requested creative direction; do not repeat a previous draft.";

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
  // VE2E-122: openai/xai V1 uses the same Responses API call as V2 and sends no `temperature` (owner decision: reasoning
  // models reject it). Only the instructions, the schema name and the JSON-mode fallback without a schema are V1-specific.
  const options: ResponsesOptions = { instructions: SCRIPT_V1_INSTRUCTIONS, schemaName: "script_draft_v1", jsonModeWithoutSchema: true };
  if (kind === "openrouter") return generateOpenRouter<T>(apiKey, model, prompt, schema, options);
  return kind === "openai" ? generateOpenAi<T>(apiKey, model, prompt, schema, options) : generateXai<T>(apiKey, model, prompt, schema, options);
}

/** VE2E-122: optional request extras for the V1 script flow. Omitted (V2, model probe, keyword extraction) the request body is unchanged. */
export type ResponsesOptions = {
  /** System instructions (V1's editor persona). */
  instructions?: string;
  /** `text.format.name` of the strict json_schema; default `script_draft`. */
  schemaName?: string;
  /** Without a schema, request JSON mode (`json_object`) instead of free text - V1's former chat `response_format` fallback. */
  jsonModeWithoutSchema?: boolean;
};

const responsesFormat = (schema: JsonSchema | undefined, options: ResponsesOptions) => {
  if (schema) return { format: { type: "json_schema", name: options.schemaName ?? "script_draft", strict: true, schema } };
  return options.jsonModeWithoutSchema ? { format: { type: "json_object" } } : undefined;
};

/**
 * VE2E-122: text of a raw REST `/v1/responses` body. `output_text` is a convenience the official SDKs compute client-side
 * (openai-node `addOutputText`), so the wire shape carries the text as `output_text` content parts of `message` items in
 * `output[]`; a top-level `output_text` string is still honoured when a server sends one. A refusal or an incomplete
 * response is reported as such instead of a generic "no structured text".
 */
const responsesText = (body: Record<string, unknown>, label: string): string => {
  if (body.status === "incomplete") {
    const details = body.incomplete_details as Record<string, unknown> | null | undefined;
    const reason = typeof details?.reason === "string" ? details.reason : "unknown";
    throw new ProviderError("PROVIDER_SCHEMA_INVALID", `${label} returned an incomplete response (${reason})`, false);
  }
  const texts: string[] = [];
  let refusal: string | null = null;
  const items = Array.isArray(body.output) ? body.output as Array<Record<string, unknown>> : [];
  for (const item of items) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
      else if (part?.type === "refusal") refusal = typeof part.refusal === "string" ? part.refusal : "";
    }
  }
  if (texts.length > 0) return texts.join("");
  if (typeof body.output_text === "string") return body.output_text;
  if (refusal !== null) throw new ProviderError("PROVIDER_CONTENT_REFUSED", `${label} refused the request${refusal ? `: ${redact(refusal)}` : ""}`, false);
  throw new ProviderError("PROVIDER_SCHEMA_INVALID", `${label} did not return structured text`, false);
};

/** Responses `input`: a plain prompt, or (VE2E-123 vision) one user message whose content mixes `input_text` and `input_image` parts. */
type ResponsesInput = string | ReadonlyArray<{ role: "user"; content: ReadonlyArray<Record<string, string>> }>;

/** One structured call on a Responses API endpoint (OpenAI and xAI share the wire contract). */
async function generateResponses<T>(url: string, label: string, apiKey: string, modelId: string, input: ResponsesInput, schema: JsonSchema | undefined, options: ResponsesOptions): Promise<ContentGenerationResult<T>> {
  const response = await timedFetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      ...(options.instructions ? { instructions: options.instructions } : {}),
      input,
      text: responsesFormat(schema, options),
    }),
  });
  const body = await json(response);
  const text = responsesText(body, label);
  try { return { output: JSON.parse(text) as T, usage: usage(body, response.headers.get("x-request-id")) }; }
  catch { throw new ProviderError("PROVIDER_SCHEMA_INVALID", `${label} did not return valid JSON`, false); }
}

/**
 * OpenAI Responses API (preferred over Chat Completions for structured output per
 * https://platform.openai.com/docs/guides/structured-outputs and DEC-2026-09-24 §VE2E-01).
 * `apiKey`/`modelId`/`prompt` are passed directly (not wrapped in `ContentGenerationInput`)
 * so this can be reused by both the account-adapter port and the VE2E-01 ScriptDraftV2 flow.
 */
export async function generateOpenAi<T>(apiKey: string, modelId: string, prompt: string, schema?: JsonSchema, options: ResponsesOptions = {}): Promise<ContentGenerationResult<T>> {
  return generateResponses<T>("https://api.openai.com/v1/responses", "OpenAI", apiKey, modelId, prompt, schema, options);
}

/** Gemini structured output via `generateContent` + `responseJsonSchema` (no separate Responses API). */
export async function generateGemini<T>(apiKey: string, modelId: string, prompt: string, schema?: JsonSchema): Promise<ContentGenerationResult<T>> {
  const model = encodeURIComponent(normalizeModelId(modelId));
  const response = await timedFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
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

/** xAI/Grok Responses API, mirrors OpenAI (same wire contract for `/v1/responses`). */
export async function generateXai<T>(apiKey: string, modelId: string, prompt: string, schema?: JsonSchema, options: ResponsesOptions = {}): Promise<ContentGenerationResult<T>> {
  return generateResponses<T>("https://api.x.ai/v1/responses", "xAI", apiKey, modelId, prompt, schema, options);
}

/**
 * Single attempt, exact-endpoint dispatch used by both the operation-specific model probe
 * (`content-probe.ts`) and `generateContentStructuredV2` below. Network/abort failures are
 * normalized to `PROVIDER_TIMEOUT` so callers never see a raw fetch rejection.
 */
export async function generateContentOnce<T>(kind: LiveContentKind, apiKey: string, modelId: string, prompt: string, schema?: JsonSchema): Promise<ContentGenerationResult<T>> {
  const model = normalizeModelId(modelId);
  try {
    if (kind === "gemini") return await generateGemini<T>(apiKey, model, prompt, schema);
    if (kind === "openai") return await generateOpenAi<T>(apiKey, model, prompt, schema);
    if (kind === "openrouter") return await generateOpenRouter<T>(apiKey, model, prompt, schema, {});
    return await generateXai<T>(apiKey, model, prompt, schema);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("PROVIDER_TIMEOUT", "Provider generate timed out or network failed", true);
  }
}

// --- VE2E-24: vision (image/video-frame) input structured generate ---

/** One inline media part (base64-encoded) to attach alongside the text prompt. `mimeType` must be an image type accepted by the target provider (e.g. `image/jpeg`, `image/png`) - a sampled video frame is sent as a still image, never raw video bytes. */
export type VisionInputPart = { mimeType: string; base64: string };

const geminiInlinePart = (part: VisionInputPart) => ({ inlineData: { mimeType: part.mimeType, data: part.base64 } });
/** VE2E-123: Responses image part; no `detail` (owner decision: keep the provider default `auto`, same as Chat Completions before). */
const responsesImagePart = (part: VisionInputPart) => ({ type: "input_image", image_url: `data:${part.mimeType};base64,${part.base64}` });

/** Vision classifier persona; was the Chat Completions `system` message before VE2E-123, now the Responses `instructions`. */
const VISION_INSTRUCTIONS = "You are a vision content classifier. Reply with a single JSON object only, matching the requested schema exactly. No other text, no markdown.";

/**
 * Single attempt, exact-endpoint vision dispatch - mirrors `generateContentOnce` but attaches
 * one or more inline image parts to the same real generate endpoint (Gemini `generateContent`
 * inline_data, OpenAI/xAI Responses API `input_image` data URI since VE2E-123). Used by
 * `vision-probe.ts`/`vision-moderation.ts` so capability verification and the real moderation
 * call go through the identical request shape - never a separate "probe-only" payload that
 * could pass while the real moderation call shape silently fails.
 */
export async function generateVisionStructuredOnce<T>(kind: LiveContentKind, apiKey: string, modelId: string, prompt: string, media: readonly VisionInputPart[], schema?: JsonSchema): Promise<ContentGenerationResult<T>> {
  const model = normalizeModelId(modelId);
  try {
    if (kind === "gemini") {
      const response = await timedFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, ...media.map(geminiInlinePart)] }], generationConfig: geminiConfig(schema) }),
      });
      const body = await json(response);
      const text = chatText(body);
      if (!text) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Gemini did not return structured text", false);
      try { return { output: JSON.parse(text) as T, usage: usage(body, response.headers.get("x-request-id")) }; }
      catch { throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Gemini did not return valid JSON", false); }
    }
    if (kind === "openrouter") {
      // VE2E-79: chat-completions vision - the user message mixes a text part with `image_url` data URIs. The probe and the
      // real moderation come through this same shape (never a separate probe-only payload). `require_parameters` is set by
      // generateOpenRouter when a schema is present, so OpenRouter only routes to an image-capable endpoint that honours it.
      const content = [{ type: "text", text: prompt }, ...media.map(openRouterImagePart)];
      return await generateOpenRouter<T>(apiKey, model, content, schema, { instructions: VISION_INSTRUCTIONS, schemaName: "vision_moderation", jsonModeWithoutSchema: true });
    }
    // VE2E-123: openai/xai on the Responses API, no `temperature` (owner decision: reasoning models reject it, and a 400 here would
    // mark the whole model as not vision-capable). The probe and the real moderation both come through here, so their shapes stay identical.
    const url = kind === "openai" ? "https://api.openai.com/v1/responses" : "https://api.x.ai/v1/responses";
    const input = [{ role: "user" as const, content: [{ type: "input_text", text: prompt }, ...media.map(responsesImagePart)] }];
    return await generateResponses<T>(url, kind === "openai" ? "OpenAI" : "xAI", apiKey, model, input, schema, { instructions: VISION_INSTRUCTIONS, schemaName: "vision_moderation", jsonModeWithoutSchema: true });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("PROVIDER_TIMEOUT", "Provider vision generate timed out or network failed", true);
  }
}

/**
 * VE2E-01: resilient structured generate on the exact live endpoint (Responses API for
 * openai/xai, `generateContent` for gemini) — schema-invalid retries once without the
 * strict schema, and a retired/capability-unavailable model retries once with the hinted
 * replacement model (same retry shape as `generateLiveStructured`, kept as a separate
 * function because V1 adds its own instructions/JSON-mode options and reports no schema rejection).
 */
export async function generateContentStructuredV2<T>(kind: LiveContentKind, apiKey: string, modelId: string, prompt: string, schema?: JsonSchema): Promise<ContentGenerationResult<T> & { schemaRejection?: string }> {
  const resolved = resolveContentModel(kind as ContentKind, modelId);
  try {
    return await generateContentOnce<T>(kind, apiKey, resolved, prompt, schema);
  } catch (error) {
    if (schema && error instanceof ProviderError && error.code === "PROVIDER_SCHEMA_INVALID") {
      // VE2E-50: the strict schema was rejected (HTTP 400 / unparsable structured text) and the call is repeated WITHOUT
      // it - the model then only follows the prompt, which is a known way for the optional visualPlan to go missing.
      // Surface it so the run diagnostics can say so instead of hiding it.
      const retried = await generateContentOnce<T>(kind, apiKey, resolved, prompt);
      return { ...retried, schemaRejection: error.message.slice(0, 200) };
    }
    const hinted = error instanceof ProviderError ? suggestedModelFromError(error.message) : null;
    if (error instanceof ProviderError && error.code === "PROVIDER_CAPABILITY_UNAVAILABLE" && hinted && hinted !== resolved) {
      return generateContentOnce<T>(kind, apiKey, hinted, prompt, schema);
    }
    throw error;
  }
}
