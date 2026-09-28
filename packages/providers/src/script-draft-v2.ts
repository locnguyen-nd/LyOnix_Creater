/**
 * ScriptDraftV2 (VE2E-01): structured output schema/parser/semantic validator and
 * prompt builder for `SourceVersion -> ScriptDraftV2` (topic|raw_script|article_url|file).
 * Pure logic only — no network I/O, no provider secret handling. See `live-script-v2.ts`
 * for the orchestration that calls a live content provider with this schema.
 */
import { splitIntoSentences } from "@lyonix/domain";

export const SCRIPT_DRAFT_V2_SCHEMA_VERSION = "script-draft.v2" as const;
export const SCRIPT_PROMPT_TEMPLATE_V2_VERSION = "script-prompt.v2" as const;

export const contentLanguagesV2 = ["vi", "en", "ja", "ko"] as const;
export type ContentLanguageV2 = (typeof contentLanguagesV2)[number];
export const isContentLanguageV2 = (value: string): value is ContentLanguageV2 =>
  (contentLanguagesV2 as readonly string[]).includes(value);

/** Matches `SourceType` from `@lyonix/contracts` / `packages/db` (VE2E-00). Not imported
 * directly to keep this package dependency-free; callers pass the SourceVersion's `type`. */
export const scriptSourceKinds = ["topic", "raw_script", "article_url", "file"] as const;
export type ScriptSourceKind = (typeof scriptSourceKinds)[number];
export const isScriptSourceKind = (value: string): value is ScriptSourceKind =>
  (scriptSourceKinds as readonly string[]).includes(value);

export type ScriptDraftSceneV2 = {
  sceneId: string;
  narration: string;
  screenText: string;
  /** Visual query/brief used both as media search query (Pexels, VE2E-04) and framing brief. */
  visualQuery: string;
  durationHintMs: number;
};

export type ScriptDraftV2 = {
  schemaVersion: typeof SCRIPT_DRAFT_V2_SCHEMA_VERSION;
  language: ContentLanguageV2;
  title: string;
  hook: string;
  body: string;
  cta: string;
  caption: string;
  scenes: ScriptDraftSceneV2[];
};

export const SCRIPT_DRAFT_V2_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "language", "title", "hook", "body", "cta", "caption", "scenes"],
  properties: {
    schemaVersion: { type: "string", enum: [SCRIPT_DRAFT_V2_SCHEMA_VERSION] },
    language: { type: "string", enum: [...contentLanguagesV2] },
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
        required: ["sceneId", "narration", "screenText", "visualQuery", "durationHintMs"],
        properties: {
          sceneId: { type: "string" },
          narration: { type: "string" },
          screenText: { type: "string" },
          visualQuery: { type: "string" },
          durationHintMs: { type: "integer", minimum: 1000, maximum: 15000 },
        },
      },
    },
  },
} as Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function extractJsonObjectV2(value: unknown): unknown {
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

const MIN_SPLIT_SCENE_DURATION_MS = 1000;
/** Hard ceiling on how many scenes one narration-splitting pass can ever produce, regardless of how many sentences a single scene's narration contains - a bounded, documented safety net against a pathological/garbled input producing dozens of near-empty scenes. */
const MAX_SCENES_AFTER_SPLIT = 24;

/**
 * Auto-cuts a scene whose narration packs 2+ full sentences into one visual into one scene
 * per sentence, instead of leaving a single image/video stretched across a run-on narration
 * (spec ask: "câu dài thì tự cắt cảnh" - a long/multi-sentence narration must not sit behind
 * one static visual). `durationHintMs` is redistributed proportionally by each sentence's
 * character share of the original scene's duration (never invented - always sums back to the
 * original, remainder absorbed by the last part) so total spoken length is unchanged. Every
 * split part keeps the parent's own `visualQuery` verbatim (no model call available here to
 * author a new one per sentence) - `deriveSceneBrief`/`rankMediaCandidates` (VE2E-15a) still
 * differentiate each part's actual media search because they combine `visualQuery` with that
 * part's own (now single-sentence) `narration`/`screenText`, not `visualQuery` alone. Bounded
 * by `MAX_SCENES_AFTER_SPLIT` total - once reached, a scene's remaining sentences merge back
 * into its last split part rather than growing the scene count further.
 */
const expandOverlongScenes = (scenes: readonly ScriptDraftSceneV2[]): ScriptDraftSceneV2[] => {
  const expanded: ScriptDraftSceneV2[] = [];
  let remainingBudget = MAX_SCENES_AFTER_SPLIT - scenes.length;
  for (const scene of scenes) {
    const sentences = splitIntoSentences(scene.narration);
    if (sentences.length < 2 || remainingBudget <= 0) {
      expanded.push(scene);
      continue;
    }
    const partCount = Math.min(sentences.length, remainingBudget + 1);
    remainingBudget -= partCount - 1;
    const parts = partCount < sentences.length
      ? [...sentences.slice(0, partCount - 1), sentences.slice(partCount - 1).join(" ")]
      : sentences;
    const screenParts = splitIntoSentences(scene.screenText);
    const totalChars = parts.reduce((sum, part) => sum + part.length, 0) || 1;
    let remainingMs = scene.durationHintMs;
    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1;
      const share = isLast ? remainingMs : Math.max(MIN_SPLIT_SCENE_DURATION_MS, Math.round((part.length / totalChars) * scene.durationHintMs));
      remainingMs -= isLast ? 0 : share;
      expanded.push({
        sceneId: `${scene.sceneId}-${index + 1}`,
        narration: part,
        screenText: screenParts[index] || part,
        visualQuery: scene.visualQuery,
        durationHintMs: Math.max(MIN_SPLIT_SCENE_DURATION_MS, share),
      });
    });
  }
  return expanded;
};

