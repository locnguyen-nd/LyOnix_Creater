/**
 * VE2E-15a: source-neutral scene-beat media ranking and safe abstention.
 *
 * Pure logic only (no network I/O, no provider secret handling) - this replaces the old
 * "always try video first, take the first result" auto-import shortcut noted in
 * VE2E-PROVIDER-UX.md §1/§5 with real narrative-beat-aware ranking. It also supersedes the
 * duration/orientation-only heuristic in `apps/web/src/studio/media-selection.ts`: that file
 * now delegates its scoring to `rankMediaCandidates` below so there is exactly one ranking
 * system, not two competing ones.
 *
 * Known, explicitly accepted limitation: there is no live human-labeled scene-beat benchmark
 * dataset available in this sandbox. `MEDIA_RELEVANCE_THRESHOLD` and the ranking weights below
 * are documented, versioned defaults, not values tuned against real retention/relevance data -
 * Test/owner must validate and retune them against an agreed benchmark before trusting Auto's
 * abstention boundary in production (spec §5 acceptance: "Auto chooses only above a threshold
 * validated on an agreed scene benchmark").
 *
 * Entity/action/setting/mood extraction below is heuristic keyword-bucket classification against
 * small curated term lists (English/Vietnamese) - it is not linguistic NLP/POS tagging (none is
 * available in this codebase/sandbox). Japanese/Korean text without inter-word spaces is not
 * segmented into individual words; phrase-level query variants still work for those languages
 * (the raw `visualQuery`/`screenText` strings are preserved verbatim, never translated), but the
 * `entities`/`action`/`setting`/`mood` buckets stay coarse (see `bucketize`) for ja/ko.
 */
import { subjectMatchScore } from "./subject-filter.js";
import { isRightsUsableForAuto } from "./media-candidate.js";
import type {
  MediaCandidate,
  MediaCandidateType,
  VisionFindings,
  VisionModerationDecision,
} from "./media-candidate.js";

// --- narrative beat + scene brief ---

export const narrativeBeats = ["hook", "explanation_evidence", "transition", "payoff"] as const;
export type NarrativeBeat = (typeof narrativeBeats)[number];

/** Duck-typed scene shape matching `ScriptDraftSceneV2`/`StudioSceneContextResponse` structurally - domain never imports from `@lyonix/providers` or `@lyonix/contracts` to avoid a circular/upward dependency. */
export type SceneBriefSourceScene = {
  sceneId: string;
  narration: string;
  screenText: string;
  visualQuery: string;
  durationHintMs: number;
};

export type SceneBriefSourceScript = {
  /** Script's own detected language (vi/en/ja/ko/...) - never forced to Vietnamese (spec §5). */
  language: string;
  scenes: readonly SceneBriefSourceScene[];
};

export type SceneBrief = {
  sceneId: string;
  beat: NarrativeBeat;
  language: string;
  entities: string[];
  action: string[];
  setting: string[];
  mood: string[];
  exclusions: string[];
  /** Bounded, script-language search phrases (no translation) - feed `buildBoundedQueryVariants`. */
  phrases: string[];
  shotIntent: string;
  verticalOnly: boolean;
  targetDurationSeconds: number;
  /** VE2E-89: names/aliases of the video's main subject; a caption/hashtag/author hit adds {@link SUBJECT_MATCH_WEIGHT} to the combined score (ranking signal only). */
  subjectAliases?: string[];
  /** VE2E-89: authors of clips already chosen for the subject in this job; a tiny coherence bonus for a subject-matching clip of the same author. */
  preferredAuthors?: string[];
};

export type SceneBriefOptions = {
  /** A scene at/under this duration (ms) that is neither first nor last is treated as a fast `transition` cut rather than `explanation_evidence`. */
  transitionMaxDurationMs?: number;
  verticalOnly?: boolean;
};

const DEFAULT_TRANSITION_MAX_MS = 2500;

/** Unicode-letter/number tokenizer (works across vi/en/ja/ko scripts); see file header for the CJK word-boundary caveat. */
const WORD_RE = /[\p{L}\p{N}]+/gu;

