/**
 * Orshot render adapter — second render provider next to Creatomate (cost option).
 * Same DI-fetch pattern as `creatomate.ts`: tests inject `fetch` via `vi.stubGlobal`.
 *
 * Differences from Creatomate that callers must respect:
 * - Orshot only renders a saved Studio template with `modifications` (no fully dynamic `source`
 *   document), so it only serves the fixed-slot "template" render path.
 * - Videos are rendered with `response.mode = "async"`; the job is polled at
 *   `GET /studio/render-jobs/:id` (polling is the source of truth, the webhook is a convenience).
 * - Template list/detail are rate limited (30 req/min per key) — callers must not poll them.
 */
import { ProviderError } from "./index.js";
import type { CreatomateRenderResult, CreatomateRenderStatus, CreatomateTemplateDetail, CreatomateTemplateSummary, ModificationKind, TemplateModificationSlot } from "./creatomate.js";

const API_BASE = "https://api.orshot.com/v1";
const timeoutMs = 30_000;
const submitTimeoutMs = 60_000;

const redact = (value: string) => value.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 220);

const fail = (status: number, retryAfter: string | null, body: unknown): never => {
  const record = (body ?? {}) as Record<string, unknown>;
  const message = typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : "";
  const suffix = message ? `: ${redact(message)}` : "";
  if (status === 401 || status === 403) throw new ProviderError("PROVIDER_AUTH_INVALID", `Orshot authentication failed${suffix}`, false);
  if (status === 404) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Orshot template or render not found${suffix}`, false);
  if (status === 402) throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED", `Orshot credits exhausted${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `Orshot rate limit reached${suffix}`, true, Number(retryAfter ?? 0) * 1000 || undefined);
  if (status === 400 || status === 422) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `Orshot rejected the request${suffix}`, false);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `Orshot request failed (${status})${suffix}`, status >= 500);
};

async function call(path: string, apiKey: string, init: RequestInit = {}, timeout = timeoutMs): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ProviderError("PROVIDER_TIMEOUT", "Orshot request timed out or network failed", true);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(response.status, response.headers.get("retry-after"), body);
  return body;
}

/** Cheapest real, non-billed call that proves the API key works: listing templates (page size 1). */
export async function probeOrshotAccount(apiKey: string): Promise<{ verifiedAt: string }> {
  await call("/studio/templates/all?limit=1", apiKey, { method: "GET" });
  return { verifiedAt: new Date().toISOString() };
}

// --- templates ---

const toSummary = (row: Record<string, unknown>): CreatomateTemplateSummary => ({
  externalTemplateId: String(row.id ?? ""),
  name: typeof row.name === "string" ? row.name : "",
  previewUrl: typeof row.thumbnail_url === "string" ? row.thumbnail_url : null,
  tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
});

const LIST_PAGE_LIMIT = 20;
const MAX_LIST_PAGES = 10;

export async function listOrshotTemplates(apiKey: string): Promise<CreatomateTemplateSummary[]> {
  const out: CreatomateTemplateSummary[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const body = (await call(`/studio/templates/all?page=${page}&limit=${LIST_PAGE_LIMIT}`, apiKey, { method: "GET" })) as Record<string, unknown>;
    const rows = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
    out.push(...rows.map(toSummary));
    const totalPages = Number((body.pagination as Record<string, unknown> | undefined)?.totalPages ?? 1);
    if (rows.length === 0 || page >= totalPages) break;
  }
  return out;
}

/** `source` carries the raw Orshot template object (modifications + canvas) so snapshots can derive slots and canvas later. */
export async function getOrshotTemplate(apiKey: string, externalTemplateId: string): Promise<CreatomateTemplateDetail> {
  const raw = (await call(`/studio/templates/${encodeURIComponent(externalTemplateId)}`, apiKey, { method: "GET" })) as Record<string, unknown>;
  const body = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? (raw.data as Record<string, unknown>) : raw;
  return { ...toSummary(body), source: { ...body, width: body.canvas_width ?? null, height: body.canvas_height ?? null } };
}

const MODIFICATION_KIND: Array<[RegExp, ModificationKind]> = [
  [/video/i, "video"],
  [/audio|voice|music|sound/i, "audio"],
  [/image|logo|photo/i, "image"],
  [/color|colour/i, "color"],
  [/^text$|string/i, "text"],
];

const kindOf = (type: string): ModificationKind | null => MODIFICATION_KIND.find(([re]) => re.test(type))?.[1] ?? null;

/**
 * Slots from an Orshot template's `modifications` array. The Orshot parameter `id` IS the modification
 * key (no `.source`/`.text` suffix). Text/media slots are required (they are the dynamic content the
 * template author exposed); colors are optional styling. Unknown types are skipped, never guessed.
 */
