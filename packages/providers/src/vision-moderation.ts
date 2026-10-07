/**
 * VE2E-24 real, bounded vision moderation call. Separate from `vision-probe.ts` (capability
 * verification) - this file makes the actual per-candidate moderation request once capability is
 * already confirmed. Frame count and per-frame size are hard-bounded here regardless of what a
 * caller passes in (spec §5.1: "bound media egress, file size, frame count"). Never logs raw
 * frames or prompts - only the parsed structured fields and a provider request id are returned.
 */
import { ProviderError, type JsonSchema } from "./index.js";
import { generateVisionStructuredOnce, type LiveContentKind } from "./live-content.js";
import { CONTENT_MODEL_FRESHNESS_TTL_MS, isFreshCheckedAt } from "./content-probe.js";
import { probeVisionCapability, type VisionInputKind } from "./vision-probe.js";

export type VisionModerationOperation = "image_moderation" | "video_frame_moderation";

export type VisionModerationSceneContext = {
  beat: string;
  entities: readonly string[];
  action: readonly string[];
  setting: readonly string[];
  mood: readonly string[];
  exclusions: readonly string[];
};

/** One sampled frame (already extracted/encoded by the caller - this adapter never touches raw video bytes or runs FFmpeg; frame extraction happens outside this package, per repo convention that FFmpeg only runs in `apps/media-worker`). */
export type VisionModerationFrame = { mimeType: string; base64: string; timestampMs?: number };

export type VisionModerationCallInput = {
  kind: LiveContentKind;
  apiKey: string;
  modelId: string;
  operation: VisionModerationOperation;
  sceneContext: VisionModerationSceneContext;
  frames: readonly VisionModerationFrame[];
};

export type VisionModerationRawResult = {
  safetyFlag: boolean;
  safetyCategories: string[];
  sceneBeatRelevance: number;
  confidence: number;
  notes: string;
};

/** Documented, bounded sampling policy: at most this many frames are ever sent for one video moderation call - a fixed, auditable ceiling, not a silently-varying per-call amount. */
export const MAX_MODERATION_FRAMES = 6;
/** ~2.2MB decoded per frame (base64 is ~1.37x binary size) - generous headroom over a compressed keyframe, bounds worst-case request egress per call. */
const MAX_FRAME_BASE64_LENGTH = 3_000_000;

/** VE2E-131: hard per-call deadline for vision (probe and moderation each). A timeout is a normal "vision unavailable" outcome, never a failed run. */
export const VISION_CALL_TIMEOUT_MS = 8_000;
/** VE2E-131: cover images judged in ONE request (4-6; the adapter clamps to this range). */
export const VISION_BATCH_MIN = 4;
export const VISION_BATCH_MAX = 6;

const withDeadline = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError("PROVIDER_TIMEOUT", `Vision call exceeded ${ms} ms`, true)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const MODERATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["safety_flag", "safety_categories", "scene_beat_relevance", "confidence", "notes"],
  properties: {
    safety_flag: { type: "boolean" },
    safety_categories: { type: "array", items: { type: "string" } },
    scene_beat_relevance: { type: "number" },
    confidence: { type: "number" },
    notes: { type: "string" },
  },
};

