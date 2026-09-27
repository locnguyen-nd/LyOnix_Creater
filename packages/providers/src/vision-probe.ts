/**
 * VE2E-24 exact-capability probe for vision moderation - mirrors `content-probe.ts`'s pattern
 * exactly: a model catalog entry (or the fact a provider "supports images" in general marketing
 * copy) is not proof this specific account/model/operation accepts the intended input type and
 * returns the required structured fields. This must be a real, minimal, bounded call against the
 * exact endpoint used for real moderation (`generateVisionStructuredOnce`), never a static
 * assumption. No Jev/TypeSafe anywhere in this file or its callers (owner decision VE2E-16).
 */
import { ProviderError, type JsonSchema } from "./index.js";
import { normalizeModelId } from "./content-models.js";
import { generateVisionStructuredOnce, type LiveContentKind } from "./live-content.js";

export const visionInputKinds = ["image", "video_frame"] as const;
export type VisionInputKind = (typeof visionInputKinds)[number];

export type VisionCapabilityProbeResult = { modelId: string; inputKind: VisionInputKind; verifiedAt: string };

const VISION_PROBE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};
const VISION_PROBE_PROMPT = 'Look at the attached image. Reply with exactly one JSON object: {"ok":true}. No other text, no markdown.';

/**
 * Smallest possible valid PNG (1x1 transparent pixel), inlined so the probe never needs its own
 * network fetch of a sample image (which would itself be an extra, unbounded dependency). This
 * is not a real scene frame - it only proves the account/model *accepts an image input and
 * returns the requested structured JSON*, the same "usable-on-generate" principle `content-probe.ts`
 * already established for text.
 */
const PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * `inputKind` is recorded but does not change the actual probe call - a sampled video frame is
 * always sent as a still image (never raw video bytes, see `VisionInputPart`), so the exact same
 * request shape proves capability for both `"image"` and `"video_frame"` moderation. Kept as an
 * explicit parameter (not inferred) so the caller's *intent* is recorded in the evidence, not
 * just the call shape.
 */
export async function probeVisionCapability(kind: LiveContentKind, apiKey: string, modelId: string, inputKind: VisionInputKind = "image"): Promise<VisionCapabilityProbeResult> {
  await generateVisionStructuredOnce<{ ok?: boolean }>(kind, apiKey, modelId, VISION_PROBE_PROMPT, [{ mimeType: "image/png", base64: PROBE_IMAGE_BASE64 }], VISION_PROBE_SCHEMA);
  return { modelId: normalizeModelId(modelId), inputKind, verifiedAt: new Date().toISOString() };
}

/** Fail-closed helper: never throws, always resolves to a definite yes/no + evidence, so a caller can route straight to `manual_review` on `ok: false` instead of propagating an exception. */
export async function tryProbeVisionCapability(kind: LiveContentKind, apiKey: string, modelId: string, inputKind: VisionInputKind = "image"): Promise<{ ok: true; result: VisionCapabilityProbeResult } | { ok: false; error: ProviderError }> {
  try {
    return { ok: true, result: await probeVisionCapability(kind, apiKey, modelId, inputKind) };
  } catch (error) {
    return { ok: false, error: error instanceof ProviderError ? error : new ProviderError("PROVIDER_UNAVAILABLE", "Vision capability probe failed", true) };
  }
}