export function deriveOrshotModifications(source: unknown): TemplateModificationSlot[] {
  const rows = source && typeof source === "object" && Array.isArray((source as Record<string, unknown>).modifications) ? ((source as Record<string, unknown>).modifications as Array<Record<string, unknown>>) : [];
  const slots: TemplateModificationSlot[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = typeof row.id === "string" ? row.id : typeof row.key === "string" ? row.key : "";
    const type = typeof row.type === "string" ? row.type : "";
    const kind = kindOf(type);
    if (!key || !kind || seen.has(key)) continue;
    seen.add(key);
    slots.push({ key, kind, label: typeof row.element_name === "string" && row.element_name ? `${row.element_name} (${key})` : key, required: kind === "text" || kind === "video" || kind === "image" });
  }
  return slots;
}

// --- renders ---

const jobStatusToCreatomate = (status: string): CreatomateRenderStatus => {
  if (status === "queued") return "waiting";
  if (status === "processing") return "rendering";
  if (status === "succeeded") return "succeeded";
  return "failed"; // failed | canceled | anything unknown-and-finished
};

const resultUrl = (result: unknown): string | null => {
  if (!result || typeof result !== "object") return null;
  const data = (result as Record<string, unknown>).data;
  if (typeof data === "string" && /^https?:\/\//.test(data)) return data;
  if (data && typeof data === "object") {
    const content = (data as Record<string, unknown>).content;
    if (typeof content === "string") return content;
  }
  const content = (result as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
};

const toRenderResult = (job: Record<string, unknown>): CreatomateRenderResult => {
  const status = typeof job.status === "string" ? job.status : "queued";
  const started = typeof job.started_at === "string" ? Date.parse(job.started_at) : NaN;
  const completed = typeof job.completed_at === "string" ? Date.parse(job.completed_at) : NaN;
  const errorText = typeof job.error === "string" ? job.error : job.error && typeof job.error === "object" ? String((job.error as Record<string, unknown>).message ?? "") : "";
  const code = typeof job.error_code === "string" ? job.error_code : "";
  return {
    externalJobId: String(job.id ?? ""),
    status: jobStatusToCreatomate(status),
    url: resultUrl(job.result),
    progress: null,
    errorMessage: errorText || code ? `${code ? `[${code}] ` : ""}${redact(errorText)}`.trim() : status === "canceled" ? "Orshot render canceled" : null,
    renderDurationMs: Number.isFinite(started) && Number.isFinite(completed) && completed >= started ? completed - started : null,
    snapshotUrl: null,
    renderScale: null,
    width: null,
    height: null,
  };
};

export type SubmitOrshotRenderInput = {
  templateId: string;
  modifications: Record<string, string>;
  webhookUrl: string;
  outputFormat?: "mp4" | "webm" | "mov" | "gif";
  /** Orshot-only: `response.size` preset slug (smart resize). */
  size?: string;
  /** Orshot-only `videoOptions`: total length in seconds (fits the template to the narration) and output fps. */
  videoOptions?: { duration?: number; fps?: number };
  /** `response.includePages`: render only these pages of a multi-page template (a shorter script than the template has pages). */
  includePages?: number[];
};

/** `POST /studio/render` in async mode: always answers 202 with a job, never a file. */
export async function submitOrshotRender(apiKey: string, input: SubmitOrshotRenderInput): Promise<CreatomateRenderResult> {
  const numericId = Number(input.templateId);
  const body = (await call(
    "/studio/render",
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        templateId: Number.isFinite(numericId) ? numericId : input.templateId,
        modifications: input.modifications,
        response: { mode: "async", type: "url", format: input.outputFormat ?? "mp4", ...(input.size ? { size: input.size } : {}), ...(input.includePages && input.includePages.length > 0 ? { includePages: input.includePages } : {}) },
        ...(input.videoOptions && Object.keys(input.videoOptions).length > 0 ? { videoOptions: input.videoOptions } : {}),
        webhook_url: input.webhookUrl,
      }),
    },
    submitTimeoutMs,
  )) as Record<string, unknown>;
  if (body.id === undefined || body.id === null || body.id === "") throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Orshot did not return a render job id", false);
  return toRenderResult(body);
}

export async function getOrshotRender(apiKey: string, externalJobId: string): Promise<CreatomateRenderResult> {
  const body = (await call(`/studio/render-jobs/${encodeURIComponent(externalJobId)}`, apiKey, { method: "GET" })) as Record<string, unknown>;
  return toRenderResult(body);
}
