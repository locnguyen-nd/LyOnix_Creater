/**
 * VE2E-38 (CR-JP-ONESHOT-MEDIA-2026-09-29 §4): optional whole-script `visualPlan` generated in the
 * SAME content-provider call as the ScriptDraftV2 (the model sees the whole script): background
 * segments of consecutive scenes, the subject each one shows + its priority (1 = main subject),
 * bilingual search keywords (`ja` for Japanese-native sources, `en` for Pexels) and style hints so
 * every segment keeps one consistent setting/time of day/lighting/palette.
 *
 * Parsing is tolerant by design: anything missing or structurally invalid yields `null` and the
 * pipeline behaves exactly as before VE2E-38 (per-scene `visualQuery`). Selection/reuse policy
 * that consumes the plan is VE2E-31, not here. Pure logic, no I/O.
 */

export type ScriptVisualKeywordsV2 = { ja: string; en: string };

export type ScriptVisualStyleHintsV2 = {
  setting: string;
  timeOfDay: string;
  lighting: string;
  palette: string;
};

export type ScriptVisualSegmentV2 = {
  segmentId: string;
  /** Consecutive scene ids, in script order. */
  sceneIds: string[];
  subject: string;
  /** Integer 1..10, 1 = the video's main subject. */
  priority: number;
  keywords: ScriptVisualKeywordsV2;
  styleHints: ScriptVisualStyleHintsV2;
};

export type ScriptVisualPlanV2 = { segments: ScriptVisualSegmentV2[] };

export const VISUAL_PLAN_MAX_SEGMENTS = 10;
export const VISUAL_PLAN_PRIORITY_MIN = 1;
export const VISUAL_PLAN_PRIORITY_MAX = 10;
const MAX_ID = 100;
const MAX_SUBJECT = 200;
const MAX_KEYWORD = 200;
const MAX_HINT = 120;

const styleHintKeys = ["setting", "timeOfDay", "lighting", "palette"] as const;

/** JSON-schema fragment for the provider's structured output. Nullable and listed in `required` so strict structured-output modes accept it; the model returns `null` when it cannot plan. */
export const SCRIPT_VISUAL_PLAN_V2_JSON_SCHEMA = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["segments"],
      properties: {
        segments: {
          type: "array",
          minItems: 1,
          maxItems: VISUAL_PLAN_MAX_SEGMENTS,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["segmentId", "sceneIds", "subject", "priority", "keywords", "styleHints"],
            properties: {
              segmentId: { type: "string" },
              sceneIds: { type: "array", minItems: 1, items: { type: "string" } },
              subject: { type: "string" },
              priority: { type: "integer", minimum: VISUAL_PLAN_PRIORITY_MIN, maximum: VISUAL_PLAN_PRIORITY_MAX },
              keywords: {
                type: "object",
                additionalProperties: false,
                required: ["ja", "en"],
                properties: {
                  ja: { type: "string", description: "2-4 word real Japanese search phrase (kana/kanji) naming the topic entity, place or event; never a camera direction or an English sentence" },
                  en: { type: "string", description: "2-4 word English stock-footage search phrase for the same entity, place or event" },
                },
              },
              styleHints: {
                type: "object",
                additionalProperties: false,
                required: [...styleHintKeys],
                properties: Object.fromEntries(styleHintKeys.map((key) => [key, { type: "string" }])),
              },
            },
          },
        },
      },
    },
  ],
} as Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Trimmed string, or `null` when not a string or longer than `max` (never silently truncated - a garbage value invalidates the plan instead). */
const boundedText = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : null;
};

/** VE2E-50: why a raw `visualPlan` was dropped (logged in the run diagnostics instead of a silent null). */
export type VisualPlanRejectionReason =
  | "absent"
  | "null"
  | "not_object"
  | "segments_missing"
  | "segment_count"
  | "segment_not_object"
  | "segment_id_invalid"
  | "scene_ids_invalid"
  | "scene_id_unknown"
  | "scenes_not_consecutive"
  | "scenes_not_fully_covered"
  | "subject_invalid"
  | "priority_invalid"
  | "keywords_invalid"
  | "style_hints_invalid";

