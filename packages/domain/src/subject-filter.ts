/**
 * VE2E-89 (CR-MEDIA-SLA-2026-10-07 §7 "Bổ sung", CR Q2): pure helpers that bind the media search to the video's main subject.
 *
 * - `subjectProfileOf`: subject + aliases + mustInclude/mustExclude of a planned segment (VE2E-88 keywords).
 * - `anchorKeywordToSubject` / `subjectTierKeywords`: every search tier (ja/en/broad) carries the subject (name/alias).
 * - `subjectMatchScore`: caption/hashtag/author vs aliases -> 0..1; only ever a RANKING signal (never fails a job, Q2).
 * - `applySubjectToBrief`: puts aliases/mustExclude/preferred authors on a scene brief for `rankMediaCandidates`;
 *   the vision gate sees the subject only for high-priority segments.
 */
import { parseSegmentKeywords, type KeywordTier } from "./media-ladder.js";
import type { SceneBrief } from "./media-ranking.js";

export type SubjectProfile = { subject: string | null; aliases: string[]; mustInclude: string[]; mustExclude: string[] };

const asStrings = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text && !out.some((existing) => existing.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
};

/** Reads the subject description off a planned segment (`segment.subject` + `segment.keywords.{subject,aliases,mustInclude,mustExclude}`). */
export function subjectProfileOf(segment: { subject?: string | null; keywords?: unknown }): SubjectProfile {
  const record = segment.keywords && typeof segment.keywords === "object" ? (segment.keywords as Record<string, unknown>) : {};
  const subject = (typeof record.subject === "string" && record.subject.trim()) || segment.subject?.trim() || null;
  const aliases = asStrings(record.aliases);
  return { subject, aliases, mustInclude: asStrings(record.mustInclude), mustExclude: asStrings(record.mustExclude) };
}

/** Subject name first, then aliases (>= 2 chars), de-duplicated. */
export const subjectNames = (profile: SubjectProfile): string[] => {
  const out: string[] = [];
  for (const name of [profile.subject ?? "", ...profile.aliases]) {
    const text = name.trim();
    if (text.length >= 2 && !out.some((existing) => existing.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
};

const compact = (value: string) => value.toLowerCase().replace(/[\s#_\-.,・]+/g, "");
const JAPANESE = /[぀-ヿ㐀-鿿]/;
const LATIN = /[A-Za-z]/;

const containsName = (text: string, names: readonly string[]): boolean => {
  const haystack = compact(text);
  return names.some((name) => {
    const needle = compact(name);
    return needle.length >= 2 && haystack.includes(needle);
  });
};

/** Prepends the best-fitting subject name when `keyword` does not already mention the subject; no subject -> unchanged. */
export function anchorKeywordToSubject(keyword: string, profile: SubjectProfile, tier: KeywordTier): string {
  const names = subjectNames(profile);
  const text = keyword.trim();
  if (names.length === 0 || !text || containsName(text, names)) return text;
  const wantsJa = tier === "ja";
  const name = names.find((candidate) => (wantsJa ? JAPANESE.test(candidate) : LATIN.test(candidate) && !JAPANESE.test(candidate))) ?? names[0]!;
  return `${name} ${text}`.slice(0, 200);
}

/**
 * The (at most 3) search keywords ja > en > broad of a segment, every one anchored on the subject. Per tier the first keyword that
 * already names the subject wins, else the first one gets the subject prepended. `broad` falls back to the subject itself (never `mood`).
 * A tier whose keyword repeats an earlier tier's is dropped. `isValidJa` filters the ja list (no valid ja -> no ja tier).
 */
export function subjectTierKeywords(raw: unknown, profile: SubjectProfile, isValidJa: (value: string) => boolean = () => true): Array<{ tier: KeywordTier; keyword: string }> {
  const parsed = parseSegmentKeywords(raw);
  const names = subjectNames(profile);
  const pick = (list: string[]): string | null => list.find((item) => containsName(item, names)) ?? list[0] ?? null;
  const candidates: Array<{ tier: KeywordTier; keyword: string | null }> = [
    { tier: "ja", keyword: pick(parsed.ja.filter(isValidJa)) },
    { tier: "en", keyword: pick(parsed.en) },
    { tier: "broad", keyword: pick(parsed.broad) ?? profile.subject?.trim() ?? null },
  ];
  const seen = new Set<string>();
  const out: Array<{ tier: KeywordTier; keyword: string }> = [];
  for (const { tier, keyword } of candidates) {
    if (!keyword?.trim()) continue;
    const anchored = anchorKeywordToSubject(keyword, profile, tier);
    if (seen.has(anchored.toLowerCase())) continue;
    seen.add(anchored.toLowerCase());
    out.push({ tier, keyword: anchored });
  }
  return out;
}

/** Candidate metadata (caption + hashtags + author names) vs the subject: 1 = name in caption/hashtag, 0.5 = name only in the author, 0 = none. */
export function subjectMatchScore(profile: SubjectProfile, meta: { text?: string | null; author?: string | null }): number {
  const names = subjectNames(profile);
  if (names.length === 0) return 0;
  if (meta.text && containsName(meta.text, names)) return 1;
  if (meta.author && containsName(meta.author, names)) return 0.5;
  return 0;
}

/** Hashtag/caption words of a clip that point at a mustExclude term (explicit off-topic) - used as a hard filter by the ranker. */
export const isOffTopic = (profile: SubjectProfile, text: string | null | undefined): boolean => Boolean(text) && profile.mustExclude.some((term) => compact(term).length >= 2 && compact(text!).includes(compact(term)));

export const HIGH_PRIORITY_MAX = 1;

/**
 * Brief for ranking/vision. mustExclude -> `exclusions` (hard filter of `rankMediaCandidates`); aliases -> `subjectAliases` (ranking bonus);
 * `preferredAuthors` -> light cross-segment coherence. Only a high-priority segment (priority <= 1, i.e. the main subject) puts the
 * subject into `entities`, which is what the vision relevance is scored against (spends the VE2E-57 budget on what matters).
 */
export function applySubjectToBrief(brief: SceneBrief, profile: SubjectProfile, options: { priority?: number | null; preferredAuthors?: readonly string[] } = {}): SceneBrief {
  const names = subjectNames(profile);
  if (names.length === 0 && profile.mustExclude.length === 0) return brief;
  const exclusions = [...new Set([...brief.exclusions, ...profile.mustExclude.map((term) => term.toLowerCase())])];
  const highPriority = options.priority != null && options.priority <= HIGH_PRIORITY_MAX;
  const entities = highPriority ? [...new Set([...names.map((name) => name.toLowerCase()), ...brief.entities])] : brief.entities;
  return {
    ...brief,
    entities,
    exclusions,
    ...(names.length > 0 ? { subjectAliases: names } : {}),
    ...(options.preferredAuthors?.length ? { preferredAuthors: [...options.preferredAuthors] } : {}),
  };
}
