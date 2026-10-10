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

import { KEYWORD_TIER_MAX_PHRASES, SUBJECT_MAX_TERMS, filterPhrasesBySubject, parseVideoSubject, type VideoSubjectV2 } from "./subject-keywords.js";

/**
 * VE2E-88: `ja`/`en` stay plain strings (the first phrase) for every pre-88 consumer; the multi-tier
 * data is additive. `jaAll`/`enAll` (1-2 phrases), `broadEn` (wider topic still tied to the video
 * subject) are search tiers; `moodEn` is a generic backdrop for the L5/L6 tiers ONLY - never used to
 * find the main clip.
 */
export type ScriptVisualKeywordsV2 = { ja: string; en: string; jaAll?: string[]; enAll?: string[]; broadEn?: string[]; moodEn?: string };

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

/** `videoSubject` (VE2E-88, optional): the video's main subject + aliases + mustInclude/mustExclude; absent in plans stored before VE2E-88. */
export type ScriptVisualPlanV2 = { segments: ScriptVisualSegmentV2[]; videoSubject?: VideoSubjectV2 };

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
      required: ["videoSubject", "segments"],
      properties: {
        videoSubject: {
          type: "object",
          additionalProperties: false,
          required: ["main", "kind", "aliases", "mustInclude", "mustExclude", "otherPeople"],
          properties: {
            main: { type: "string", description: "The video's MAIN subject as a proper name (the player, team, person, place or story the whole video is about); for a person the full name as commonly written in the script language" },
            kind: { type: "string", enum: ["person", "group", "team", "place", "event", "other"], description: "person = ONE specific person (athlete, idol, actor, politician...); group = a band/idol group; team = a sports team/club" },
            aliases: { type: "array", items: { type: "string" }, description: "Other names/spellings/nicknames of the main subject: full name in native script, romaji/English spelling, stage name, nickname (ja/en/native script), 0-6" },
            mustInclude: { type: "array", items: { type: "string" }, description: "Anchor terms tied to the subject: team, match, event; for a person the group/team/occupation that tells same-name people apart, 0-6" },
            mustExclude: { type: "array", items: { type: "string" }, description: "Terms that would make a clip off-subject (rival story, unrelated person), 0-6" },
            otherPeople: { type: "array", items: { type: "string" }, description: "Other named people the script mentions (context only), 0-6" },
          },
        },
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
                required: ["ja", "en", "broad_en", "mood_en"],
                properties: {
                  ja: { type: "array", items: { type: "string" }, description: "1-2 real Japanese search phrases (kana/kanji, 2-4 words) naming the MAIN SUBJECT's entity/place/event, each containing the subject's name or alias; never a camera direction or an English sentence" },
                  en: { type: "array", items: { type: "string" }, description: "1-2 English search phrases (2-4 words) for the same entity/event, each containing the subject's name or alias" },
                  broad_en: { type: "array", items: { type: "string" }, description: "1-2 WIDER English topic phrases that still contain the subject's name or alias (example: '<subject> match highlights')" },
                  mood_en: { type: "string", description: "Generic background mood for a last-resort backdrop only (example: 'city night timelapse'); never used to find the main clip" },
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

/**
 * Reads one keyword tier. Accepts the old string form and the VE2E-88 array form (`primary` wins when
 * it is an array - the persisted shape keeps `jaAll` next to the scalar `ja`). Returns `null` when a
 * value has the wrong type or an over-long phrase (a garbage value invalidates the plan, never truncated).
 */
function readPhraseTier(primary: unknown, fallback: unknown): { list: string[]; isArray: boolean } | null {
  const source = Array.isArray(primary) ? primary : fallback;
  if (source === undefined || source === null) return { list: [], isArray: false };
  const items = Array.isArray(source) ? source : [source];
  const list: string[] = [];
  for (const item of items) {
    const phrase = boundedText(item, MAX_KEYWORD);
    if (phrase === null) return null;
    if (phrase && !list.some((existing) => existing.toLowerCase() === phrase.toLowerCase())) list.push(phrase);
  }
  return { list: list.slice(0, SUBJECT_MAX_TERMS), isArray: Array.isArray(source) };
}

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

/**
 * `subjectOnly` (VE2E-151): the segments were rejected but the `videoSubject` is usable - the plan is `{ segments: [], videoSubject }` so
 * the person / subject rules still apply (Gemini often rejects the strict schema and the free-form reply has broken segments).
 */
export type VisualPlanDiagnosis =
  | { plan: ScriptVisualPlanV2; reason: null }
  | { plan: null; reason: VisualPlanRejectionReason; detail?: string }
  | { plan: ScriptVisualPlanV2; reason: VisualPlanRejectionReason; detail?: string; subjectOnly: true };

/** A segment id as models write it without the strict schema: `segmentId`, `segment_id` or `id`, a string or a number. */
const rawSegmentId = (row: Record<string, unknown>): unknown => {
  const value = row.segmentId ?? row.segment_id ?? row.id;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : value;
};

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
  const plainReject = (reason: VisualPlanRejectionReason, detail?: string): VisualPlanDiagnosis => ({ plan: null, reason, ...(detail ? { detail } : {}) });
  if (raw === undefined) return plainReject("absent");
  if (raw === null) return plainReject("null");
  const root = asRecord(raw);
  if (!root) return plainReject("not_object");
  // VE2E-151: the subject survives broken segments (subject-only plan), so person / subject rules still apply.
  const salvagedSubject = parseVideoSubject(root.videoSubject ?? root.video_subject);
  const reject = (reason: VisualPlanRejectionReason, detail?: string): VisualPlanDiagnosis =>
    salvagedSubject ? { plan: { segments: [], videoSubject: salvagedSubject }, reason, ...(detail ? { detail } : {}), subjectOnly: true } : plainReject(reason, detail);
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
    const segmentId = boundedText(rawSegmentId(row), MAX_ID);
    if (!segmentId || seenSegmentIds.has(segmentId)) return reject("segment_id_invalid", segmentId ?? undefined);
    seenSegmentIds.add(segmentId);
    const rawSceneIds = row.sceneIds ?? row.scene_ids;
    if (!Array.isArray(rawSceneIds) || rawSceneIds.length === 0) return reject("scene_ids_invalid", segmentId);
    const sceneIds: string[] = [];
    for (const rawId of rawSceneIds) {
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
    if (!keywordsRow) return reject("keywords_invalid", segmentId);
    const jaTier = readPhraseTier(keywordsRow.jaAll, keywordsRow.ja);
    const enTier = readPhraseTier(keywordsRow.enAll, keywordsRow.en);
    const broadTier = readPhraseTier(keywordsRow.broad_en, keywordsRow.broadEn);
    if (!jaTier || !enTier || !broadTier || (!jaTier.list[0] && !enTier.list[0])) return reject("keywords_invalid", segmentId);
    const moodRaw = keywordsRow.mood_en ?? keywordsRow.moodEn;
    const moodEn = typeof moodRaw === "string" && moodRaw.trim().length <= MAX_KEYWORD ? moodRaw.trim() : "";
    const keywords: ScriptVisualKeywordsV2 = {
      ja: jaTier.list[0] ?? "",
      en: enTier.list[0] ?? "",
      ...(jaTier.isArray ? { jaAll: jaTier.list } : {}),
      ...(enTier.isArray ? { enAll: enTier.list } : {}),
      ...(broadTier.list.length ? { broadEn: broadTier.list } : {}),
      ...(moodEn ? { moodEn } : {}),
    };
    const hintsRow = asRecord(row.styleHints ?? row.style_hints);
    if (!hintsRow) return reject("style_hints_invalid", segmentId);
    const hints = styleHintKeys.map((key) => boundedText(hintsRow[key], MAX_HINT));
    if (hints.some((value) => value === null)) return reject("style_hints_invalid", segmentId);
    const [setting, timeOfDay, lighting, palette] = hints as string[];
    segments.push({ segmentId, sceneIds, subject, priority, keywords, styleHints: { setting: setting!, timeOfDay: timeOfDay!, lighting: lighting!, palette: palette! } });
  }
  if (expectedNextIndex !== finalSceneIds.length) return reject("scenes_not_fully_covered", `${expectedNextIndex}/${finalSceneIds.length}`);
  return { plan: { segments, ...(salvagedSubject ? { videoSubject: salvagedSubject } : {}) }, reason: null };
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

export type SanitizedVisualPlan = {
  plan: ScriptVisualPlanV2;
  /** Segments with no valid ja phrase left (blanked). Kept for pre-88 consumers: they used to need extraction. */
  invalidJaSegmentIds: string[];
  /** Segments with NO usable ja AND NO usable en phrase left - these truly need the extract_keywords call (en alone is valid for Apify). */
  unusableSegmentIds: string[];
};

/**
 * Validates every keyword tier of every segment: ja must pass {@link isValidJaSearchKeyword}, en and
 * broad_en {@link isValidEnSearchKeyword} (invalid phrases are dropped, at most 2 per tier). When the
 * plan knows its `videoSubject`, phrases that do not contain the subject/an alias/a mustInclude term or
 * that hit mustExclude are dropped too (CR section 7 subject rule); `moodEn` is exempt (backdrop only).
 */
export function sanitizeVisualPlanKeywords(plan: ScriptVisualPlanV2): SanitizedVisualPlan {
  const invalidJaSegmentIds: string[] = [];
  const unusableSegmentIds: string[] = [];
  const subject = plan.videoSubject ?? null;
  const segments = plan.segments.map((segment) => {
    const keywords = segment.keywords;
    const pick = (phrases: readonly string[], isValid: (value: unknown) => boolean) =>
      filterPhrasesBySubject(phrases.filter((phrase) => isValid(phrase)), subject).slice(0, KEYWORD_TIER_MAX_PHRASES);
    const jaList = pick(keywords.jaAll ?? [keywords.ja], isValidJaSearchKeyword);
    const enList = pick(keywords.enAll ?? [keywords.en], isValidEnSearchKeyword);
    const broadList = pick(keywords.broadEn ?? [], isValidEnSearchKeyword);
    if (!jaList[0]) invalidJaSegmentIds.push(segment.segmentId);
    if (!jaList[0] && !enList[0]) unusableSegmentIds.push(segment.segmentId);
    const next: ScriptVisualKeywordsV2 = {
      ja: jaList[0] ?? "",
      en: enList[0] ?? "",
      ...(keywords.jaAll ? { jaAll: jaList } : {}),
      ...(keywords.enAll ? { enAll: enList } : {}),
      ...(broadList.length ? { broadEn: broadList } : {}),
      ...(keywords.moodEn ? { moodEn: keywords.moodEn } : {}),
    };
    return { ...segment, keywords: next };
  });
  return { plan: { ...plan, segments }, invalidJaSegmentIds, unusableSegmentIds };
}

/** Pre-VE2E-88 name/shape of {@link sanitizeVisualPlanKeywords} (kept for existing callers). */
export function sanitizeVisualPlanJaKeywords(plan: ScriptVisualPlanV2): { plan: ScriptVisualPlanV2; invalidJaSegmentIds: string[] } {
  const { plan: sanitized, invalidJaSegmentIds } = sanitizeVisualPlanKeywords(plan);
  return { plan: sanitized, invalidJaSegmentIds };
}

/**
 * Ordered search phrases for the MAIN clip of a segment: ja, then en, then broad_en (CR section 7 Q1).
 * `moodEn` is deliberately absent - it is only for the photo/brand-background tiers (L5/L6).
 */
export function searchTiersForKeywords(keywords: ScriptVisualKeywordsV2): Array<{ tier: "ja" | "en" | "broad"; phrase: string }> {
  const out: Array<{ tier: "ja" | "en" | "broad"; phrase: string }> = [];
  const add = (tier: "ja" | "en" | "broad", phrases: readonly string[]) => {
    for (const phrase of phrases) if (phrase.trim() && !out.some((entry) => entry.phrase === phrase.trim())) out.push({ tier, phrase: phrase.trim() });
  };
  add("ja", keywords.jaAll ?? [keywords.ja]);
  add("en", keywords.enAll ?? [keywords.en]);
  add("broad", keywords.broadEn ?? []);
  return out;
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
  const keywords = findVisualSegmentForScene(plan, scene.sceneId)?.keywords;
  const english = keywords?.en.trim() || keywords?.broadEn?.[0]?.trim();
  if (english) return english;
  return scene.visualQuery.trim() || scene.narration;
}
