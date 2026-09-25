import {
  SCRIPT_DRAFT_SCHEMA_VERSION,
  SCRIPT_PROMPT_TEMPLATE_VERSION,
  buildScriptPromptPackage,
  isContentLanguage,
  parseScriptDraftV1,
  type ContentLanguage,
  type ScriptDraftV1,
} from "@lyonix/providers";

export type ScriptScene = ScriptDraftV1["scenes"][number];
export type ScriptDraft = ScriptDraftV1 & {
  version: number;
  approvedVersion: number | null;
};

export const emptyScript = (topic: string, language: string = "vi"): ScriptDraft => {
  const locale: ContentLanguage = isContentLanguage(language) ? language : "vi";
  const parsed = parseScriptDraftV1({
    schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
    language: locale,
    title: topic,
    hook: topic,
    body: topic,
    cta: "",
    caption: topic,
    scenes: [{ sceneId: "s01", narration: "", screenText: topic, visualBrief: "", estimatedDurationMs: 5000 }],
  }, locale);
  return { ...(parsed ?? {
    schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
    language: locale,
    title: topic,
    hook: topic,
    body: topic,
    cta: "",
    caption: topic,
    scenes: [{ sceneId: "s01", narration: "", screenText: topic, visualBrief: "", estimatedDurationMs: 5000 }],
  }), version: 1, approvedVersion: null };
};

export const parseScriptDraft = (value: unknown, version: number, approvedVersion: number | null = null, language: string = "vi"): ScriptDraft | null => {
  const parsed = parseScriptDraftV1(value, isContentLanguage(language) ? language : "vi");
  if (!parsed) return null;
  return { ...parsed, version, approvedVersion };
};

export const scriptPrompt = (input: { topic: string; language: string; direction: string; promptSpec?: string; existing?: ScriptDraft | null }) =>
  buildScriptPromptPackage({
    topic: input.topic,
    language: input.language,
    direction: input.direction,
    ...(input.promptSpec ? { promptSpec: input.promptSpec } : {}),
    ...(input.existing ? { existing: input.existing } : {}),
  }).text;

export { SCRIPT_DRAFT_SCHEMA_VERSION, SCRIPT_PROMPT_TEMPLATE_VERSION, buildScriptPromptPackage };
