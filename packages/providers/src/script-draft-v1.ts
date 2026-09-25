export const SCRIPT_DRAFT_SCHEMA_VERSION = "script-draft.v1" as const;
export const SCRIPT_PROMPT_TEMPLATE_VERSION = "script-prompt.v1" as const;

export const contentLanguages = ["vi", "en", "ja", "ko"] as const;
export type ContentLanguage = (typeof contentLanguages)[number];

export type ScriptDraftSceneV1 = {
  sceneId: string;
  narration: string;
  screenText: string;
  visualBrief: string;
  estimatedDurationMs: number;
};

export type ScriptDraftV1 = {
  schemaVersion: typeof SCRIPT_DRAFT_SCHEMA_VERSION;
  language: ContentLanguage;
  title: string;
  hook: string;
  body: string;
  cta: string;
  caption: string;
  scenes: ScriptDraftSceneV1[];
};

export type ScriptDraftWorkflow = ScriptDraftV1 & {
  version: number;
  approvedVersion: number | null;
};

export const SCRIPT_DRAFT_V1_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "language", "title", "hook", "body", "cta", "caption", "scenes"],
  properties: {
    schemaVersion: { type: "string", enum: [SCRIPT_DRAFT_SCHEMA_VERSION] },
    language: { type: "string", enum: [...contentLanguages] },
    title: { type: "string" },
    hook: { type: "string" },
    body: { type: "string" },
    cta: { type: "string" },
    caption: { type: "string" },
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: 14,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sceneId", "narration", "screenText", "visualBrief", "estimatedDurationMs"],
        properties: {
          sceneId: { type: "string" },
          narration: { type: "string" },
          screenText: { type: "string" },
          visualBrief: { type: "string" },
          estimatedDurationMs: { type: "integer", minimum: 1000, maximum: 15000 },
        },
      },
    },
  },
} as Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export const isContentLanguage = (value: string): value is ContentLanguage =>
  (contentLanguages as readonly string[]).includes(value);

export function extractJsonObject(value: unknown): unknown {
  if (value !== null && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

const sceneDuration = (value: unknown, fallback: number) => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1000) return fallback;
  return Math.min(15000, Math.round(n));
};

export function parseScriptDraftV1(value: unknown, language: ContentLanguage): ScriptDraftV1 | null {
  const root = asRecord(extractJsonObject(value));
  if (!root) return null;
  const nested = asRecord(root.script) ?? root;
  const scenesRaw = Array.isArray(nested.scenes) ? nested.scenes : [];
  const scenes = scenesRaw.map((item, index) => {
    const row = asRecord(item) ?? {};
    return {
      sceneId: text(row.sceneId) || `s${String(index + 1).padStart(2, "0")}`,
      narration: text(row.narration),
      screenText: text(row.screenText),
      visualBrief: text(row.visualBrief),
      estimatedDurationMs: sceneDuration(row.estimatedDurationMs, 5000),
    };
  }).filter((scene) => scene.narration || scene.screenText || scene.visualBrief);
  const title = text(nested.title) || text(nested.hook);
  if (!title && scenes.length === 0) return null;
  const seen = new Set<string>();
  const uniqueScenes = scenes.map((scene, index) => {
    let sceneId = scene.sceneId;
    if (seen.has(sceneId)) sceneId = `${sceneId}-${index + 1}`;
    seen.add(sceneId);
    return { ...scene, sceneId };
  });
  const body = text(nested.body) || uniqueScenes.map((scene) => scene.narration).filter(Boolean).join(" ");
  return {
    schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
    language: isContentLanguage(text(nested.language)) ? nested.language as ContentLanguage : language,
    title: title || "Kịch bản",
    hook: text(nested.hook) || title,
    body,
    cta: text(nested.cta),
    caption: text(nested.caption),
    scenes: uniqueScenes.length ? uniqueScenes : [{
      sceneId: "s01",
      narration: body,
      screenText: title || body,
      visualBrief: "",
      estimatedDurationMs: 5000,
    }],
  };
}