export type VisualPlanDiagnosis =
  | { plan: ScriptVisualPlanV2; reason: null }
  | { plan: null; reason: VisualPlanRejectionReason; detail?: string };

/**
 * Validates/normalizes a raw `visualPlan` against the script's FINAL scene ids.
 *
 * `resolveSceneIds` maps a scene id as the model wrote it to the final id(s) it became after
 * `parseScriptDraftV2`'s own post-processing (duplicate-id renaming, splitting a multi-sentence
 * scene into several) - identity when omitted. Rules (any violation -> `null`, never a partial
 * plan): 1..10 segments, unique non-empty ids, every scene referenced exists, each segment is a
 * run of consecutive scenes in script order, segments do not overlap and appear in script order,
 * every scene belongs to exactly one segment, integer priority 1..10, keywords/styleHints strings
 * within length bounds and at least one non-empty keyword per segment.
 *
 * VE2E-50: this variant also reports WHY a plan was dropped.
 */
export function diagnoseScriptVisualPlanV2(
  raw: unknown,
  finalSceneIds: readonly string[],
  resolveSceneIds: (rawSceneId: string) => readonly string[] = (id) => [id],
): VisualPlanDiagnosis {
  const reject = (reason: VisualPlanRejectionReason, detail?: string): VisualPlanDiagnosis => ({ plan: null, reason, ...(detail ? { detail } : {}) });
  if (raw === undefined) return reject("absent");
  if (raw === null) return reject("null");
  const root = asRecord(raw);
  if (!root) return reject("not_object");
  if (!Array.isArray(root.segments)) return reject("segments_missing");
  const rawSegments = root.segments;
  if (rawSegments.length === 0 || rawSegments.length > VISUAL_PLAN_MAX_SEGMENTS) return reject("segment_count", String(rawSegments.length));
  const indexById = new Map(finalSceneIds.map((id, index) => [id, index]));
  const seenSegmentIds = new Set<string>();
  const segments: ScriptVisualSegmentV2[] = [];
  let expectedNextIndex = 0;
  for (const item of rawSegments) {
    const row = asRecord(item);
    if (!row) return reject("segment_not_object");
    const segmentId = boundedText(row.segmentId, MAX_ID);
    if (!segmentId || seenSegmentIds.has(segmentId)) return reject("segment_id_invalid", segmentId ?? undefined);
    seenSegmentIds.add(segmentId);
    if (!Array.isArray(row.sceneIds) || row.sceneIds.length === 0) return reject("scene_ids_invalid", segmentId);
    const sceneIds: string[] = [];
    for (const rawId of row.sceneIds) {
      if (typeof rawId !== "string") return reject("scene_ids_invalid", segmentId);
      const resolved = resolveSceneIds(rawId.trim());
      if (resolved.length === 0) return reject("scene_id_unknown", `${segmentId}:${rawId}`);
      sceneIds.push(...resolved);
    }
    // Consecutive, in order, continuing exactly where the previous segment ended (=> full coverage, no overlap).
    for (const sceneId of sceneIds) {
      if (indexById.get(sceneId) !== expectedNextIndex) return reject("scenes_not_consecutive", `${segmentId}:${sceneId}`);
      expectedNextIndex += 1;
    }
    const subject = boundedText(row.subject, MAX_SUBJECT);
    if (subject === null) return reject("subject_invalid", segmentId);
    const priority = row.priority;
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < VISUAL_PLAN_PRIORITY_MIN || priority > VISUAL_PLAN_PRIORITY_MAX) return reject("priority_invalid", segmentId);
    const keywordsRow = asRecord(row.keywords);
    const ja = keywordsRow ? boundedText(keywordsRow.ja, MAX_KEYWORD) : null;
    const en = keywordsRow ? boundedText(keywordsRow.en, MAX_KEYWORD) : null;
    if (ja === null || en === null || (!ja && !en)) return reject("keywords_invalid", segmentId);
    const hintsRow = asRecord(row.styleHints);
    if (!hintsRow) return reject("style_hints_invalid", segmentId);
    const hints = styleHintKeys.map((key) => boundedText(hintsRow[key], MAX_HINT));
    if (hints.some((value) => value === null)) return reject("style_hints_invalid", segmentId);
    const [setting, timeOfDay, lighting, palette] = hints as string[];
    segments.push({ segmentId, sceneIds, subject, priority, keywords: { ja, en }, styleHints: { setting: setting!, timeOfDay: timeOfDay!, lighting: lighting!, palette: palette! } });
  }
  if (expectedNextIndex !== finalSceneIds.length) return reject("scenes_not_fully_covered", `${expectedNextIndex}/${finalSceneIds.length}`);
  return { plan: { segments }, reason: null };
}

