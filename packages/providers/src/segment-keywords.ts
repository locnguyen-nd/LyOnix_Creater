/**
 * VE2E-50: dedicated, cheap keyword-extraction call. Used when the script's `visualPlan` is missing
 * or a segment's `keywords.ja` failed validation: ONE content call for ALL segments at once, from the
 * narration only, returning short real search phrases (`ja` for Apify/TikTok, `en` for Pexels).
 * Scene `visualQuery` (a shot description) is never an input and never a fallback.
 */
import { ProviderError, type UsageRecord } from "./index.js";
import { generateContentStructuredV2, type LiveContentKind } from "./live-content.js";
import { normalizeModelId } from "./content-models.js";
import { isValidEnSearchKeyword, isValidJaSearchKeyword } from "./script-visual-plan.js";
import { KEYWORD_TIER_MAX_PHRASES, filterPhrasesBySubject, parseVideoSubject, subjectKeywordRuleLines, type VideoSubjectV2 } from "./subject-keywords.js";

export const SEGMENT_KEYWORDS_PROMPT_VERSION = "segment-keywords.v2" as const;
/** Narration sent per segment is clipped so the call stays cheap. */
export const SEGMENT_KEYWORDS_NARRATION_MAX_CHARS = 400;
export const SEGMENT_KEYWORDS_MAX_SEGMENTS = 10;

export const SEGMENT_KEYWORDS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["segmentId", "ja", "en", "broad_en", "mood_en"],
        properties: {
          segmentId: { type: "string" },
          ja: { type: "array", items: { type: "string" }, description: "1-2 Japanese search phrases (kana/kanji, 2-4 words) about the MAIN SUBJECT's entity, place or event, each containing the subject's name or alias" },
          en: { type: "array", items: { type: "string" }, description: "1-2 English search phrases (2-4 words) for the same, each containing the subject's name or alias" },
          broad_en: { type: "array", items: { type: "string" }, description: "1-2 wider English topic phrases that still contain the subject's name or alias" },
          mood_en: { type: "string", description: "One generic background mood phrase; last-resort backdrop only, never used to find the main clip" },
        },
      },
    },
  },
} as Readonly<Record<string, unknown>>;

/** VE2E-151: asked only when the script knows no subject (no / broken visualPlan): who or what the video is about. */
const VIDEO_SUBJECT_PROPERTY = {
  type: "object",
  additionalProperties: false,
  required: ["main", "kind", "aliases", "mustInclude", "mustExclude", "otherPeople"],
  properties: {
    main: { type: "string", description: "The video's main subject as a proper name; \"\" when there is no clear subject" },
    kind: { type: "string", enum: ["person", "group", "team", "place", "event", "other"] },
    aliases: { type: "array", items: { type: "string" }, description: "Other spellings: native script, romaji / English, stage name, nickname" },
    mustInclude: { type: "array", items: { type: "string" }, description: "Group / team / occupation that tells same-name people apart" },
    mustExclude: { type: "array", items: { type: "string" } },
    otherPeople: { type: "array", items: { type: "string" } },
  },
} as const;

/** The keyword schema, plus `videoSubject` when the caller does not know the subject yet. */
export const segmentKeywordsSchemaFor = (askSubject: boolean): Readonly<Record<string, unknown>> => {
  if (!askSubject) return SEGMENT_KEYWORDS_JSON_SCHEMA;
  const base = SEGMENT_KEYWORDS_JSON_SCHEMA as { required: string[]; properties: Record<string, unknown> };
  return { ...SEGMENT_KEYWORDS_JSON_SCHEMA, required: [...base.required, "videoSubject"], properties: { ...base.properties, videoSubject: VIDEO_SUBJECT_PROPERTY } };
};

export type SegmentKeywordsInput = {
  language: string;
  title?: string;
  /** VE2E-88: the video's main subject (from the script's visualPlan.videoSubject, or just a name). Keeps every keyword on-subject. */
  subject?: VideoSubjectV2 | string | null;
  segments: Array<{ segmentId: string; narration: string }>;
};

/** `ja`/`en` stay the first phrase as plain strings (pre-VE2E-88 shape); the tier arrays are additive. */
export type ExtractedSegmentKeywords = { ja: string; en: string; jaAll?: string[]; enAll?: string[]; broadEn?: string[]; moodEn?: string };

