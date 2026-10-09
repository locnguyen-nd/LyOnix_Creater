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
import { assessScriptPersonFocus, personTargetOf, resolveTargetPerson, type NarrationBudget, type ScriptPersonFocus, type TargetPersonInput, type TargetPersonSource } from "@lyonix/domain";
import { buildPersonRefocusText } from "./script-draft-v2.js";

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
  /** VE2E-151: the person typed on the create form (highest priority target). */
  targetPerson?: TargetPersonInput | null;
  /** VE2E-151: headline + excerpt of the selected news (a model person named there is the `news` target). */
  newsText?: string | null;
};

/** VE2E-50: why the draft's `visualPlan` is (not) there, and whether the structured-output schema was rejected. */
export type ScriptGenerationDiagnostics = {
  visualPlan: VisualPlanParseDiagnostics;
  /** Set when the provider rejected the strict schema and the call was repeated without it (short provider message). */
  schemaRejection: string | null;
  /** True when the first reply failed parse/validation and the repair call produced the final draft. */
  repaired: boolean;
  /**
   * Person subject only (`visualPlan.videoSubject.kind === "person"`): does the final script stay on the person? `refocused` = the first
   * draft drifted and ONE rewrite was requested (kept only when it is valid and at least as focused).
   */
  personFocus?: ScriptPersonFocus & { name: string; refocused: boolean; source: TargetPersonSource };
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

  // The target person by precedence (user > selected news > model) is written into videoSubject, so every later step sees the same person.
  const lockTarget = (value: ScriptDraftV2): ScriptDraftV2 => lockTargetPerson(value, input.targetPerson ?? null, input.newsText ?? null);
  draft = lockTarget(draft);
  // Person subject: a draft that drifts off the person (hook without the name, other people dominating) gets ONE rewrite.
  let personFocus: ScriptGenerationDiagnostics["personFocus"];
  const resolved = resolveTargetPerson({ user: input.targetPerson ?? null, newsText: input.newsText ?? null, model: draft.visualPlan?.videoSubject });
  const person = personTargetOf(resolved);
  if (person) {
    let focus = assessScriptPersonFocus(person, draft);
    let refocused = false;
    if (!focus.ok && personRefocusEnabled()) {
      try {
        const reply = await generateContentStructuredV2<unknown>(kind, apiKey, resolvedModelId, buildPersonRefocusText(pkg, person, focus.reasons), SCRIPT_DRAFT_V2_JSON_SCHEMA);
        const parsed = parseScriptDraftV2WithDiagnostics(reply.output, pkg.language);
        const rewritten = parsed.draft ? lockTarget(parsed.draft) : null;
        // An explicit user target stays the target of the rewrite whatever the model answered; otherwise the rewrite's own person.
        const rewrittenPerson = input.targetPerson ? person : (personTargetOf(resolveTargetPerson({ newsText: input.newsText ?? null, model: rewritten?.visualPlan?.videoSubject })) ?? person);
        const rewrittenFocus = rewritten && validateScriptDraftV2(rewritten).ok ? assessScriptPersonFocus(rewrittenPerson, rewritten) : null;
        if (rewritten && rewrittenFocus && (rewrittenFocus.ok || rewrittenFocus.coverage >= focus.coverage)) {
          draft = rewritten;
          planDiagnostics = parsed.visualPlan;
          usage = reply.usage;
          focus = rewrittenFocus;
          refocused = true;
        }
      } catch {
        // The rewrite is best effort: the first valid draft stays and the quality gate reports the drift.
      }
    }
    personFocus = { ...focus, name: person.name, refocused, source: person.source };
  }
  return { draft, usage, modelId: resolvedModelId, promptTemplateVersion: pkg.promptTemplateVersion, diagnostics: { visualPlan: planDiagnostics, schemaRejection, repaired, ...(personFocus ? { personFocus } : {}) } };
}

/**
 * VE2E-151: writes the resolved target person (user > news > model) into `visualPlan.videoSubject`. A draft without a visualPlan is
 * returned unchanged (the media plan then binds the user's person through its own subject override).
 */
export function lockTargetPerson(draft: ScriptDraftV2, user: TargetPersonInput | null, newsText: string | null): ScriptDraftV2 {
  if (!draft.visualPlan) return draft;
  const resolved = resolveTargetPerson({ user, newsText, model: draft.visualPlan.videoSubject });
  if (!resolved) return draft;
  return { ...draft, visualPlan: { ...draft.visualPlan, videoSubject: resolved } };
}

/** `SCRIPT_PERSON_REFOCUS=0` turns the one-rewrite pass off (the drift is then only reported). */
const personRefocusEnabled = (): boolean => !/^(0|false|off)$/i.test(process.env.SCRIPT_PERSON_REFOCUS?.trim() ?? "");
