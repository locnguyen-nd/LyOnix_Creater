/**
 * VE2E-51: pure quality filter/ranking for social (TikTok) search results, applied to the dataset
 * fields BEFORE anything is downloaded (two-phase Apify flow). Evidence: owner job bb9b2449 -
 * an English keyword returned template/greenscreen/CapCut clips and foreign content
 * (`textLanguage=en|un`), while a Japanese keyword returned 100% `textLanguage=ja` with
 * `locationMeta.countryCode=1861060` (GeoNames id of Japan).
 *
 * Every reject carries a machine-readable reason so the diagnostics can say why nothing passed
 * (and the caller falls back to Pexels instead of taking a foreign clip).
 */

/** GeoNames id of Japan as reported in `locationMeta.countryCode` by the TikTok Actor. */
export const JAPAN_GEONAMES_ID = "1861060";

export type SocialCandidateSignals = {
  /** Platform video id (TikTok `id`). */
  videoId: string;
  text: string;
  hashtags: string[];
  /** `textLanguage` from the dataset (`ja`, `en`, `un` = undetermined, ...); `null` when absent. */
  textLanguage: string | null;
  /** `locationMeta.countryCode` (GeoNames id or ISO code); `null` when absent. */
  countryCode: string | null;
  isAd: boolean;
  isSponsored: boolean;
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
};

export type SocialRejectReason =
  | "already_used"
  | "ad_or_sponsored"
  | "template_or_greenscreen"
  | "language_mismatch"
  | "language_unverified"
  | "location_not_jp"
  | "not_vertical"
  | "duration_unknown"
  | "too_short";

export type SocialFilterContext = {
  /** Script language (`ja`, `ja-JP`, `vi`, ...). Language/location rules apply to `ja` scripts only. */
  scriptLanguage: string;
  keyword: string;
  /** Minimum source duration (the segment's duration): shorter sources would loop. */
  minDurationSeconds: number;
  /** Platform video ids already used by earlier segments of the plan (live set is fine). */
  usedVideoIds: ReadonlySet<string>;
};

export type SocialEvaluation = { ok: true; score: number; overlap: number } | { ok: false; reasons: SocialRejectReason[] };

const TEMPLATE_TEXT = /use this template|capcut[\s_-]*template|template|green[\s_-]*screen|テンプレ|グリーン(?:バック|スクリーン)|キャップカット/i;
const TEMPLATE_HASHTAGS = new Set(["capcut", "capcuttemplate", "capcuttemplates", "template", "templates", "greenscreen", "greenscreenvideo", "capcutedit", "テンプレ", "テンプレート"]);
const UNKNOWN_LANGUAGES = new Set(["", "un", "und", "unknown", "xx"]);

const isJapaneseScript = (language: string) => /^ja($|[-_])/i.test(language.trim());
const normLang = (value: string | null) => (value ?? "").trim().toLowerCase().split(/[-_]/)[0]!;

export const isJapanCountry = (countryCode: string | null): boolean => {
  const value = (countryCode ?? "").trim();
  return value === JAPAN_GEONAMES_ID || /^jp$/i.test(value);
};

/** Keyword tokens: whitespace-separated words, lower-cased, dropping 1-char noise. */
const keywordTokens = (keyword: string): string[] => [...new Set(keyword.toLowerCase().split(/[\s、,，/]+/).map((t) => t.trim()).filter((t) => t.length >= 2))];

/** 0..1: share of keyword tokens found in the caption/hashtags (CJK tokens also match through their character bigrams). */
export function keywordOverlap(keyword: string, text: string, hashtags: readonly string[]): number {
  const tokens = keywordTokens(keyword);
  if (tokens.length === 0) return 0;
  const haystack = `${text} ${hashtags.join(" ")}`.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      hits += 1;
      continue;
    }
    if (/[぀-ヿ㐀-鿿]/.test(token) && token.length >= 3) {
      const bigrams = Array.from({ length: token.length - 1 }, (_, i) => token.slice(i, i + 2));
      const found = bigrams.filter((bigram) => haystack.includes(bigram)).length;
      hits += found / bigrams.length > 0.5 ? 0.5 : 0;
    }
  }
  return Math.min(1, hits / tokens.length);
}