export function parseScriptDraftV2(value: unknown, language: ContentLanguageV2): ScriptDraftV2 | null {
  const root = asRecord(extractJsonObjectV2(value));
  if (!root) return null;
  const nested = asRecord(root.script) ?? root;
  const scenesRaw = Array.isArray(nested.scenes) ? nested.scenes : [];
  const scenes = scenesRaw
    .map((item, index) => {
      const row = asRecord(item) ?? {};
      return {
        sceneId: text(row.sceneId) || `s${String(index + 1).padStart(2, "0")}`,
        narration: text(row.narration),
        screenText: text(row.screenText),
        visualQuery: text(row.visualQuery) || text(row.visualBrief),
        durationHintMs: sceneDuration(row.durationHintMs ?? row.estimatedDurationMs, 5000),
      };
    })
    .filter((scene) => scene.narration || scene.screenText || scene.visualQuery);
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
  // Split any scene whose narration packs 2+ full sentences into one scene per sentence - see
  // `expandOverlongScenes`'s own doc comment. Runs after sceneId dedup so every split id (derived
  // from an already-unique parent id) is guaranteed unique too, and after `body` is computed so a
  // split never changes the full spoken transcript, only how it's carved into scenes.
  const finalScenes = expandOverlongScenes(uniqueScenes);
  return {
    schemaVersion: SCRIPT_DRAFT_V2_SCHEMA_VERSION,
    language: isContentLanguageV2(text(nested.language)) ? (nested.language as ContentLanguageV2) : language,
    title: title || "Kịch bản",
    hook: text(nested.hook) || title,
    body,
    cta: text(nested.cta),
    caption: text(nested.caption),
    scenes: finalScenes.length
      ? finalScenes
      : [{ sceneId: "s01", narration: body, screenText: title || body, visualQuery: title || body, durationHintMs: 5000 }],
  };
}

export type ScriptDraftV2ValidationFailure = { ok: false; reason: "schema" | "duration" | "visual_query" };
export function validateScriptDraftV2(draft: ScriptDraftV2): { ok: true } | ScriptDraftV2ValidationFailure {
  if (draft.schemaVersion !== SCRIPT_DRAFT_V2_SCHEMA_VERSION) return { ok: false, reason: "schema" };
  if (!isContentLanguageV2(draft.language)) return { ok: false, reason: "schema" };
  if (!draft.title || !draft.hook || !draft.body || !draft.cta || !draft.caption) return { ok: false, reason: "schema" };
  if (draft.scenes.length < 1) return { ok: false, reason: "schema" };
  const ids = new Set(draft.scenes.map((scene) => scene.sceneId));
  if (ids.size !== draft.scenes.length) return { ok: false, reason: "schema" };
  if (draft.scenes.some((scene) => !scene.narration || !scene.screenText)) return { ok: false, reason: "schema" };
  if (draft.scenes.some((scene) => !scene.visualQuery)) return { ok: false, reason: "visual_query" };
  const total = draft.scenes.reduce((sum, scene) => sum + scene.durationHintMs, 0);
  if (total < 30_000 || total > 90_000) return { ok: false, reason: "duration" };
  return { ok: true };
}

