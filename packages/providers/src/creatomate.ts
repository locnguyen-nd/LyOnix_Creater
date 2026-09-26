/**
 * VE2E-05: real Creatomate adapter — template catalog/detail, `POST /v2/renders`
 * submit and status GET. Same DI-fetch pattern as `elevenlabs.ts`/`pexels.ts`: tests
 * inject `fetch` via `vi.stubGlobal`, this module never decides on its own to skip a
 * real HTTP call. No webhook signature verification lives here — Creatomate does not
 * document a per-account webhook signing secret, so the caller (apps/api) embeds an
 * unguessable per-render token in the `webhook_url` itself (same "capability URL"
 * pattern as `media-delivery.service.ts`) and verifies that token server-side.
 */
import { ProviderError } from "./index.js";

const API_BASE = "https://api.creatomate.com/v2";
const timeoutMs = 30_000;
/** Render submission itself can legitimately take longer to accept than a read call, but this is still just the HTTP round trip to *accept* the job, not the render duration. */
const submitTimeoutMs = 60_000;

const redact = (value: string) => value.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 220);

const fail = (status: number, retryAfter: string | null, body: unknown): never => {
  const record = (body ?? {}) as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : "";
  const suffix = message ? `: ${redact(message)}` : "";
  if (status === 401 || status === 403) throw new ProviderError("PROVIDER_AUTH_INVALID", `Creatomate authentication failed${suffix}`, false);
  if (status === 404) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Creatomate template or render not found${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `Creatomate rate limit reached${suffix}`, true, Number(retryAfter ?? 0) * 1000 || undefined);
  if (status === 400 || status === 422) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `Creatomate rejected the request${suffix}`, false);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `Creatomate request failed (${status})${suffix}`, status >= 500);
};

const timedFetch = (path: string, apiKey: string, init: RequestInit = {}, timeout = timeoutMs): Promise<Response> =>
  fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeout),
  });

