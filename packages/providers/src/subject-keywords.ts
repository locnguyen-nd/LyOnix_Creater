/**
 * VE2E-88 (CR-MEDIA-SLA-2026-10-07 §3.2 + §7 "Bổ sung"): subject-anchored, multi-tier search keywords.
 *
 * Owner rule: keywords must stay on the video's subject - a video about player A gets keywords about
 * A (name, team, match, related event); a story about B gets keywords about B. Every searchable tier
 * (ja / en / broad_en) must contain or be tied to the main subject (name or alias). `mood_en` is the
 * only tier allowed to be generic and is NEVER used to find the main clip (only L5/L6 backgrounds).
 *
 * Pure logic, no I/O. The heuristic only runs when the video subject is known; without one nothing is
 * rejected (backward compatible with plans/data stored before VE2E-88).
 */

export type VideoSubjectV2 = {
  /** The video's main subject (proper name: person, team, story, place). */
  main: string;
  aliases: string[];
  /** Extra anchor terms (team, event, match) - a phrase containing any of these also counts as on-subject. */
  mustInclude: string[];
  /** Terms that make a phrase off-subject (rival story, unrelated person). */
  mustExclude: string[];
};

export const SUBJECT_MAX_TEXT = 100;
export const SUBJECT_MAX_TERMS = 8;
export const KEYWORD_TIER_MAX_PHRASES = 2;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Lower-case, NFKC, diacritics stripped, punctuation -> space, whitespace collapsed. */
export const normalizeSubjectText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const stringList = (value: unknown, maxItems: number): string[] => {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > SUBJECT_MAX_TEXT || out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) continue;
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
};

/** Tolerant parse of the model's / stored `videoSubject`. A plain string is the main subject. `null` when there is no usable main subject. */
export function parseVideoSubject(raw: unknown): VideoSubjectV2 | null {
  if (typeof raw === "string") {
    const main = raw.trim();
    return main && main.length <= SUBJECT_MAX_TEXT ? { main, aliases: [], mustInclude: [], mustExclude: [] } : null;
  }
  const row = asRecord(raw);
  if (!row) return null;
  const main = typeof row.main === "string" ? row.main.trim() : "";
  if (!main || main.length > SUBJECT_MAX_TEXT) return null;
  const mustExclude = stringList(row.mustExclude ?? row.must_exclude, SUBJECT_MAX_TERMS);
  return {
    main,
    aliases: stringList(row.aliases, SUBJECT_MAX_TERMS),
    mustInclude: stringList(row.mustInclude ?? row.must_include, SUBJECT_MAX_TERMS),
    mustExclude,
  };
}

const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\s]+$/u;

/** Normalized anchor terms: every full name/alias/mustInclude, plus each latin word >= 3 chars of main/aliases (so "Mbappe goal" matches "Kylian Mbappé"). */
export function subjectAnchorTerms(subject: VideoSubjectV2): string[] {
  const terms = new Set<string>();
  for (const full of [subject.main, ...subject.aliases, ...subject.mustInclude]) {
    const normalized = normalizeSubjectText(full);
    if (!normalized) continue;
    terms.add(normalized.replace(/\s+/g, " "));
  }
  for (const name of [subject.main, ...subject.aliases]) {
    const normalized = normalizeSubjectText(name);
    if (!LATIN_ONLY.test(normalized)) continue;
    for (const word of normalized.split(" ")) if (word.length >= 3) terms.add(word);
  }
  return [...terms];
}

const containsTerm = (haystack: string, term: string): boolean => {
  if (!term) return false;
  // CJK has no spaces: compare with spaces removed too.
  if (LATIN_ONLY.test(term)) return ` ${haystack} `.includes(` ${term} `);
  return haystack.replace(/ /g, "").includes(term.replace(/ /g, ""));
};

/** Whether a search phrase is anchored on the subject (name, alias or mustInclude term). */
export function phraseMatchesSubject(phrase: string, subject: VideoSubjectV2): boolean {
  const normalized = normalizeSubjectText(phrase);
  if (!normalized) return false;
  return subjectAnchorTerms(subject).some((term) => containsTerm(normalized, term));
}

/** Whether a phrase hits a mustExclude term. */
export function phraseHitsExclusion(phrase: string, subject: VideoSubjectV2): boolean {
  const normalized = normalizeSubjectText(phrase);
  if (!normalized) return false;
  return subject.mustExclude.some((term) => containsTerm(normalized, normalizeSubjectText(term)));
}

/** Keeps phrases that are on-subject and not excluded (no subject => keeps all). */
export function filterPhrasesBySubject(phrases: readonly string[], subject: VideoSubjectV2 | null): string[] {
  if (!subject) return [...phrases];
  return phrases.filter((phrase) => !phraseHitsExclusion(phrase, subject) && phraseMatchesSubject(phrase, subject));
}

/** Prompt lines shared by the script prompt and the extract_keywords prompt. */
export function subjectKeywordRuleLines(subject?: VideoSubjectV2 | null): string[] {
  const lines = [
    "SUBJECT RULE (hard): every searchable keyword (ja, en, broad_en) must stay on the video's MAIN SUBJECT. If the video is about player A, every keyword is about A (A's name, A's team, A's match, an event involving A); if it is a story about B, every keyword is about B. Put the subject's proper name (or an alias) inside each ja/en/broad_en phrase - never a generic phrase like \"stadium crowd\" or \"city street\" without the subject.",
    "broad_en is a WIDER topic but still tied to the subject (example: \"<subject name> match highlights\"), never an unrelated generic scene. mood_en is a generic background mood (example: \"city night timelapse\") used only as a last-resort backdrop, never to find the main clip.",
  ];
  if (subject) {
    lines.push(
      `Known subject: ${subject.main}${subject.aliases.length ? ` (aliases: ${subject.aliases.join(", ")})` : ""}.${subject.mustInclude.length ? ` Related anchor terms: ${subject.mustInclude.join(", ")}.` : ""}${subject.mustExclude.length ? ` Never use: ${subject.mustExclude.join(", ")}.` : ""}`,
    );
  }
  return lines;
}