const STOPWORDS: ReadonlySet<string> = new Set([
  // English function words
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "with", "and", "or", "is", "are", "was",
  "were", "be", "this", "that", "it", "its", "as", "by", "from", "into", "over", "under", "than",
  // Vietnamese function words
  "là", "và", "của", "cho", "trong", "trên", "dưới", "một", "các", "những", "này", "đó", "với",
  "được", "có", "khi", "để", "rất", "cũng", "bị", "sẽ", "đã", "đang", "thì", "mà", "như",
]);

export const tokenizeSceneText = (text: string): string[] =>
  (text.match(WORD_RE) ?? []).map((w) => w.toLowerCase()).filter((w) => w.length > 1 && !STOPWORDS.has(w));

/** Small curated bucket dictionaries (en+vi) - see file header: heuristic, not NLP. Unmatched non-stopword tokens fall into `entities`. */
const ACTION_TERMS = new Set([
  "walking", "running", "talking", "speaking", "holding", "driving", "cooking", "dancing", "jumping",
  "working", "writing", "reading", "eating", "drinking", "smiling", "laughing", "pointing", "typing",
  "playing", "singing", "riding", "climbing", "swimming", "building", "cleaning", "presenting",
  "đi", "chạy", "nói", "cầm", "lái", "nấu", "nhảy", "làm", "viết", "đọc", "ăn", "uống", "cười",
  "chỉ", "gõ", "chơi", "hát", "leo", "bơi", "xây", "dọn", "trình bày", "đứng", "ngồi",
]);
const SETTING_TERMS = new Set([
  "beach", "office", "kitchen", "street", "forest", "city", "room", "studio", "park", "mountain",
  "river", "ocean", "home", "school", "market", "restaurant", "cafe", "gym", "stadium", "garden",
  "bãi biển", "văn phòng", "nhà bếp", "đường phố", "rừng", "thành phố", "phòng", "công viên",
  "núi", "sông", "biển", "nhà", "trường", "chợ", "nhà hàng", "quán cà phê", "phòng gym", "sân vận động",
]);
const MOOD_TERMS = new Set([
  "happy", "sad", "dramatic", "calm", "exciting", "energetic", "peaceful", "tense", "joyful",
  "serious", "funny", "inspiring", "emotional", "relaxing", "intense",
  "vui", "buồn", "kịch tính", "yên bình", "hào hứng", "năng động", "căng thẳng", "nghiêm túc",
  "hài hước", "truyền cảm hứng", "xúc động", "thư giãn", "mãnh liệt",
]);

const dedupe = (arr: string[]) => [...new Set(arr)];

const bucketize = (tokens: string[]) => {
  const action: string[] = [];
  const setting: string[] = [];
  const mood: string[] = [];
  const entities: string[] = [];
  for (const token of tokens) {
    if (ACTION_TERMS.has(token)) action.push(token);
    else if (SETTING_TERMS.has(token)) setting.push(token);
    else if (MOOD_TERMS.has(token)) mood.push(token);
    else entities.push(token);
  }
  return { action: dedupe(action), setting: dedupe(setting), mood: dedupe(mood), entities: dedupe(entities) };
};

const MAX_EXCLUSIONS = 5;
/**
 * Bounded regex scan for explicit negative constraints ("no X" / "without (any) X" /
 * "không (có) X" / "tránh X"). Captures a single following noun token (skipping a filler word
 * like "any"/"a"/"an") - not full negation parsing, deliberately simple and auditable rather
 * than a multi-word phrase grab that could swallow unrelated following text.
 */
const EXCLUSION_PATTERNS: RegExp[] = [
  /\b(?:no|without|exclude|excluding|avoid|avoiding)\s+(?:any|a|an)?\s*([a-z0-9]+)/gi,
  /\bkhông\s+(?:có|dùng|xuất hiện)?\s*([\p{L}0-9]+)/giu,
  /\btránh\s+([\p{L}0-9]+)/giu,
];

const extractExclusions = (text: string): string[] => {
  const found: string[] = [];
  for (const pattern of EXCLUSION_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while (found.length < MAX_EXCLUSIONS && (match = pattern.exec(text))) {
      const phrase = match[1]?.trim().toLowerCase();
      if (phrase) found.push(phrase);
    }
  }
  return dedupe(found).slice(0, MAX_EXCLUSIONS);
};