const buildPrompt = (operation: VisionModerationOperation, ctx: VisionModerationSceneContext, frameCount: number, timestamps: readonly number[]): string => {
  const lines = [
    "You are a content-safety and scene-fit classifier for a short-form video clip candidate.",
    operation === "video_frame_moderation"
      ? `You are shown ${frameCount} sampled frame(s) from one video clip at timestamps (ms): ${timestamps.join(", ")}.`
      : "You are shown one still image.",
    `Narrative beat: ${ctx.beat}.`,
    ctx.entities.length ? `Expected entities/subjects: ${ctx.entities.join(", ")}.` : "",
    ctx.action.length ? `Expected action: ${ctx.action.join(", ")}.` : "",
    ctx.setting.length ? `Expected setting: ${ctx.setting.join(", ")}.` : "",
    ctx.mood.length ? `Expected mood: ${ctx.mood.join(", ")}.` : "",
    ctx.exclusions.length ? `Must NOT show: ${ctx.exclusions.join(", ")}.` : "",
    "Evaluate two SEPARATE things: (1) safety - does the content contain disallowed material (explicit violence, sexual content, hate symbols, self-harm, or anything unsafe for a general short-video audience)? (2) scene_beat_relevance - a 0..1 score for how well the VISIBLE action/setting supports the stated narrative beat and expected entities/action/setting/mood, independent of safety.",
    "Reply with exactly one JSON object matching the schema: safety_flag (true only if genuinely unsafe/disallowed), safety_categories (short reason codes, empty array if safe), scene_beat_relevance (0..1), confidence (0..1, your confidence in this whole assessment), notes (one short sentence, no personal data). No other text, no markdown.",
  ];
  return lines.filter(Boolean).join(" ");
};

const isFiniteInRange01 = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

const parseRaw = (output: unknown): VisionModerationRawResult | null => {
  if (!output || typeof output !== "object") return null;
  const row = output as Record<string, unknown>;
  if (typeof row.safety_flag !== "boolean") return null;
  if (!Array.isArray(row.safety_categories) || !row.safety_categories.every((c) => typeof c === "string")) return null;
  if (!isFiniteInRange01(row.scene_beat_relevance)) return null;
  if (!isFiniteInRange01(row.confidence)) return null;
  if (typeof row.notes !== "string") return null;
  return {
    safetyFlag: row.safety_flag,
    safetyCategories: row.safety_categories as string[],
    sceneBeatRelevance: row.scene_beat_relevance as number,
    confidence: row.confidence as number,
    notes: row.notes,
  };
};

export type VisionModerationCallResult = {
  raw: VisionModerationRawResult;
  requestId: string | null;
  sampledFrameCount: number;
  sampledTimestampsMs: number[];
};

/**
 * Makes the real, bounded moderation call. Throws `PROVIDER_SCHEMA_INVALID` on a malformed/
 * out-of-range response (caller must route that to `manual_review`, never accept it) and
 * `PROVIDER_CAPABILITY_UNAVAILABLE` when given zero usable frames - both fail closed, never an
 * implicit accept.
 */
export async function moderateMediaWithVision(input: VisionModerationCallInput): Promise<VisionModerationCallResult> {
  if (input.frames.length === 0) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", "No media sample provided for vision moderation", false);
  const bounded = input.frames.slice(0, MAX_MODERATION_FRAMES).filter((f) => f.base64.length > 0 && f.base64.length <= MAX_FRAME_BASE64_LENGTH);
  if (bounded.length === 0) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Every provided frame was empty or exceeded the bounded egress size", false);
  const timestamps = bounded.map((f) => f.timestampMs ?? 0);
  const prompt = buildPrompt(input.operation, input.sceneContext, bounded.length, timestamps);
  const result = await generateVisionStructuredOnce<unknown>(input.kind, input.apiKey, input.modelId, prompt, bounded.map((f) => ({ mimeType: f.mimeType, base64: f.base64 })), MODERATION_SCHEMA);
  const raw = parseRaw(result.output);
  if (!raw) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Vision moderation response did not match the required structured fields", false);
  return { raw, requestId: result.usage.providerRequestId, sampledFrameCount: bounded.length, sampledTimestampsMs: timestamps };
}

// --- orchestration: capability-checked, always-fail-closed entry point ---