export type ScriptPromptPackageV2 = {
  promptTemplateVersion: typeof SCRIPT_PROMPT_TEMPLATE_V2_VERSION;
  schemaVersion: typeof SCRIPT_DRAFT_V2_SCHEMA_VERSION;
  language: ContentLanguageV2;
  sourceType: ScriptSourceKind;
  text: string;
  repairText: string;
};

const languageName: Record<ContentLanguageV2, string> = {
  vi: "Vietnamese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
};

const sourceInstruction: Record<ScriptSourceKind, string> = {
  topic: "The source is a short topic/idea. Invent an engaging spoken short-form script about it.",
  raw_script: "The source is a raw draft script/transcript. Rewrite and tighten it into the required schema; keep the original meaning and key facts.",
  article_url: "The source is text extracted from an article URL. Summarize the key point(s) into a short-form spoken script; do not copy sentences verbatim.",
  file: "The source is text extracted from an uploaded file. Summarize/adapt it into a short-form spoken script; do not copy verbatim.",
};

export const clipForPromptV2 = (value: string, max = 6000) => {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…[truncated ${trimmed.length - max} chars]`;
};

/** `sourceText` must already be the SourceVersion's extracted/raw text — this function never
 * fetches or extracts anything itself (see `apps/api/src/source-extract.ts` for article_url). */
export function buildScriptV2PromptPackage(input: {
  sourceType: ScriptSourceKind;
  sourceText: string;
  originRef?: string | null;
  language: string;
  direction?: string;
}): ScriptPromptPackageV2 {
  const language: ContentLanguageV2 = isContentLanguageV2(input.language) ? input.language : "vi";
  const sourceType = isScriptSourceKind(input.sourceType) ? input.sourceType : "topic";
  const direction = clipForPromptV2(input.direction?.trim() || "Create a new 55-65s TikTok script from the source.", 1500);
  const clippedSource = clipForPromptV2(input.sourceText, sourceType === "topic" ? 240 : 8000);
  const provenance = sourceType === "article_url" && input.originRef ? `\nSource URL (provenance only, do not repeat as text): ${input.originRef}` : "";
  const promptBody = `Source (${sourceType}):\n${clippedSource}${provenance}`;
  const body = `You are LyOnix. Return one JSON object that matches schema ${SCRIPT_DRAFT_V2_SCHEMA_VERSION}.
Prompt template: ${SCRIPT_PROMPT_TEMPLATE_V2_VERSION}
Spoken short-form TikTok script in ${languageName[language]}.
${sourceInstruction[sourceType]}
Creative direction / requested changes: ${direction}
Target spoken length: 55-65 seconds. 10-14 scenes. Total durationHintMs between 30000 and 90000.
Required keys: schemaVersion, language, title, hook, body, cta, caption, scenes.
Each scene: sceneId, narration (spoken), screenText (on-screen, no HTML/URLs), visualQuery (short media search query/framing brief, non-empty), durationHintMs.
Each scene's narration must be exactly ONE sentence (one visual per sentence, so the video cuts to a new shot every sentence) - never pack 2+ sentences into a single scene's narration; split a long thought across multiple scenes instead.
body must be the full spoken narration concatenating scene narration in order.
Every scene visualQuery must be a concrete, searchable phrase (e.g. "city skyline at night"), not empty and not a duplicate placeholder.
Do not invent music beds or render steps. Do not wrap JSON in markdown.
${promptBody}`;
  const repairText = `${body}

The previous reply was not valid ${SCRIPT_DRAFT_V2_SCHEMA_VERSION}. Repair it: output a single JSON object only, unique sceneId values, every scene has a non-empty visualQuery, and total duration 30-90s.`;
  return {
    promptTemplateVersion: SCRIPT_PROMPT_TEMPLATE_V2_VERSION,
    schemaVersion: SCRIPT_DRAFT_V2_SCHEMA_VERSION,
    language,
    sourceType,
    text: body,
    repairText,
  };
}