/** First/only scene is always `hook`; last (when more than one) is always `payoff`; a short middle scene is a `transition` cut, otherwise `explanation_evidence`. Deterministic, position-based - no ML classification. */
export function deriveNarrativeBeat(
  sceneIndex: number,
  totalScenes: number,
  durationHintMs: number,
  options: SceneBriefOptions = {},
): NarrativeBeat {
  if (totalScenes <= 1 || sceneIndex <= 0) return "hook";
  if (sceneIndex >= totalScenes - 1) return "payoff";
  const transitionMax = options.transitionMaxDurationMs ?? DEFAULT_TRANSITION_MAX_MS;
  return durationHintMs > 0 && durationHintMs <= transitionMax ? "transition" : "explanation_evidence";
}

const MAX_PHRASES = 3;

/** Derives one scene's brief from the full script + scene index. Throws on an out-of-range index (programmer error, not a runtime/user input path). */
export function deriveSceneBrief(script: SceneBriefSourceScript, sceneIndex: number, options: SceneBriefOptions = {}): SceneBrief {
  const scene = script.scenes[sceneIndex];
  if (!scene) throw new RangeError(`deriveSceneBrief: sceneIndex ${sceneIndex} out of range (0..${script.scenes.length - 1})`);
  const beat = deriveNarrativeBeat(sceneIndex, script.scenes.length, scene.durationHintMs, options);
  const combinedText = [scene.visualQuery, scene.screenText, scene.narration].filter(Boolean).join(" ");
  const tokens = tokenizeSceneText(combinedText);
  const { action, setting, mood, entities } = bucketize(tokens);
  const exclusions = extractExclusions(combinedText);
  // An exclusion is a "must not include" constraint, not a search hint - never let it leak back into the positive-signal buckets.
  const dropExcluded = (arr: string[]) => arr.filter((term) => !exclusions.some((ex) => ex.includes(term) || term.includes(ex)));

  const phraseCandidates = [scene.visualQuery.trim(), scene.screenText.trim(), tokens.slice(0, 8).join(" ")].filter(Boolean);
  const seenPhrase = new Set<string>();
  const phrases: string[] = [];
  for (const phrase of phraseCandidates) {
    const key = phrase.toLowerCase();
    if (seenPhrase.has(key)) continue;
    seenPhrase.add(key);
    phrases.push(phrase);
    if (phrases.length >= MAX_PHRASES) break;
  }

  return {
    sceneId: scene.sceneId,
    beat,
    language: script.language,
    entities: dropExcluded(entities).slice(0, 12),
    action: dropExcluded(action).slice(0, 8),
    setting: dropExcluded(setting).slice(0, 8),
    mood: dropExcluded(mood).slice(0, 8),
    exclusions,
    phrases: phrases.length ? phrases : [scene.narration.trim()].filter(Boolean),
    shotIntent: (scene.screenText || scene.narration).trim().slice(0, 200),
    verticalOnly: options.verticalOnly ?? true,
    targetDurationSeconds: Math.max(0, scene.durationHintMs / 1000),
  };
}

/** Lightweight Unicode-range fallback used only when a caller has no authoritative `ScriptDraftV2.language` at hand (e.g. a legacy Studio bridge context) - never used to force-translate a query, only to pick which script the query phrases are already written in. */
export function detectScriptLanguageHeuristic(text: string): "vi" | "en" | "ja" | "ko" {
  if (/[぀-ヿㇰ-ㇿ]/.test(text)) return "ja"; // hiragana/katakana
  if (/[가-힯]/.test(text)) return "ko"; // hangul syllables
  if (/[一-鿿]/.test(text)) return "ja"; // kanji-only text (this project has no standalone zh locale)
  if (/[à-ỉđĐ]/i.test(text)) return "vi"; // Vietnamese diacritics
  return "en";
}

export const MAX_QUERY_VARIANTS = 3;

/** Bounded query-variant generation from the brief's own script-language phrases - never an unbounded fan-out, never a translated phrase. */
export function buildBoundedQueryVariants(brief: SceneBrief, max = MAX_QUERY_VARIANTS): string[] {
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const phrase of brief.phrases) {
    const trimmed = phrase.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(trimmed);
    if (variants.length >= max) break;
  }
  return variants;
}

// --- ranking ---

export const MEDIA_RANKING_POLICY_VERSION = "media-ranking-policy.v1";

