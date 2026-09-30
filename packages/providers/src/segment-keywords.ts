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

export const SEGMENT_KEYWORDS_PROMPT_VERSION = "segment-keywords.v1" as const;
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
        required: ["segmentId", "ja", "en"],
        properties: {
          segmentId: { type: "string" },
          ja: { type: "string", description: "2-4 word Japanese search phrase in kana/kanji about the entity, place or event" },
          en: { type: "string", description: "2-4 word English search phrase for the same entity, place or event" },
        },
      },
    },
  },
} as Readonly<Record<string, unknown>>;

export type SegmentKeywordsInput = {
  language: string;
  title?: string;
  segments: Array<{ segmentId: string; narration: string }>;
};

export type ExtractedSegmentKeywords = { ja: string; en: string };

export function buildSegmentKeywordsPrompt(input: SegmentKeywordsInput): string {
  const clip = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed.length <= SEGMENT_KEYWORDS_NARRATION_MAX_CHARS ? trimmed : `${trimmed.slice(0, SEGMENT_KEYWORDS_NARRATION_MAX_CHARS)}...`;
  };
  const lines = input.segments.slice(0, SEGMENT_KEYWORDS_MAX_SEGMENTS).map((segment) => `- ${segment.segmentId}: ${clip(segment.narration)}`);
  return `You are LyOnix. Prompt template: ${SEGMENT_KEYWORDS_PROMPT_VERSION}
For each background segment of a short vertical video (script language: ${input.language}${input.title ? `, title: ${clip(input.title)}` : ""}), return search keywords a person would type to find real footage of what that segment talks about.
Return one JSON object {"segments":[{"segmentId","ja","en"}]} with exactly one entry per segmentId below, in the same order.
- ja: 2-4 words in Japanese (kana/kanji), separated by spaces, about the real ENTITY, person, place or event (examples: "東京 夜景", "渋谷 スクランブル交差点", "新宿 ラーメン"). Never a sentence, camera direction, mood or English text.
- en: 2-4 English words for the same entity, place or event (example: "tokyo night skyline").
Segments (narration):
${lines.join("\n")}
Do not wrap JSON in markdown.`;
}

/**
 * Keeps only entries for known segment ids whose `ja` is a valid Japanese search phrase; `en` is kept
 * only when it is a valid short English phrase (otherwise ""). Never throws.
 */
export function parseSegmentKeywords(output: unknown, segmentIds: readonly string[]): { keywords: Record<string, ExtractedSegmentKeywords>; rejectedSegmentIds: string[] } {
  const known = new Set(segmentIds);
  const keywords: Record<string, ExtractedSegmentKeywords> = {};
  const list = output && typeof output === "object" && Array.isArray((output as { segments?: unknown }).segments) ? (output as { segments: unknown[] }).segments : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.segmentId === "string" ? row.segmentId.trim() : "";
    if (!known.has(id) || keywords[id]) continue;
    const ja = typeof row.ja === "string" ? row.ja.trim() : "";
    if (!isValidJaSearchKeyword(ja)) continue;
    const en = typeof row.en === "string" && isValidEnSearchKeyword(row.en) ? row.en.trim() : "";
    keywords[id] = { ja, en };
  }
  return { keywords, rejectedSegmentIds: segmentIds.filter((id) => !keywords[id]) };
}

export type ExtractSegmentKeywordsResult = {
  keywords: Record<string, ExtractedSegmentKeywords>;
  rejectedSegmentIds: string[];
  usage: UsageRecord;
  modelId: string;
  promptTemplateVersion: string;
};

/** ONE provider call for all segments (no repair/retry loop). Provider errors surface as `ProviderError`. */
export async function extractSegmentKeywords(kind: LiveContentKind, apiKey: string, modelId: string, input: SegmentKeywordsInput): Promise<ExtractSegmentKeywordsResult> {
  const resolvedModelId = normalizeModelId(modelId);
  const segments = input.segments.slice(0, SEGMENT_KEYWORDS_MAX_SEGMENTS);
  if (segments.length === 0) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "No segments to extract keywords for", false);
  const reply = await generateContentStructuredV2<unknown>(kind, apiKey, resolvedModelId, buildSegmentKeywordsPrompt({ ...input, segments }), SEGMENT_KEYWORDS_JSON_SCHEMA);
  const parsed = parseSegmentKeywords(reply.output, segments.map((segment) => segment.segmentId));
  return { ...parsed, usage: reply.usage, modelId: resolvedModelId, promptTemplateVersion: SEGMENT_KEYWORDS_PROMPT_VERSION };
}