export function normalizeScriptVisualPlanV2(
  raw: unknown,
  finalSceneIds: readonly string[],
  resolveSceneIds: (rawSceneId: string) => readonly string[] = (id) => [id],
): ScriptVisualPlanV2 | null {
  return diagnoseScriptVisualPlanV2(raw, finalSceneIds, resolveSceneIds).plan;
}

// --- VE2E-50: search keyword validation ---

/** Hiragana, katakana (incl. half-width), CJK unified ideographs (+ ext A). */
const JAPANESE_CHAR = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿ｦ-ﾟ]/;
export const JA_KEYWORD_MAX_CHARS = 40;
export const JA_KEYWORD_MAX_WORDS = 5;

export const containsJapaneseChars = (value: string): boolean => JAPANESE_CHAR.test(value);

/**
 * A usable Japanese SEARCH phrase: contains kana/kanji, short (a few words, not a sentence or a shot
 * description), no sentence punctuation. Anything else (English shot descriptions, empty, long) is
 * rejected and must never be sent to a social search.
 */
export const isValidJaSearchKeyword = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > JA_KEYWORD_MAX_CHARS) return false;
  if (!containsJapaneseChars(trimmed)) return false;
  if (/[.。!！?？,、;；:\n]/.test(trimmed)) return false;
  return trimmed.split(/[\s　]+/).filter(Boolean).length <= JA_KEYWORD_MAX_WORDS;
};

/** A short English search phrase (Pexels): non-empty, <= 6 words, no sentence punctuation. */
export const isValidEnSearchKeyword = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (/[.!?;:\n]/.test(trimmed)) return false;
  return trimmed.split(/\s+/).filter(Boolean).length <= 6;
};

/**
 * Blanks every `keywords.ja` that fails {@link isValidJaSearchKeyword} (keeps `en`) and returns the
 * ids of the segments whose ja keyword is missing/invalid afterwards (those need the dedicated
 * keyword extraction).
 */
export function sanitizeVisualPlanJaKeywords(plan: ScriptVisualPlanV2): { plan: ScriptVisualPlanV2; invalidJaSegmentIds: string[] } {
  const invalidJaSegmentIds: string[] = [];
  const segments = plan.segments.map((segment) => {
    if (isValidJaSearchKeyword(segment.keywords.ja)) return segment;
    invalidJaSegmentIds.push(segment.segmentId);
    return { ...segment, keywords: { ...segment.keywords, ja: "" } };
  });
  return { plan: { segments }, invalidJaSegmentIds };
}

/** The segment a scene belongs to, if any. */
export function findVisualSegmentForScene(plan: ScriptVisualPlanV2 | null | undefined, sceneId: string): ScriptVisualSegmentV2 | null {
  return plan?.segments.find((segment) => segment.sceneIds.includes(sceneId)) ?? null;
}

/**
 * Media search query for one scene: the scene's segment `keywords.en` when the plan has one (Pexels
 * indexes English best - CR §3), otherwise exactly the pre-VE2E-38 behavior (`visualQuery`, then narration).
 */
export function mediaSearchQueryForScene(
  scene: { sceneId: string; visualQuery: string; narration: string },
  plan: ScriptVisualPlanV2 | null | undefined,
): string {
  const english = findVisualSegmentForScene(plan, scene.sceneId)?.keywords.en.trim();
  if (english) return english;
  return scene.visualQuery.trim() || scene.narration;
}