async function call(path: string, apiKey: string, init: RequestInit = {}, timeout = timeoutMs): Promise<unknown> {
  let response: Response;
  try {
    response = await timedFetch(path, apiKey, init, timeout);
  } catch {
    throw new ProviderError("PROVIDER_TIMEOUT", "Creatomate request timed out or network failed", true);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(response.status, response.headers.get("retry-after"), body);
  return body;
}

// --- account preflight ---

/** Cheapest real, non-billed call that proves the API key works: listing templates (page size 1). */
export async function probeCreatomateAccount(apiKey: string): Promise<{ verifiedAt: string }> {
  await call("/templates?limit=1", apiKey, { method: "GET" });
  return { verifiedAt: new Date().toISOString() };
}

// --- templates ---

export type CreatomateTemplateSummary = { externalTemplateId: string; name: string; previewUrl: string | null; tags: string[] };

const toTemplateSummary = (row: Record<string, unknown>): CreatomateTemplateSummary => ({
  externalTemplateId: String(row.id ?? ""),
  name: typeof row.name === "string" ? row.name : "",
  previewUrl: typeof row.preview_image_url === "string" ? row.preview_image_url : typeof row.preview_url === "string" ? row.preview_url : null,
  tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
});

export async function listCreatomateTemplates(apiKey: string): Promise<CreatomateTemplateSummary[]> {
  const body = await call("/templates", apiKey, { method: "GET" });
  const rows = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
  return rows.map(toTemplateSummary);
}

export type CreatomateTemplateDetail = CreatomateTemplateSummary & { source: unknown };

export async function getCreatomateTemplate(apiKey: string, externalTemplateId: string): Promise<CreatomateTemplateDetail> {
  const body = (await call(`/templates/${encodeURIComponent(externalTemplateId)}`, apiKey, { method: "GET" })) as Record<string, unknown>;
  return { ...toTemplateSummary(body), source: body.source ?? body.elements ?? null };
}

// --- modification slot derivation ---

export type ModificationKind = "text" | "video" | "image" | "audio" | "color" | "font" | "volume";
export type TemplateModificationSlot = { key: string; kind: ModificationKind; label: string; required: boolean };

const ELEMENT_KIND: Record<string, "text" | "video" | "image" | "audio" | undefined> = { text: "text", video: "video", image: "image", audio: "audio" };

/**
 * Best-effort derivation of logical modification slots from a Creatomate template's
 * `source` element tree. Creatomate identifies a modification target by
 * `<element name>.<property>` (e.g. `Text-1.text`, `Video-1.source`) — this walks the
 * template's element list and emits the conventional property key per element type,
 * matching the shape already prototyped in `apps/web/src/studio/creatomate-placeholder.ts`.
 * Never invents a key that is not backed by a real, named element in the template.
 */
export function deriveTemplateModifications(source: unknown): TemplateModificationSlot[] {
  const slots: TemplateModificationSlot[] = [];
  const seen = new Set<string>();
  const push = (key: string, kind: ModificationKind, required: boolean) => {
    if (seen.has(key)) return;
    seen.add(key);
    slots.push({ key, kind, label: key, required });
  };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    const kind = ELEMENT_KIND[type];
    if (name && kind) {
      if (kind === "text") {
        push(`${name}.text`, "text", true);
        push(`${name}.font_family`, "font", false);
        push(`${name}.fill_color`, "color", false);
      } else if (kind === "video" || kind === "image") {
        push(`${name}.source`, kind, true);
        if (kind === "video") push(`${name}.volume`, "volume", false);
      } else if (kind === "audio") {
        // VE2E-06: an audio element's `source` lets the Auto orchestrator attach a
        // generated narration clip — never required, since many audio elements are
        // fixed background music the template author does not want overridden.
        push(`${name}.source`, "audio", false);
        push(`${name}.volume`, "volume", false);
      }
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(source);
  return slots;
}

// --- renders ---

export type CreatomateRenderStatus = "planned" | "waiting" | "transcribing" | "rendering" | "succeeded" | "failed";

export type CreatomateRenderResult = {
  externalJobId: string;
  status: CreatomateRenderStatus;
  url: string | null;
  progress: number | null;
  errorMessage: string | null;
  renderDurationMs: number | null;
  /** VE2E-19: Creatomate's own render-frame preview image, when the provider includes one. */
  snapshotUrl: string | null;
};

const toRenderResult = (row: Record<string, unknown>): CreatomateRenderResult => ({
  externalJobId: String(row.id ?? ""),
  status: (typeof row.status === "string" ? row.status : "planned") as CreatomateRenderStatus,
  url: typeof row.url === "string" ? row.url : null,
  progress: typeof row.progress === "number" ? row.progress : null,
  errorMessage: typeof row.error_message === "string" ? row.error_message : null,
  renderDurationMs: typeof row.render_duration === "number" ? Math.round(row.render_duration * 1000) : null,
  snapshotUrl: typeof row.snapshot_url === "string" ? row.snapshot_url : null,
});

export type SubmitRenderInput = {
  templateId: string;
  modifications: Record<string, string>;
  webhookUrl: string;
  outputFormat?: "mp4" | "mov" | "gif";
};

/**
 * `POST /v2/renders`. Creatomate's own API accepts an array-shaped request (it can
 * render several sources per call) and always answers with an array of render
 * objects — this adapter only ever submits one template per call and returns its
 * single resulting render.
 */
export async function submitCreatomateRender(apiKey: string, input: SubmitRenderInput): Promise<CreatomateRenderResult> {
  const body = await call(
    "/renders",
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        template_id: input.templateId,
        modifications: input.modifications,
        webhook_url: input.webhookUrl,
        ...(input.outputFormat ? { output_format: input.outputFormat } : {}),
      }),
    },
    submitTimeoutMs,
  );
  const rows = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [body as Record<string, unknown>];
  const first = rows[0];
  if (!first || !first.id) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Creatomate did not return a render id", false);
  return toRenderResult(first);
}

export type SubmitSourceRenderInput = { source: Record<string, unknown>; webhookUrl: string };

/** Same `POST /v2/renders` endpoint as `submitCreatomateRender`, but with a fully dynamic `source` document instead of `template_id`+`modifications` — see `creatomate-dynamic.ts`. */
export async function submitCreatomateSourceRender(apiKey: string, input: SubmitSourceRenderInput): Promise<CreatomateRenderResult> {
  const body = await call(
    "/renders",
    apiKey,
    { method: "POST", body: JSON.stringify({ source: input.source, webhook_url: input.webhookUrl }) },
    submitTimeoutMs,
  );
  const rows = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [body as Record<string, unknown>];
  const first = rows[0];
  if (!first || !first.id) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Creatomate did not return a render id", false);
  return toRenderResult(first);
}

export async function getCreatomateRender(apiKey: string, externalJobId: string): Promise<CreatomateRenderResult> {
  const body = (await call(`/renders/${encodeURIComponent(externalJobId)}`, apiKey, { method: "GET" })) as Record<string, unknown>;
  return toRenderResult(body);
}

/** Maps Creatomate's own status vocabulary to the normalized `RenderJobStatus` state machine (`@lyonix/domain`). */
export function normalizeCreatomateStatus(status: CreatomateRenderStatus): "queued" | "rendering" | "completed" | "failed" {
  if (status === "planned" || status === "waiting") return "queued";
  if (status === "transcribing" || status === "rendering") return "rendering";
  if (status === "succeeded") return "completed";
  return "failed";
}