/** Priority order per spec §5: semantic/visual fit first, then continuity+short-clip usability, then quality, then cost. */
export const MEDIA_RANKING_WEIGHTS = { semantic: 0.45, continuity: 0.25, quality: 0.2, cost: 0.1 } as const;

/**
 * No live benchmark dataset exists in this sandbox (see file header). This default is a
 * documented placeholder, not a validated production threshold - Test/owner must retune against
 * a real human-labeled scene-beat benchmark (spec §5 acceptance).
 */
export const MEDIA_RELEVANCE_THRESHOLD = 0.45;

export type MediaRankingOptions = {
  usedExternalIds?: ReadonlySet<string>;
  allowedTypes?: readonly MediaCandidateType[];
};

/** VE2E-89: max boost of a subject metadata match / of same-author coherence (only with a subject-matching clip). */
export const SUBJECT_MATCH_WEIGHT = 0.15;
export const SUBJECT_COHERENCE_WEIGHT = 0.04;

export type RankedMediaCandidate = {
  candidate: MediaCandidate;
  /** VE2E-89: 0..1 subject metadata match (absent without `brief.subjectAliases`). */
  subjectMatch?: number;
  semanticScore: number;
  /** False when `semanticScore` is only the blind `NEUTRAL_SEMANTIC_SCORE` default (no descriptor text, no vision findings) - i.e. we have literally no evidence the candidate matches the scene, as opposed to having checked and found a middling match. `decideMediaSelection` must never auto-select on this alone (spec §5: "do not label them as visually verified or let Auto silently accept a weak match"). */
  hasVerifiedSemanticSignal: boolean;
  continuityScore: number;
  qualityScore: number;
  costScore: number;
  combinedScore: number;
  excludedReason?: string;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const sceneBriefKeyTerms = (brief: SceneBrief): string[] =>
  dedupe([...brief.entities, ...brief.action, ...brief.setting, ...brief.mood]);

const jaccardOverlap = (a: readonly string[], b: readonly string[]): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const term of setA) if (setB.has(term)) intersection += 1;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
};

/** No descriptive metadata for this candidate (e.g. Pexels video search returns no alt/tags) -> neutral, not full-credit and not zero, so continuity/quality/cost still differentiate same-type candidates instead of every score collapsing to one value. */
const NEUTRAL_SEMANTIC_SCORE = 0.5;

const computeSemanticScore = (candidate: MediaCandidate, brief: SceneBrief): number => {
  const keyTerms = sceneBriefKeyTerms(brief);
  let metadataSemantic = NEUTRAL_SEMANTIC_SCORE;
  if (candidate.descriptorText?.trim()) {
    const descriptorTokens = tokenizeSceneText(candidate.descriptorText);
    // Rescaled (x2, clamped): raw Jaccard over short phrase sets rarely exceeds ~0.3-0.4 even for a strong match.
    metadataSemantic = keyTerms.length ? clamp01(jaccardOverlap(keyTerms, descriptorTokens) * 2) : NEUTRAL_SEMANTIC_SCORE;
  }
  // VE2E-24 vision findings, when attached, are the stronger signal (real visual inspection vs metadata keyword overlap).
  if (candidate.visionFindings && candidate.visionFindings.sceneBeatRelevance !== null) {
    return clamp01(0.3 * metadataSemantic + 0.7 * candidate.visionFindings.sceneBeatRelevance);
  }
  return metadataSemantic;
};

/** True only when the semantic score above is backed by real evidence (candidate metadata text, or a real vision inspection) rather than the blind neutral default. */
const hasVerifiedSemanticSignal = (candidate: MediaCandidate): boolean =>
  Boolean(candidate.descriptorText?.trim()) || (candidate.visionFindings != null && candidate.visionFindings.sceneBeatRelevance !== null);

const candidateAuthor = (candidate: MediaCandidate): string | null => candidate.attribution?.name ?? candidate.provenance?.apify?.author ?? null;

const computeSubjectMatch = (candidate: MediaCandidate, brief: SceneBrief): number =>
  brief.subjectAliases?.length ? subjectMatchScore({ subject: null, aliases: brief.subjectAliases, mustInclude: [], mustExclude: [] }, { text: candidate.descriptorText, author: candidateAuthor(candidate) }) : 0;

