/**
 * VE2E-147/148 (CR-MEDIA-OSS-FETCH §3.4): filter + rank the metadata-only results of a yt-dlp (YouTube Shorts) or gallery-dl (Pinterest /
 * X) search before anything is downloaded. Pure and source-neutral (structural input type, no dependency on the job contract).
 *
 * Rules, all based on what the search returned (no vision call here - the downloaded clip still goes through the normal checks):
 * - never a post this job already uses (`usedIds`, the live ledger set), never the wrong media kind;
 * - video: duration known -> within [segment duration x 0.9, `maxDurationSeconds`] (Shorts are short; a long video would mean a
 *   big download for a few seconds of footage); clearly landscape (known size) is rejected for video, only penalised for images;
 * - subject gate (same idea as VE2E-142): when the video has a named subject, a result whose title / description / channel / tags never
 *   names it is off-topic and rejected;
 * - score = subject hits x 3 + keyword-token overlap + Shorts URL + vertical + a small popularity term.
 * - person mode (`context.person`): subject hits are replaced by the person identity x 4 (a short name without the group/team counts
 *   less: same-name people), news / quote / meme / group results lose score and close-ups gain, so a group photo or a news card is
 *   only taken when no single-person result exists.
 */
import { matchPersonIdentity, personMetadataFlags, type PersonTarget } from "./person-target.js";

export type SocialSearchCandidate = {
  url: string;
  externalId: string | null;
  mediaType: "video" | "image";
  title: string | null;
  description: string | null;
  uploader: string | null;
  channel: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  viewCount: number | null;
  tags: string[];
};

export type SocialSearchRejectReason = "used" | "wrong_type" | "too_short" | "too_long" | "landscape" | "off_subject" | "no_id";

export type SocialSearchSelection<T extends SocialSearchCandidate> = {
  /** `personIdentity` (person mode only): how strongly the result's metadata names the person (VE2E-151 diagnostics). */
  passed: Array<{ item: T; score: number; subjectHits: number; personIdentity?: { level: string; score: number } }>;
  rejectCounts: Partial<Record<SocialSearchRejectReason, number>>;
};

const norm = (text: string): string => text.normalize("NFKC").toLowerCase();

/** Tokens of a keyword phrase: whitespace words, plus the whole phrase for scripts without spaces (ja). */
const keywordTokens = (keywords: readonly string[]): string[] => {
  const out = new Set<string>();
  for (const k of keywords) {
    const n = norm(k).trim();
    if (!n) continue;
    out.add(n);
    for (const part of n.split(/[\s　,、]+/)) if (part.length >= 2) out.add(part);
  }
  return [...out];
};

/** Person-mode term of one search result: identity x 4, minus news 2 / quote-meme card 3 / group 1.5 / other person 1.5, plus close-up 1. */
const personSearchTerm = (person: PersonTarget, item: SocialSearchCandidate): { term: number; identity: { level: string; score: number } } => {
  const meta = { text: [item.title, item.description, ...item.tags.map((tag) => `#${tag}`)].filter(Boolean).join(" \n "), author: item.channel ?? item.uploader };
  const identity = matchPersonIdentity(person, meta);
  const flags = personMetadataFlags(person, meta);
  const term = identity.score * 4 - (flags.includes("news") ? 2 : 0) - (flags.includes("text_card") ? 3 : 0) - (flags.includes("group") ? 1.5 : 0) - (flags.includes("other_person") ? 1.5 : 0) + (flags.includes("close_up") ? 1 : 0);
  return { term, identity: { level: identity.level, score: identity.score } };
};

export const selectSocialSearchItems = <T extends SocialSearchCandidate>(
  items: readonly T[],
  context: {
    mediaType: "video" | "image";
    usedIds: ReadonlySet<string>;
    minDurationSeconds: number;
    maxDurationSeconds: number;
    subjectAliases: readonly string[];
    keywords: readonly string[];
    /** The subject is one person (person-focused ranking). */
    person?: PersonTarget | null;
  },
): SocialSearchSelection<T> => {
  const rejectCounts: SocialSearchSelection<T>["rejectCounts"] = {};
  const reject = (reason: SocialSearchRejectReason) => {
    rejectCounts[reason] = (rejectCounts[reason] ?? 0) + 1;
  };
  const aliases = context.subjectAliases.map(norm).filter((a) => a.trim().length >= 2);
  const tokens = keywordTokens(context.keywords);
  const passed: SocialSearchSelection<T>["passed"] = [];
  for (const item of items) {
    if (!item.externalId) { reject("no_id"); continue; }
    if (context.usedIds.has(item.externalId)) { reject("used"); continue; }
    if (item.mediaType !== context.mediaType) { reject("wrong_type"); continue; }
    if (item.mediaType === "video" && item.durationSeconds !== null) {
      if (item.durationSeconds < context.minDurationSeconds * 0.9) { reject("too_short"); continue; }
      if (item.durationSeconds > context.maxDurationSeconds) { reject("too_long"); continue; }
    }
    const known = item.width !== null && item.height !== null && item.width > 0 && item.height > 0;
    const landscape = known && item.width! > item.height! * 1.1;
    if (landscape && item.mediaType === "video") { reject("landscape"); continue; }
    const haystack = norm([item.title, item.description, item.channel, item.uploader, ...item.tags].filter(Boolean).join(" \n "));
    const subjectHits = aliases.filter((alias) => haystack.includes(alias)).length;
    if (aliases.length > 0 && subjectHits === 0) { reject("off_subject"); continue; }
    const overlap = tokens.filter((t) => haystack.includes(t)).length;
    const shortsUrl = /\/shorts\//.test(item.url) ? 1 : 0;
    const vertical = known && item.height! >= item.width! ? 0.5 : 0;
    const popularity = item.viewCount && item.viewCount > 0 ? Math.min(2, Math.log10(item.viewCount) * 0.3) : 0;
    const person = context.person ? personSearchTerm(context.person, item) : null;
    const subjectTerm = person ? person.term : subjectHits * 3;
    passed.push({ item, score: subjectTerm + overlap + shortsUrl + vertical + popularity - (landscape ? 1 : 0), subjectHits, ...(person ? { personIdentity: person.identity } : {}) });
  }
  passed.sort((a, b) => b.score - a.score);
  return { passed, rejectCounts };
};
