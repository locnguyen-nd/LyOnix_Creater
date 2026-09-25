/**
 * VE2E-01 operation-specific model probe: verifies an account/model pair against the exact
 * endpoint used for real ScriptDraftV2 generation (Responses API / `generateContent`), not a
 * static `/models` list. Applies the same "usable-on-generate" principle noted for V00-10:
 * an HTTP 200 on the list-models endpoint does not mean the account can actually generate
 * with that model (billing/entitlement/region gating happens per-model on generate).
 */
import { ProviderError, type JsonSchema } from "./index.js";
import { CURATED_CONTENT_MODELS, normalizeModelId } from "./content-models.js";
import { generateContentOnce, type LiveContentKind } from "./live-content.js";

export type ContentModelProbeResult = { modelId: string; verifiedAt: string };

/**
 * V00-10: the full lifecycle status a model can hold for one account, distinct from the
 * account's own `verified|failed` status. `usable` is only reached by a real generate call
 * that succeeded on the exact endpoint - a model appearing in `/models` is `unverified`
 * (discovery evidence only) until individually probed.
 */
export type ContentModelStatus = "usable" | "unverified" | "unsupported" | "retired" | "temporarily_unavailable";

export type ContentModelSnapshotEntry = {
  modelId: string;
  status: ContentModelStatus;
  /** ISO timestamp of the last real check (probe or listing) for this specific model. */
  checkedAt: string;
  source: "probed" | "listed";
  reason?: string;
};

/**
 * Bounded re-probe window: a snapshot entry older than this is treated as stale and must be
 * re-checked against the real endpoint before being trusted again (e.g. before accepting a
 * model switch). This is a passive TTL check on read, not a background scheduler - nothing in
 * `apps/api` runs a cron loop to keep entries fresh proactively.
 */
export const CONTENT_MODEL_FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000;

export const isFreshCheckedAt = (checkedAt: string | null | undefined, ttlMs = CONTENT_MODEL_FRESHNESS_TTL_MS, now: number = Date.now()): boolean => {
  if (!checkedAt) return false;
  const t = new Date(checkedAt).getTime();
  return Number.isFinite(t) && now - t < ttlMs;
};

export const findModelSnapshotEntry = (
  snapshot: readonly ContentModelSnapshotEntry[] | null | undefined,
  modelId: string,
): ContentModelSnapshotEntry | undefined => {
  const wanted = normalizeModelId(modelId);
  return snapshot?.find((entry) => entry.modelId === wanted);
};

const PROBE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};
const PROBE_PROMPT = 'Reply with exactly one JSON object: {"ok":true}. No other text, no markdown.';

/** Minimal, low-token real generate call against one model on the exact generate endpoint. */
export async function probeContentModel(kind: LiveContentKind, apiKey: string, modelId: string): Promise<ContentModelProbeResult> {
  await generateContentOnce<{ ok?: boolean }>(kind, apiKey, modelId, PROBE_PROMPT, PROBE_SCHEMA);
  return { modelId: normalizeModelId(modelId), verifiedAt: new Date().toISOString() };
}

const statusForProbeError = (error: unknown): ContentModelStatus => {
  if (!(error instanceof ProviderError)) return "unsupported";
  if (error.code === "PROVIDER_CAPABILITY_UNAVAILABLE") return "retired";
  if (error.code === "PROVIDER_RATE_LIMITED") return "temporarily_unavailable";
  return "unsupported";
};

export type PickUsableContentModelResult = ContentModelProbeResult & {
  /** Every candidate tried before the winner, each with the real reason it was rejected - used to build an account-scoped model snapshot instead of leaving rejected models unexplained. */
  attempted: ContentModelSnapshotEntry[];
};

/**
 * Tries `preferredModelId` first, then the curated model list for `kind`, until one model
 * actually succeeds a real generate call. Auth/quota failures are account-wide — they stop
 * immediately instead of burning the rest of the candidate list. A per-model
 * capability/schema failure moves on to the next candidate. Never returns a model ID that
 * was not actually verified against the generate endpoint (no static-list fallback).
 */
export async function pickUsableContentModel(
  kind: LiveContentKind,
  apiKey: string,
  preferredModelId?: string | null,
  candidates: readonly string[] = CURATED_CONTENT_MODELS[kind],
): Promise<PickUsableContentModelResult> {
  const seen = new Set<string>();
  const ordered = [preferredModelId, ...candidates]
    .filter((id): id is string => Boolean(id))
    .map((id) => normalizeModelId(id))
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  if (ordered.length === 0) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", "No candidate content model configured for this provider", false);
  const attempted: ContentModelSnapshotEntry[] = [];
  let lastError: unknown;
  for (const modelId of ordered) {
    try {
      const result = await probeContentModel(kind, apiKey, modelId);
      return { ...result, attempted };
    } catch (error) {
      lastError = error;
      if (error instanceof ProviderError && (error.code === "PROVIDER_AUTH_INVALID" || error.code === "PROVIDER_QUOTA_EXHAUSTED")) throw error;
      // capability_unavailable / schema_invalid / rate_limited on this model -> try the next candidate,
      // but remember why so the account snapshot can explain it instead of silently dropping it.
      attempted.push({
        modelId,
        status: statusForProbeError(error),
        checkedAt: new Date().toISOString(),
        source: "probed",
        reason: error instanceof ProviderError ? error.message : "Provider request failed",
      });
    }
  }
  if (lastError instanceof ProviderError) throw lastError;
  throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", "No usable content model found for this account", false);
}
