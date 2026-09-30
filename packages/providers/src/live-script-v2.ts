/**
 * VE2E-01: orchestrates `SourceVersion -> ScriptDraftV2` against a live content provider
 * (OpenAI/Gemini/xAI). Composes the pure prompt/schema/validator from `script-draft-v2.ts`
 * with the transport-level `generateContentStructuredV2` from `live-content.ts`. No fake
 * fallback: any failure surfaces as a normalized `ProviderError`.
 */
import { ProviderError, type UsageRecord } from "./index.js";
import { generateContentStructuredV2, type LiveContentKind } from "./live-content.js";
import {
  SCRIPT_DRAFT_V2_JSON_SCHEMA,
  buildScriptV2PromptPackage,
  parseScriptDraftV2WithDiagnostics,
  validateScriptDraftV2,
  type ScriptDraftV2,
  type ScriptSourceKind,
  type VisualPlanParseDiagnostics,
} from "./script-draft-v2.js";
import { normalizeModelId } from "./content-models.js";
import type { NarrationBudget } from "@lyonix/domain";

export type GenerateScriptDraftV2Input = {
  sourceType: ScriptSourceKind;
  /** SourceVersion `extractedText` (topic/raw_script) or `rawText`/`extractedText` (article/file). */
  sourceText: string;
  originRef?: string | null;
  language: string;
  direction?: string;
  /** VE2E-38/40: target background segment count for the draft's `visualPlan` (see `buildScriptV2PromptPackage`). */
  backgroundSegmentRange?: { min: number; max: number } | null;
  /** VE2E-54: narration budget (targetChars + scene range) derived from the intake target. */
  durationBudget?: NarrationBudget | null;
};

/** VE2E-50: why the draft's `visualPlan` is (not) there, and whether the structured-output schema was rejected. */
export type ScriptGenerationDiagnostics = {
  visualPlan: VisualPlanParseDiagnostics;
  /** Set when the provider rejected the strict schema and the call was repeated without it (short provider message). */
  schemaRejection: string | null;
  /** True when the first reply failed parse/validation and the repair call produced the final draft. */
  repaired: boolean;
};

export type GenerateScriptDraftV2Result = {
  draft: ScriptDraftV2;
  usage: UsageRecord;
  modelId: string;
  promptTemplateVersion: string;
  diagnostics: ScriptGenerationDiagnostics;
};

export async function generateScriptDraftV2(
  kind: LiveContentKind,
  apiKey: string,
  modelId: string,
  input: GenerateScriptDraftV2Input,
): Promise<GenerateScriptDraftV2Result> {
  const pkg = buildScriptV2PromptPackage(input);
  const resolvedModelId = normalizeModelId(modelId);
  const first = await generateContentStructuredV2<unknown>(kind, apiKey, resolvedModelId, pkg.text, SCRIPT_DRAFT_V2_JSON_SCHEMA);
  const firstParsed = parseScriptDraftV2WithDiagnostics(first.output, pkg.language);
  let draft = firstParsed.draft;
  let planDiagnostics = firstParsed.visualPlan;
  let schemaRejection = first.schemaRejection ?? null;
  let repaired = false;
  let usage = first.usage;
  if (!draft || !validateScriptDraftV2(draft).ok) {
    const repairReply = await generateContentStructuredV2<unknown>(kind, apiKey, resolvedModelId, pkg.repairText, SCRIPT_DRAFT_V2_JSON_SCHEMA);
    const repairedParsed = parseScriptDraftV2WithDiagnostics(repairReply.output, pkg.language);
    const repairedDraft = repairedParsed.draft;
    if (repairedDraft && validateScriptDraftV2(repairedDraft).ok) {
      draft = repairedDraft;
      planDiagnostics = repairedParsed.visualPlan;
      schemaRejection = repairReply.schemaRejection ?? schemaRejection;
      repaired = true;
      usage = repairReply.usage;
    }
  }
  if (!draft) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "Provider did not return a ScriptDraftV2-shaped JSON object", false);
  const validation = validateScriptDraftV2(draft);
  if (!validation.ok) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `ScriptDraftV2 failed semantic validation: ${validation.reason}`, false);
  return { draft, usage, modelId: resolvedModelId, promptTemplateVersion: pkg.promptTemplateVersion, diagnostics: { visualPlan: planDiagnostics, schemaRejection, repaired } };
}