/** A candidate whose own descriptive text matches an explicit scene exclusion is a hard filter, not just a low score - only checkable when the source provides descriptive text at all. */
const matchesExclusion = (candidate: MediaCandidate, brief: SceneBrief): boolean => {
  if (brief.exclusions.length === 0 || !candidate.descriptorText) return false;
  const descriptorTokens = new Set(tokenizeSceneText(candidate.descriptorText));
  const descriptorLower = candidate.descriptorText.toLowerCase();
  return brief.exclusions.some((term) => descriptorTokens.has(term) || descriptorLower.includes(term));
};

const computeContinuityScore = (candidate: MediaCandidate, brief: SceneBrief): number => {
  const orientationFit = candidate.widthPx && candidate.heightPx
    ? (brief.verticalOnly ? (candidate.heightPx > candidate.widthPx ? 1 : 0.3) : 1)
    : 0.5;
  if (candidate.mediaType !== "video") return orientationFit;
  const duration = candidate.durationSeconds ?? 0;
  if (brief.targetDurationSeconds <= 0 || duration <= 0) return clamp01(0.5 * orientationFit + 0.25);
  const longEnough = duration >= brief.targetDurationSeconds;
  const normalizedGap = clamp01(Math.abs(duration - brief.targetDurationSeconds) / Math.max(brief.targetDurationSeconds, 1));
  // A clip that already covers the scene's target duration avoids Creatomate looping/freezing a
  // too-short source (same reasoning as the superseded `pickBestVideoCandidate`), so it is always
  // scored above an equally-far too-short clip - but a huge overshoot is still mildly penalized so
  // a closer-fitting long-enough clip outranks a much longer one (`pickBestVideoCandidate`'s
  // "closest duration instead of the longest" preference, preserved here).
  const durationFit = longEnough ? clamp01(1 - 0.3 * normalizedGap) : clamp01(1 - normalizedGap);
  return clamp01(0.5 * orientationFit + 0.5 * durationFit);
};

const computeQualityScore = (candidate: MediaCandidate): number => {
  if (!candidate.heightPx) return 0.5;
  // This is the ranking score's height target, not the import file floor. Pexels import picks
  // the smallest video file whose short side is at least 1080 pixels.
  const target = candidate.mediaType === "video" ? 1280 : 1080;
  return clamp01(candidate.heightPx / target);
};

/** No per-source cost data exists yet (current sources - Pexels, YouTube discovery - are free-tier); documented hook for a future paid source (VE2E-15b/17), not a real signal today. */
const computeCostScore = (_candidate: MediaCandidate): number => 1;

/**
 * Ranks candidates for one scene brief. Never mutates input candidates. Already-used external
 * ids (continuity across scenes in the same video) and disallowed media types are filtered out
 * before scoring, not merely down-ranked - mirrors the pre-existing `usedExternalIds` contract in
 * `apps/web/src/studio/media-selection.ts`.
 */
