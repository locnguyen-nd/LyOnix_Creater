import { discoveredContentModels } from "./content-models.js";

/**
 * VE2E-79: pure classification of OpenRouter's `GET /models` payload.
 *
 * OpenRouter is a single key that fronts many upstream vendors, so one account's listing mixes
 * text, image-in and audio/other models with different capabilities. LyOnix routes three
 * operations through it: script + keyword generation (needs text output *and* structured output)
 * and image/frame moderation (needs image input). This splits the live listing into the three
 * usable sets so the account adapter (VE2E-80) can offer the right models per role.
 *
 * The filter is account-scoped discovery only (V00-10): it never unions with the static curated
 * catalog, and - like the Gemini `supportedGenerationMethods` posture in live-content.ts - it is
 * lenient when a capability field is absent (a model is excluded only when a field is present and
 * explicitly excludes the capability), because not every upstream reports every field and the real
 * generate/probe call is still the source of truth.
 */
export type OpenRouterRawModel = Record<string, unknown>;

export type OpenRouterModelCapabilities = {
  /** Models whose output includes text (the superset usable for any LyOnix content role). */
  text: string[];
  /** Text models that also advertise structured output (`structured_outputs`/`response_format`) - for script + keyword generation. */
  structured: string[];
  /** Models that accept image input - for vision moderation of images and sampled video frames. */
  vision: string[];
};

const architecture = (model: OpenRouterRawModel): Record<string, unknown> => {
  const arch = model.architecture;
  return arch && typeof arch === "object" ? (arch as Record<string, unknown>) : {};
};

/** Reads an explicit modality array, else derives it from the `"in+in->out"` modality string. `side` 0 = input, 1 = output. */
const modalities = (model: OpenRouterRawModel, field: "input_modalities" | "output_modalities", side: 0 | 1): string[] => {
  const arch = architecture(model);
  const explicit = arch[field];
  if (Array.isArray(explicit)) return explicit.map((item) => String(item).toLowerCase());
  const modality = typeof arch.modality === "string" ? arch.modality : "";
  if (!modality) return [];
  const parts = modality.includes("->") ? modality.split("->") : [modality, modality];
  return (parts[side] ?? "").split("+").map((item) => item.trim().toLowerCase()).filter(Boolean);
};

const outputsText = (model: OpenRouterRawModel): boolean => {
  const out = modalities(model, "output_modalities", 1);
  return out.length === 0 || out.includes("text");
};

const acceptsImage = (model: OpenRouterRawModel): boolean => modalities(model, "input_modalities", 0).includes("image");

const supportsStructuredOutput = (model: OpenRouterRawModel): boolean => {
  const params = model.supported_parameters;
  if (!Array.isArray(params)) return true; // lenient: absent field is not a denial
  const names = params.map((item) => String(item).toLowerCase());
  return names.includes("structured_outputs") || names.includes("response_format");
};

export const classifyOpenRouterModels = (models: readonly unknown[]): OpenRouterModelCapabilities => {
  const text: string[] = [];
  const structured: string[] = [];
  const vision: string[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const model = entry as OpenRouterRawModel;
    const id = String(model.id ?? model.canonical_slug ?? "");
    if (!id || !outputsText(model)) continue;
    text.push(id);
    if (supportsStructuredOutput(model)) structured.push(id);
    if (acceptsImage(model)) vision.push(id);
  }
  // discoveredContentModels applies the shared text-model SKIP filter + dedupe + normalize (V00-10).
  return {
    text: discoveredContentModels("openrouter", text),
    structured: discoveredContentModels("openrouter", structured),
    vision: discoveredContentModels("openrouter", vision),
  };
};