export function validateScriptDraftV1(draft: ScriptDraftV1): { ok: true } | { ok: false; reason: "schema" | "duration" } {
  if (draft.schemaVersion !== SCRIPT_DRAFT_SCHEMA_VERSION) return { ok: false, reason: "schema" };
  if (!isContentLanguage(draft.language)) return { ok: false, reason: "schema" };
  if (!draft.title || !draft.hook || !draft.body || !draft.cta || !draft.caption) return { ok: false, reason: "schema" };
  if (draft.scenes.length < 1) return { ok: false, reason: "schema" };
  const ids = new Set(draft.scenes.map((scene) => scene.sceneId));
  if (ids.size !== draft.scenes.length) return { ok: false, reason: "schema" };
  const total = draft.scenes.reduce((sum, scene) => sum + scene.estimatedDurationMs, 0);
  if (total < 30_000 || total > 90_000) return { ok: false, reason: "duration" };
  return { ok: true };
}

export type ScriptPromptPackage = {
  promptTemplateVersion: typeof SCRIPT_PROMPT_TEMPLATE_VERSION;
  schemaVersion: typeof SCRIPT_DRAFT_SCHEMA_VERSION;
  language: ContentLanguage;
  topic: string;
  promptSpec: string;
  direction: string;
  text: string;
  repairText: string;
};

const languageName: Record<ContentLanguage, string> = {
  vi: "Vietnamese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
};

export const clipForPrompt = (value: string, max = 4000) => {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…[truncated ${trimmed.length - max} chars]`;
};

export function buildScriptPromptPackage(input: {
  topic: string;
  language: string;
  direction?: string;
  promptSpec?: string;
  existing?: Pick<ScriptDraftV1, "title" | "hook" | "body" | "cta" | "caption" | "scenes"> | null;
}): ScriptPromptPackage {
  const language: ContentLanguage = isContentLanguage(input.language) ? input.language : "vi";
  const promptSpec = clipForPrompt(input.promptSpec?.trim() ?? "", 6000);
  const direction = clipForPrompt(input.direction?.trim() || promptSpec || "Create a new 55-65s TikTok script from the topic/source.", 1500);
  const topic = clipForPrompt(input.topic, 240);
  const hasRealScenes = Boolean(input.existing?.scenes.some((scene) => scene.narration) && (input.existing?.scenes.length ?? 0) > 1);
  const current = hasRealScenes && input.existing
    ? `\nCurrent ScriptDraftV1 JSON:\n${clipForPrompt(JSON.stringify({
      schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
      language,
      title: input.existing.title,
      hook: input.existing.hook,
      body: input.existing.body,
      cta: input.existing.cta,
      caption: input.existing.caption,
      scenes: input.existing.scenes,
    }), 6000)}`
    : promptSpec
      ? `\nSource transcript/notes to rewrite into a short-form script (do not paste verbatim as one scene):\n${promptSpec}`
      : "";
  const text = `You are LyOnix. Return one JSON object that matches schema ${SCRIPT_DRAFT_SCHEMA_VERSION}.
Prompt template: ${SCRIPT_PROMPT_TEMPLATE_VERSION}
Spoken short-form TikTok script in ${languageName[language]}.
Topic: ${topic}
Channel/content spec: ${promptSpec || "(none)"}
Creative direction / requested changes: ${direction}
Target spoken length: 55-65 seconds. 10-14 scenes. Total estimatedDurationMs between 30000 and 90000.
Required keys: schemaVersion, language, title, hook, body, cta, caption, scenes.
Each scene: sceneId, narration (spoken), screenText (on-screen, no HTML/URLs), visualBrief, estimatedDurationMs.
body must be the full spoken narration concatenating scene narration in order.
Rewrite long source transcripts into a tight 55-65s script; do not return the raw source unchanged.
Do not invent music beds or Vrew render steps. Do not wrap JSON in markdown.${current}`;
  const repairText = `${text}

The previous reply was not valid ${SCRIPT_DRAFT_SCHEMA_VERSION}. Repair it: output a single JSON object only, with unique sceneId values and 30-90s total duration.`;
  return {
    promptTemplateVersion: SCRIPT_PROMPT_TEMPLATE_VERSION,
    schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
    language,
    topic: input.topic,
    promptSpec,
    direction,
    text,
    repairText,
  };
}