export type SceneModerationInput = {
  kind: LiveContentKind;
  apiKey: string;
  modelId: string;
  operation: VisionModerationOperation;
  sceneContext: VisionModerationSceneContext;
  frames: readonly VisionModerationFrame[];
  /** Last known real capability-probe evidence for this exact account/model/inputKind, if any (e.g. persisted on a provider account row, mirroring `ContentModelSnapshotEntry`). `null`/stale forces a fresh `probeVisionCapability` call before the real moderation call - never trusts a catalog entry alone (spec §5.1). */
  capabilityEvidence?: { verifiedAt: string } | null;
  freshnessTtlMs?: number;
  /** Per-call deadline (probe and moderation), default {@link VISION_CALL_TIMEOUT_MS}. */
  timeoutMs?: number;
};

/**
 * `raw: null` here always means "route to `manual_review`/`needs_input`, never implicit
 * acceptance" once passed into `decideVisionModeration` - covers a failed/stale capability probe,
 * a provider error/timeout on the real moderation call, and a malformed response, uniformly.
 * `evidenceRefs` never contains a raw frame or prompt (spec §5.1 telemetry rule) - only the
 * provider request id and sampled frame timestamps.
 */
export type SceneModerationOutcome = {
  raw: VisionModerationRawResult | null;
  capabilityVerifiedAt: string | null;
  evidenceRefs: string[];
  failureCode?: ProviderError["code"];
  retryAfterMs?: number;
  quotaScope?: ProviderError["quotaScope"];
};

const failureOf = (error: unknown) => error instanceof ProviderError
  ? { failureCode: error.code, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}), ...(error.quotaScope ? { quotaScope: error.quotaScope } : {}) }
  : {};

/**
 * Single entry point a caller (e.g. a future apps/api moderation service) should use instead of
 * composing `probeVisionCapability`/`moderateMediaWithVision` itself: rechecks capability when
 * evidence is missing/stale (`isFreshCheckedAt`, same TTL/freshness pattern already established
 * for content-provider models in `content-probe.ts`), then makes the real bounded moderation
 * call, and NEVER throws - every failure mode (unsupported capability, provider error/timeout,
 * malformed response) resolves to `{ raw: null, ... }` so the caller can feed the result straight
 * into `decideVisionModeration` without its own try/catch.
 */
export async function moderateSceneCandidate(input: SceneModerationInput): Promise<SceneModerationOutcome> {
  const inputKind: VisionInputKind = input.operation === "video_frame_moderation" ? "video_frame" : "image";
  let capabilityVerifiedAt = isFreshCheckedAt(input.capabilityEvidence?.verifiedAt, input.freshnessTtlMs ?? CONTENT_MODEL_FRESHNESS_TTL_MS)
    ? (input.capabilityEvidence?.verifiedAt ?? null)
    : null;
  if (!capabilityVerifiedAt) {
    try {
      const probed = await withDeadline(probeVisionCapability(input.kind, input.apiKey, input.modelId, inputKind), input.timeoutMs ?? VISION_CALL_TIMEOUT_MS);
      capabilityVerifiedAt = probed.verifiedAt;
    } catch (error) {
      return { raw: null, capabilityVerifiedAt: null, evidenceRefs: [], ...failureOf(error) };
    }
  }
  try {
    const result = await withDeadline(moderateMediaWithVision({ kind: input.kind, apiKey: input.apiKey, modelId: input.modelId, operation: input.operation, sceneContext: input.sceneContext, frames: input.frames }), input.timeoutMs ?? VISION_CALL_TIMEOUT_MS);
    const evidenceRefs = [...(result.requestId ? [`request:${result.requestId}`] : []), ...result.sampledTimestampsMs.map((ms) => `frame_ts_ms:${ms}`)];
    return { raw: result.raw, capabilityVerifiedAt, evidenceRefs };
  } catch (error) {
    return { raw: null, capabilityVerifiedAt, evidenceRefs: [], ...failureOf(error) };
  }
}

// --- VE2E-131: several cover images, ONE request ---------------------------------------------------------------

const BATCH_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "safety_flag", "safety_categories", "scene_beat_relevance", "confidence", "notes"],
        properties: {
          index: { type: "number" },
          safety_flag: { type: "boolean" },
          safety_categories: { type: "array", items: { type: "string" } },
          scene_beat_relevance: { type: "number" },
          confidence: { type: "number" },
          notes: { type: "string" },
        },
      },
    },
  },
};