export function evaluateSocialCandidate(signals: SocialCandidateSignals, ctx: SocialFilterContext): SocialEvaluation {
  const reasons: SocialRejectReason[] = [];
  if (ctx.usedVideoIds.has(signals.videoId)) reasons.push("already_used");
  if (signals.isAd || signals.isSponsored) reasons.push("ad_or_sponsored");
  const tags = signals.hashtags.map((tag) => tag.replace(/^#/, "").trim().toLowerCase());
  if (TEMPLATE_TEXT.test(signals.text) || tags.some((tag) => TEMPLATE_HASHTAGS.has(tag) || TEMPLATE_TEXT.test(tag))) reasons.push("template_or_greenscreen");

  const ja = isJapaneseScript(ctx.scriptLanguage);
  const lang = normLang(signals.textLanguage);
  const jp = isJapanCountry(signals.countryCode);
  if (ja) {
    if (lang === "ja") {
      // affirmative Japanese caption; a known non-Japan location still disqualifies (owner: JP content only)
    } else if (UNKNOWN_LANGUAGES.has(lang)) {
      if (!jp) reasons.push("language_unverified");
    } else {
      reasons.push("language_mismatch");
    }
    if (signals.countryCode && !jp) reasons.push("location_not_jp");
  }

  if (signals.widthPx !== null && signals.heightPx !== null && signals.heightPx <= signals.widthPx) reasons.push("not_vertical");
  if (signals.durationSeconds === null || signals.durationSeconds <= 0) reasons.push("duration_unknown");
  else if (signals.durationSeconds + 0.05 < ctx.minDurationSeconds) reasons.push("too_short");

  if (reasons.length > 0) return { ok: false, reasons };

  const overlap = keywordOverlap(ctx.keyword, signals.text, signals.hashtags);
  const duration = signals.durationSeconds!;
  // Prefer a source comfortably longer than the segment (room for a clean window), not an endless one.
  const fit = ctx.minDurationSeconds > 0 ? Math.min(1, duration / (ctx.minDurationSeconds * 1.5)) : 1;
  const score = overlap * 0.5 + (lang === "ja" ? 0.2 : 0) + (jp ? 0.15 : 0) + fit * 0.15;
  return { ok: true, score: Math.round(score * 1000) / 1000, overlap };
}

export type SocialSelection<T> = {
  passed: Array<{ ref: T; videoId: string; score: number; overlap: number }>;
  rejected: Array<{ videoId: string; reasons: SocialRejectReason[] }>;
  rejectCounts: Record<string, number>;
};

/** Evaluates every item; `passed` is best-first (score desc, then input order = platform relevance order). */
export function selectSocialCandidates<T>(items: ReadonlyArray<{ ref: T; signals: SocialCandidateSignals }>, ctx: SocialFilterContext): SocialSelection<T> {
  const passed: SocialSelection<T>["passed"] = [];
  const rejected: SocialSelection<T>["rejected"] = [];
  const rejectCounts: Record<string, number> = {};
  const order = new Map<string, number>();
  items.forEach(({ ref, signals }, index) => {
    const evaluation = evaluateSocialCandidate(signals, ctx);
    if (evaluation.ok) {
      order.set(signals.videoId, index);
      passed.push({ ref, videoId: signals.videoId, score: evaluation.score, overlap: evaluation.overlap });
    } else {
      rejected.push({ videoId: signals.videoId, reasons: evaluation.reasons });
      for (const reason of evaluation.reasons) rejectCounts[reason] = (rejectCounts[reason] ?? 0) + 1;
    }
  });
  passed.sort((a, b) => b.score - a.score || (order.get(a.videoId) ?? 0) - (order.get(b.videoId) ?? 0));
  return { passed, rejected, rejectCounts };
}