export function rankMediaCandidates(
  candidates: readonly MediaCandidate[],
  brief: SceneBrief,
  options: MediaRankingOptions = {},
): RankedMediaCandidate[] {
  const used = options.usedExternalIds ?? new Set<string>();
  const allowed = options.allowedTypes;
  return candidates
    .filter((c) => !used.has(c.externalId))
    .filter((c) => !allowed || allowed.includes(c.mediaType))
    .map((candidate): RankedMediaCandidate => {
      const semanticScore = computeSemanticScore(candidate, brief);
      const continuityScore = computeContinuityScore(candidate, brief);
      const qualityScore = computeQualityScore(candidate);
      const costScore = computeCostScore(candidate);
      const excluded = matchesExclusion(candidate, brief);
      const subjectMatch = computeSubjectMatch(candidate, brief);
      const author = candidateAuthor(candidate)?.toLowerCase();
      const coherence = subjectMatch > 0 && author && brief.preferredAuthors?.some((name) => name.toLowerCase() === author) ? SUBJECT_COHERENCE_WEIGHT : 0;
      const combinedRaw =
        MEDIA_RANKING_WEIGHTS.semantic * semanticScore +
        MEDIA_RANKING_WEIGHTS.continuity * continuityScore +
        MEDIA_RANKING_WEIGHTS.quality * qualityScore +
        MEDIA_RANKING_WEIGHTS.cost * costScore +
        SUBJECT_MATCH_WEIGHT * subjectMatch +
        coherence;
      return {
        candidate,
        ...(brief.subjectAliases?.length ? { subjectMatch } : {}),
        semanticScore,
        // A caption/hashtag naming the subject is real metadata evidence (VE2E-89), not the blind neutral default.
        hasVerifiedSemanticSignal: hasVerifiedSemanticSignal(candidate) || subjectMatch >= 1,
        continuityScore,
        qualityScore,
        costScore,
        combinedScore: excluded ? 0 : clamp01(combinedRaw),
        ...(excluded ? { excludedReason: "matches_exclusion" } : {}),
      };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore);
}

// --- safe abstention decision ---

export type MediaSelectionAbstentionReason =
  | "no_candidates"
  | "below_relevance_threshold"
  | "unverified_relevance"
  | "rights_unresolved"
  | "not_auto_eligible"
  | "rejected_by_moderation";

export type MediaSelectionDecision =
  | { decision: "auto_select"; chosen: MediaCandidate; ranked: RankedMediaCandidate[] }
  | { decision: "needs_input"; reason: MediaSelectionAbstentionReason; ranked: RankedMediaCandidate[] };

export type MediaSelectionOptions = {
  relevanceThreshold?: number;
  /**
   * When true, a non-video candidate whose semantic score is only the blind neutral default (no
   * descriptor text, no vision findings) can never be `auto_select`ed, regardless of how well it
   * scores on continuity/quality/cost - this is the spec §5 "no vision-capable account configured"
   * guard, meant for a fully unattended caller (Auto's `autoImportForScene`) where nothing else
   * stands between this pick and the final render. Left `false` (default) for a human-supervised
   * picker (e.g. Studio's "auto-fill" convenience helper, `apps/web/src/studio/media-selection.ts`)
   * where the operator reviews and can replace the pick before anything renders - unchanged prior
   * behavior there.
   *
   * Deliberately scoped to non-video candidates only: Pexels' video search returns no alt/tag text
   * at all (`pexelsVideoToMediaCandidate` always sets `descriptorText: null` - a real provider
   * limitation, not a bug), and real per-frame vision verification needs frame extraction that only
   * `apps/media-worker` can run (FFmpeg never runs in an HTTP request) - infrastructure that does
   * not exist yet. Gating video the same way as images here would make Auto abstain to
   * `needs_input` on nearly every video-based scene, defeating its "no human gate" purpose for its
   * primary media type. Photo candidates DO carry real Pexels alt text, so gating them is a real,
   * immediately-available accuracy improvement. Video-specific relevance verification remains a
   * known gap for a follow-up task once vision+frame-extraction wiring exists.
   */
  requireVerifiedSemanticSignal?: boolean;
};

/**
 * Walks the ranked list (already sorted best-first) looking for the first candidate that is
 * simultaneously: not rejected by vision moderation, at/above the relevance threshold, rights
 * `cleared`, and `eligibility.autoEligible` - plus, when `requireVerifiedSemanticSignal` is set, a
 * non-video candidate must also be backed by a real (non-blind) relevance signal (see that option's
 * own doc comment for why video is exempted). A merely-rejected, unverified, or rights-unclear top
 * candidate does not abort the whole scene if a lower-ranked candidate is fully usable - but Auto
 * never silently falls back to a candidate below the relevance threshold, no matter its rank.
 */
export function decideMediaSelection(ranked: readonly RankedMediaCandidate[], options: MediaSelectionOptions = {}): MediaSelectionDecision {
  const threshold = options.relevanceThreshold ?? MEDIA_RELEVANCE_THRESHOLD;
  const list = [...ranked];
  if (list.length === 0) return { decision: "needs_input", reason: "no_candidates", ranked: list };
  let sawBelowThreshold = false;
  let sawUnverified = false;
  let sawRightsUnresolved = false;
  let sawIneligible = false;
  let sawRejected = false;
  for (const entry of list) {
    if (entry.candidate.moderationDecision === "rejected") {
      sawRejected = true;
      continue;
    }
    if (options.requireVerifiedSemanticSignal && entry.candidate.mediaType !== "video" && !entry.hasVerifiedSemanticSignal) {
      sawUnverified = true;
      continue;
    }
    if (entry.combinedScore < threshold) {
      sawBelowThreshold = true;
      continue;
    }
    if (!isRightsUsableForAuto(entry.candidate.rightsStatus)) {
      sawRightsUnresolved = true;
      continue;
    }
    if (!entry.candidate.eligibility.autoEligible) {
      sawIneligible = true;
      continue;
    }
    return { decision: "auto_select", chosen: entry.candidate, ranked: list };
  }
  const reason: MediaSelectionAbstentionReason = sawRightsUnresolved
    ? "rights_unresolved"
    : sawIneligible
      ? "not_auto_eligible"
      : sawRejected && !sawBelowThreshold && !sawUnverified
        ? "rejected_by_moderation"
        : sawUnverified && !sawBelowThreshold
          ? "unverified_relevance"
          : "below_relevance_threshold";
  return { decision: "needs_input", reason, ranked: list };
}

// --- cache key (normalized brief/provider/account/catalog version) ---

const sortedCopy = (arr: readonly string[]) => [...arr].map((s) => s.trim().toLowerCase()).sort();

/** Stable, order-independent serialization of the parts of a brief that affect retrieval/ranking - used as the cache key input (spec §5: "cache by normalized brief/provider/account/catalog version"). */
export function normalizeSceneBriefForCache(brief: SceneBrief): string {
  return JSON.stringify({
    beat: brief.beat,
    language: brief.language,
    phrases: sortedCopy(brief.phrases),
    entities: sortedCopy(brief.entities),
    action: sortedCopy(brief.action),
    setting: sortedCopy(brief.setting),
    mood: sortedCopy(brief.mood),
    exclusions: sortedCopy(brief.exclusions),
    verticalOnly: brief.verticalOnly,
    targetDurationSeconds: Math.round(brief.targetDurationSeconds),
  });
}

/** Deterministic, browser-safe (no `node:crypto` - this package is imported from `apps/web` too) djb2 hash. Not cryptographic; only used as a short, stable cache key, never a security boundary. */
const djb2Hash = (input: string): string => {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
};

export function buildMediaCandidateCacheKey(input: {
  normalizedBrief: string;
  provider: string;
  providerAccountId: string;
  catalogVersion?: string;
}): string {
  const raw = `${input.provider}:${input.providerAccountId}:${input.catalogVersion ?? "v1"}:${input.normalizedBrief}`;
  return `mc:${djb2Hash(raw)}`;
}

// --- auto-apply gate shared with VE2E-24 ---

/**
 * A candidate may only ever be auto-applied to a scene/render when it is simultaneously:
 * accepted by vision moderation (or moderation was never required/attempted and the metadata
 * path already gated it via `decideMediaSelection`'s threshold), rights-cleared, and marked
 * `eligibility.autoEligible`. Rejected candidates can never be applied, no matter their score.
 */
export function canAutoApplyMediaCandidate(candidate: MediaCandidate): boolean {
  if (candidate.moderationDecision === "rejected") return false;
  if (!isRightsUsableForAuto(candidate.rightsStatus)) return false;
  if (!candidate.eligibility.autoEligible) return false;
  return true;
}

/**
 * VE2E-24 integration point: attaches a `VisionFindings` result (from
 * `packages/domain/src/vision-moderation-policy.ts`'s `decideVisionModeration`) to a candidate
 * produced by `rankMediaCandidates`/an adapter. A `rejected` finding forces
 * `eligibility.autoEligible` to `false` (rejected candidates can never be applied, regardless of
 * what the adapter originally set); `accepted`/`manual_review` never flips an already-`false`
 * eligibility to `true` - moderation can only take eligibility away, never grant it (rights/
 * import-capability gates from `pexelsPhotoToMediaCandidate`/`youtubeVideoToMediaCandidate` etc.
 * remain independently authoritative).
 */
export function applyVisionFindings(candidate: MediaCandidate, findings: VisionFindings): MediaCandidate {
  const eligibility = findings.decision === "rejected" ? { autoEligible: false as const, reason: "rejected_by_vision_moderation" } : candidate.eligibility;
  return { ...candidate, visionFindings: findings, moderationDecision: findings.decision, eligibility };
}

export type { MediaCandidate, MediaCandidateType, VisionModerationDecision };