const buildBatchPrompt = (ctx: VisionModerationSceneContext, count: number): string =>
  [
    buildPrompt("image_moderation", ctx, 1, []).replace("You are shown one still image.", `You are shown ${count} still images, numbered 1 to ${count} in the order given. Judge EACH image independently.`),
    `Reply with exactly one JSON object {"items":[...]} holding one entry per image, each with "index" (1-based image number) plus the fields above. No other text.`,
  ].join(" ");

export type SceneBatchInput = Omit<SceneModerationInput, "frames" | "operation"> & {
  /** One cover frame per candidate; the adapter keeps at most {@link VISION_BATCH_MAX}. */
  items: ReadonlyArray<{ id: string; frame: VisionModerationFrame }>;
};

export type SceneBatchOutcome = {
  /** Candidate id -> verdict; ids missing from the model's answer are absent (caller keeps their metadata score). */
  verdicts: Map<string, VisionModerationRawResult>;
  capabilityVerifiedAt: string | null;
  evidenceRefs: string[];
  failureCode?: ProviderError["code"];
  retryAfterMs?: number;
  quotaScope?: ProviderError["quotaScope"];
};

/** Same fail-soft contract as {@link moderateSceneCandidate} (never throws, timeout 8 s), for up to 6 images in one request. */
export async function moderateSceneCandidatesBatch(input: SceneBatchInput): Promise<SceneBatchOutcome> {
  const timeoutMs = input.timeoutMs ?? VISION_CALL_TIMEOUT_MS;
  const items = input.items.filter((i) => i.frame.base64.length > 0 && i.frame.base64.length <= MAX_FRAME_BASE64_LENGTH).slice(0, VISION_BATCH_MAX);
  const empty = (extra: Partial<SceneBatchOutcome> = {}): SceneBatchOutcome => ({ verdicts: new Map(), capabilityVerifiedAt: null, evidenceRefs: [], ...extra });
  if (items.length === 0) return empty();
  let capabilityVerifiedAt = isFreshCheckedAt(input.capabilityEvidence?.verifiedAt, input.freshnessTtlMs ?? CONTENT_MODEL_FRESHNESS_TTL_MS) ? (input.capabilityEvidence?.verifiedAt ?? null) : null;
  if (!capabilityVerifiedAt) {
    try {
      capabilityVerifiedAt = (await withDeadline(probeVisionCapability(input.kind, input.apiKey, input.modelId, "image"), timeoutMs)).verifiedAt;
    } catch (error) {
      return empty(failureOf(error));
    }
  }
  try {
    const prompt = buildBatchPrompt(input.sceneContext, items.length);
    const result = await withDeadline(generateVisionStructuredOnce<unknown>(input.kind, input.apiKey, input.modelId, prompt, items.map((i) => ({ mimeType: i.frame.mimeType, base64: i.frame.base64 })), BATCH_SCHEMA), timeoutMs);
    const rows = result.output && typeof result.output === "object" ? (result.output as { items?: unknown }).items : null;
    if (!Array.isArray(rows)) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Vision batch response had no items list", false);
    const verdicts = new Map<string, VisionModerationRawResult>();
    for (const row of rows) {
      const index = row && typeof row === "object" ? Number((row as { index?: unknown }).index) : NaN;
      const target = Number.isInteger(index) ? items[index - 1] : undefined;
      const raw = parseRaw(row);
      if (target && raw && !verdicts.has(target.id)) verdicts.set(target.id, raw);
    }
    return { verdicts, capabilityVerifiedAt, evidenceRefs: result.usage.providerRequestId ? [`request:${result.usage.providerRequestId}`] : [] };
  } catch (error) {
    return empty({ capabilityVerifiedAt, ...failureOf(error) });
  }
}