export function buildSegmentKeywordsPrompt(input: SegmentKeywordsInput): string {
  const clip = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length <= SEGMENT_KEYWORDS_NARRATION_MAX_CHARS ? trimmed : `${trimmed.slice(0, SEGMENT_KEYWORDS_NARRATION_MAX_CHARS)}...`;
  };
  const subject = parseVideoSubject(input.subject);
  const lines = input.segments.slice(0, SEGMENT_KEYWORDS_MAX_SEGMENTS).map((segment) => `- ${segment.segmentId}: ${clip(segment.narration)}`);
  // VE2E-151: no known subject -> the same call names it (title + narration), so a video about one person stays on that person.
  const subjectAsk = subject
    ? ""
    : `\nAlso return videoSubject: the ONE main subject of the whole video taken from the title and the narration - main = its proper name ("" when there is none), kind = person | group | team | place | event | other, aliases = other spellings of the same name (native script, romaji / English, stage name, nickname), mustInclude = the group / team / occupation that tells same-name people apart, mustExclude = [], otherPeople = other named people. When it is a person, every ja / en / broad_en phrase contains that person's name or an alias (never a generic phrase such as "baseball stadium" or "smartphone").`;
  return `You are LyOnix. Prompt template: ${SEGMENT_KEYWORDS_PROMPT_VERSION}
For each background segment of a short vertical video (script language: ${input.language}${input.title ? `, title: ${clip(input.title)}` : ""}), return search keywords a person would type to find real footage of what that segment talks about.
Return one JSON object {"segments":[{"segmentId","ja","en","broad_en","mood_en"}]${subject ? "" : `, "videoSubject": {...}`}} with exactly one entry per segmentId below, in the same order.
- ja: array of 1-2 phrases, each 2-4 words in Japanese (kana/kanji), separated by spaces, about the real ENTITY, person, place or event (examples: "東京 夜景", "渋谷 スクランブル交差点"). Never a sentence, camera direction, mood or English text.
- en: array of 1-2 English phrases (2-4 words) with the same meaning (example: "tokyo night skyline").
- broad_en: array of 1-2 wider English topic phrases (still about the subject).
- mood_en: ONE generic background mood phrase (example: "city night timelapse").
${subjectKeywordRuleLines(subject).join("\n")}${subjectAsk}
Segments (narration):
${lines.join("\n")}
Do not wrap JSON in markdown.`;
}

const phraseList = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);

/**
 * Keeps only entries for known segment ids with at least one usable phrase: a valid Japanese phrase
 * (kana/kanji) OR a valid English phrase (en alone is accepted - Apify can search by en, VE2E-88).
 * Accepts the old string form `{ja,en}` and the array form. With a `subject`, phrases not anchored on
 * it (or hitting mustExclude) are dropped from ja/en/broad_en; `mood_en` is exempt. Never throws.
 */
export function parseSegmentKeywords(
  output: unknown,
  segmentIds: readonly string[],
  subjectInput?: VideoSubjectV2 | string | null,
): { keywords: Record<string, ExtractedSegmentKeywords>; rejectedSegmentIds: string[]; videoSubject?: VideoSubjectV2 } {
  const known = new Set(segmentIds);
  const subject = parseVideoSubject(subjectInput);
  const keywords: Record<string, ExtractedSegmentKeywords> = {};
  const list = output && typeof output === "object" && Array.isArray((output as { segments?: unknown }).segments) ? (output as { segments: unknown[] }).segments : [];
  const pick = (value: unknown, isValid: (phrase: unknown) => boolean) =>
    filterPhrasesBySubject(phraseList(value).filter((phrase) => isValid(phrase)), subject).slice(0, KEYWORD_TIER_MAX_PHRASES);
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.segmentId === "string" ? row.segmentId.trim() : "";
    if (!known.has(id) || keywords[id]) continue;
    const ja = pick(row.ja, isValidJaSearchKeyword);
    const en = pick(row.en, isValidEnSearchKeyword);
    if (!ja[0] && !en[0]) continue;
    const broad = pick(row.broad_en ?? row.broadEn, isValidEnSearchKeyword);
    const moodRaw = row.mood_en ?? row.moodEn;
    const mood = typeof moodRaw === "string" && isValidEnSearchKeyword(moodRaw) ? moodRaw.trim() : "";
    keywords[id] = {
      ja: ja[0] ?? "",
      en: en[0] ?? "",
      ...(Array.isArray(row.ja) ? { jaAll: ja } : {}),
      ...(Array.isArray(row.en) ? { enAll: en } : {}),
      ...(broad.length ? { broadEn: broad } : {}),
      ...(mood ? { moodEn: mood } : {}),
    };
  }
  // VE2E-151: the subject the model named (only asked when none was known).
  const named = !subject && output && typeof output === "object" ? parseVideoSubject((output as { videoSubject?: unknown }).videoSubject) : null;
  return { keywords, rejectedSegmentIds: segmentIds.filter((id) => !keywords[id]), ...(named ? { videoSubject: named } : {}) };
}

export type ExtractSegmentKeywordsResult = {
  keywords: Record<string, ExtractedSegmentKeywords>;
  rejectedSegmentIds: string[];
  /** VE2E-151: the subject the model named when the caller knew none. */
  videoSubject?: VideoSubjectV2;
  usage: UsageRecord;
  modelId: string;
  promptTemplateVersion: string;
};

/** ONE provider call for all segments (no repair/retry loop). Provider errors surface as `ProviderError`. */
export async function extractSegmentKeywords(kind: LiveContentKind, apiKey: string, modelId: string, input: SegmentKeywordsInput): Promise<ExtractSegmentKeywordsResult> {
  const resolvedModelId = normalizeModelId(modelId);
  const segments = input.segments.slice(0, SEGMENT_KEYWORDS_MAX_SEGMENTS);
  if (segments.length === 0) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "No segments to extract keywords for", false);
  const reply = await generateContentStructuredV2<unknown>(kind, apiKey, resolvedModelId, buildSegmentKeywordsPrompt({ ...input, segments }), segmentKeywordsSchemaFor(!parseVideoSubject(input.subject)));
  const parsed = parseSegmentKeywords(reply.output, segments.map((segment) => segment.segmentId), input.subject);
  return { ...parsed, usage: reply.usage, modelId: resolvedModelId, promptTemplateVersion: SEGMENT_KEYWORDS_PROMPT_VERSION };
}
