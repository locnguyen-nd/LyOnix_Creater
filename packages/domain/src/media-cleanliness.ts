/**
 * VE2E-152: Media Cleanliness - prefer raw, reusable footage over media somebody else already edited (burnt-in subtitles, headlines,
 * watermarks, stickers, templates, split screens, social-app UI). Pure, browser-safe (imported through `media-ranking.ts`).
 *
 * Evidence, strongest first:
 * - vision cleanliness findings (`VisionCleanlinessFindings`, asked in the SAME moderation call: cover image, or 5 low-res frames of
 *   the downloaded clip - start / 25% / 50% / 75% / end - when `VISION_VIDEO_FRAMES=1`);
 * - the person-mode shot description (`VisionShotFindings`: text none / little / heavy, logo, news card) when no cleanliness answer exists;
 * - metadata hints (caption / hashtags: #capcut, #edit, lyrics, 字幕, 切り抜き, follow / subscribe, ...) and platform signals
 *   (TikTok effect stickers). Metadata alone never rejects: it can only lower a candidate to `penalized`.
 *
 * Tiers: `clean` (A raw footage) > `acceptable` (B small corner logo / a little text off the subject) > `penalized` (C subtitles,
 * headline, stickers, split screen, heavy edit) > `reject` (D text-heavy, continuous subtitles, large watermark, social-app UI, news card,
 * a finished edit by someone else). `reject` is never auto-picked unless the caller allows it (see `allowCleanlinessRejects`).
 */
import type { VisionCleanlinessFindings, VisionShotFindings } from "./media-candidate.js";

/** Text area bands (share of the frame covered by overlaid text). */
export const CLEANLINESS_TEXT_BANDS = { good: 0.08, usable: 0.18, penalized: 0.3 } as const;
/** A corner logo up to this share of the frame is a light penalty only. */
export const SMALL_LOGO_MAX_RATIO = 0.03;
/** Frames (of a multi-frame sample) with heavy text / a watermark from which the candidate counts as text-heavy / watermarked. */
export const CLEANLINESS_MIN_BAD_FRAMES = 2;
/** Edit signals from which a video counts as pre-edited (penalized), and as a finished edit by someone else (reject). */
export const PRE_EDITED_MIN_SIGNALS = 2;
export const FINISHED_EDIT_MIN_SIGNALS = 3;

export type CleanlinessTier = "clean" | "acceptable" | "penalized" | "reject";
export type CleanlinessRejectionReason = "TEXT_HEAVY" | "BURNT_IN_SUBTITLES" | "LARGE_WATERMARK" | "PRE_EDITED_VIDEO" | "SOCIAL_UI_OVERLAY" | "NEWS_CARD";
export type EditSignal =
  | "burnt_in_subtitles"
  | "headline_or_lower_third"
  | "watermark_or_username"
  | "large_logo"
  | "stickers_or_emoji"
  | "frame_or_template"
  | "split_screen_or_pip"
  | "social_ui_or_cta"
  | "large_overlay"
  | "edit_hashtags"
  | "lyrics_or_text_video"
  | "compilation_or_commentary";

export type MediaCleanliness = {
  tier: CleanlinessTier;
  /** 0..1 (1 = raw footage, no overlay). */
  cleanlinessScore: number;
  /** 0..1 overlaid-text share of the frame (vision; estimated from the shot description), `null` when unknown. */
  textAreaRatio: number | null;
  logoDetected: boolean;
  watermarkDetected: boolean;
  subtitleDetected: boolean;
  preEdited: boolean;
  editSignals: EditSignal[];
  /** Why a `reject` candidate is out. */
  rejectionReason?: CleanlinessRejectionReason;
  /** Where the verdict came from. */
  method: "vision" | "shot" | "metadata" | "none";
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFKC").toLowerCase();

const EDIT_HASHTAGS = /(?:^|[^a-z])(?:capcut|edit|edits|fanedit|velocity|transition|aftereffects|ae ?edit|alight ?motion)(?:[^a-z]|$)|編集|加工/u;
const LYRICS_TEXT = /(?:^|[^a-z])(?:lyrics?|subtitles?|subbed|eng ?sub|quotes?|tweet)(?:[^a-z]|$)|歌詞|字幕|和訳|名言/u;
const COMPILATION = /(?:^|[^a-z])(?:compilation|reaction|commentary|ranking|top ?\d+|part ?\d+)(?:[^a-z]|$)|切り抜き|まとめ|解説|リアクション|ランキング/u;
const SOCIAL_CTA = /(?:^|[^a-z])(?:follow for more|subscribe|link in bio)(?:[^a-z]|$)|チャンネル登録|フォローして/u;

/** Edit hints from a candidate's own caption / hashtags / title, plus platform signals (e.g. TikTok effect stickers -> `stickers_or_emoji`). */
export function metadataEditSignals(text: string | null | undefined, platformSignals: readonly string[] = []): EditSignal[] {
  const out = new Set<EditSignal>();
  const value = fold(text ?? "");
  if (value) {
    if (EDIT_HASHTAGS.test(value)) out.add("edit_hashtags");
    if (LYRICS_TEXT.test(value)) out.add("lyrics_or_text_video");
    if (COMPILATION.test(value)) out.add("compilation_or_commentary");
    if (SOCIAL_CTA.test(value)) out.add("social_ui_or_cta");
  }
  for (const signal of platformSignals) if (isEditSignal(signal)) out.add(signal);
  return [...out];
}

const EDIT_SIGNALS: ReadonlySet<string> = new Set<EditSignal>([
  "burnt_in_subtitles", "headline_or_lower_third", "watermark_or_username", "large_logo", "stickers_or_emoji", "frame_or_template",
  "split_screen_or_pip", "social_ui_or_cta", "large_overlay", "edit_hashtags", "lyrics_or_text_video", "compilation_or_commentary",
]);
const isEditSignal = (value: string): value is EditSignal => EDIT_SIGNALS.has(value);

const textBandScore = (ratio: number): { score: number; tier: CleanlinessTier } => {
  if (ratio <= CLEANLINESS_TEXT_BANDS.good) return { score: 1, tier: "clean" };
  if (ratio <= CLEANLINESS_TEXT_BANDS.usable) return { score: 0.75, tier: "acceptable" };
  if (ratio <= CLEANLINESS_TEXT_BANDS.penalized) return { score: 0.35, tier: "penalized" };
  return { score: 0.1, tier: "reject" };
};
const TIER_ORDER: readonly CleanlinessTier[] = ["clean", "acceptable", "penalized", "reject"];
const worse = (a: CleanlinessTier, b: CleanlinessTier): CleanlinessTier => (TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b);
const oneWorse = (tier: CleanlinessTier): CleanlinessTier => TIER_ORDER[Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(tier) + 1)]!;

/** Text-area estimate from the person-mode shot description (`none` / `little` / `heavy`) when no cleanliness answer exists. */
const SHOT_TEXT_RATIO = { none: 0.03, little: 0.12, heavy: 0.35 } as const;

/**
 * The cleanliness verdict of one candidate. Strongest evidence wins (vision cleanliness > shot description > metadata). Rules:
 * text <= 8% clean, 8-18% acceptable, 18-30% penalized, > 30% (or heavy text on >= 2 sampled frames) reject; text over the face /
 * subject is one band worse; a small corner logo (<= 3%) is a light penalty, a large logo / watermark on >= 2 frames rejects; a
 * watermark / username is a strong penalty; burnt-in subtitles penalize (on >= 2 frames: reject); social-app UI / CTA rejects; a news
 * card rejects; >= 2 edit signals = pre-edited (penalized), >= 3 = a finished edit by someone else (reject). Metadata never rejects.
 */
export function assessMediaCleanliness(input: {
  vision?: VisionCleanlinessFindings | null;
  shot?: VisionShotFindings | null;
  text?: string | null | undefined;
  platformSignals?: readonly string[];
}): MediaCleanliness {
  const metadataSignals = metadataEditSignals(input.text, input.platformSignals ?? []);
  const vision = input.vision ?? null;
  const shot = input.shot ?? null;
  const signals = new Set<EditSignal>(metadataSignals);
  // Widened on purpose: `reject()` changes it from a closure, which control-flow narrowing would not see.
  let tier = "clean" as CleanlinessTier;
  let score = 1;
  let rejectionReason: CleanlinessRejectionReason | undefined;
  const reject = (reason: CleanlinessRejectionReason) => {
    tier = "reject";
    // The most specific reason wins: a news card is reported as such even when its text area is also too large.
    rejectionReason = reason === "NEWS_CARD" ? reason : (rejectionReason ?? reason);
  };
  let textAreaRatio: number | null = null;
  let logoDetected = false;
  let watermarkDetected = false;
  let subtitleDetected = false;
  let method: MediaCleanliness["method"] = metadataSignals.length > 0 ? "metadata" : "none";

  if (vision) {
    method = "vision";
    textAreaRatio = clamp01(vision.textAreaPct / 100);
    const multiFrame = (vision.sampledFrames ?? 1) >= 2;
    const band = textBandScore(textAreaRatio);
    score = band.score;
    tier = vision.textOverSubject && band.tier !== "clean" ? oneWorse(band.tier) : vision.textOverSubject ? "acceptable" : band.tier;
    if (vision.textOverSubject) score -= 0.15;
    if (tier === "reject" || (multiFrame && (vision.heavyTextFrames ?? 0) >= CLEANLINESS_MIN_BAD_FRAMES)) reject("TEXT_HEAVY");
    if (vision.subtitles) {
      subtitleDetected = true;
      signals.add("burnt_in_subtitles");
      score -= 0.3;
      tier = worse(tier, "penalized");
      // Subtitles in every sampled frame (or a long text strip) = a finished, captioned edit.
      if (multiFrame && (vision.heavyTextFrames ?? 0) >= CLEANLINESS_MIN_BAD_FRAMES) reject("BURNT_IN_SUBTITLES");
    }
    if (vision.logo === "small") {
      logoDetected = true;
      score -= 0.1;
      tier = worse(tier, "acceptable");
    } else if (vision.logo === "large") {
      logoDetected = true;
      signals.add("large_logo");
      reject("LARGE_WATERMARK");
    }
    if (vision.watermark) {
      watermarkDetected = true;
      signals.add("watermark_or_username");
      score -= 0.35;
      tier = worse(tier, "penalized");
      if (multiFrame && (vision.watermarkFrames ?? 0) >= CLEANLINESS_MIN_BAD_FRAMES && (vision.logo === "large" || (vision.heavyTextFrames ?? 0) >= 1)) reject("LARGE_WATERMARK");
    }
    if (vision.lowerThird) {
      signals.add("headline_or_lower_third");
      score -= 0.3;
      tier = worse(tier, "penalized");
    }
    if (vision.stickers) {
      signals.add("stickers_or_emoji");
      score -= 0.2;
      tier = worse(tier, "penalized");
    }
    if (vision.frameTemplate) {
      signals.add("frame_or_template");
      score -= 0.25;
      tier = worse(tier, "penalized");
    }
    if (vision.splitScreen) {
      signals.add("split_screen_or_pip");
      score -= 0.3;
      tier = worse(tier, "penalized");
    }
    if (vision.largeOverlay) {
      signals.add("large_overlay");
      score -= 0.3;
      tier = worse(tier, "penalized");
    }
    if (vision.socialUi) {
      signals.add("social_ui_or_cta");
      reject("SOCIAL_UI_OVERLAY");
    }
  } else if (shot) {
    method = "shot";
    textAreaRatio = SHOT_TEXT_RATIO[shot.textCoverage];
    const band = textBandScore(textAreaRatio);
    score = band.score;
    tier = band.tier;
    if (tier === "reject") reject("TEXT_HEAVY");
    if (shot.logo) {
      logoDetected = true;
      score -= 0.1;
      tier = worse(tier, "acceptable");
    }
  }
  if (shot?.newsCard) reject("NEWS_CARD");

  const editSignals = [...signals];
  // Metadata hints only lower the score (never reject on their own); with vision they add up with the visible signals.
  score -= 0.1 * metadataSignals.length;
  const preEdited = editSignals.length >= PRE_EDITED_MIN_SIGNALS;
  if (preEdited) tier = worse(tier, "penalized");
  if (vision && editSignals.length >= FINISHED_EDIT_MIN_SIGNALS) reject("PRE_EDITED_VIDEO");
  if (!vision && !shot && metadataSignals.length > 0) tier = worse(tier, metadataSignals.length >= PRE_EDITED_MIN_SIGNALS ? "penalized" : "acceptable");
  if (tier === "reject") score = Math.min(score, 0.2);
  return {
    tier,
    cleanlinessScore: round3(clamp01(score)),
    textAreaRatio: textAreaRatio === null ? null : round3(textAreaRatio),
    logoDetected,
    watermarkDetected,
    subtitleDetected,
    preEdited,
    editSignals,
    ...(rejectionReason ? { rejectionReason } : {}),
    method,
  };
}

/** Clean-footage weight of a tier inside the ranking (A > B > C; D is out unless allowed). */
export const CLEANLINESS_TIER_SCORE: Record<CleanlinessTier, number> = { clean: 1, acceptable: 0.7, penalized: 0.3, reject: 0 };
/** Non-person ranking: the normal score is scaled by the tier (no evidence = `clean` = unchanged). */
export const CLEANLINESS_TIER_FACTOR: Record<CleanlinessTier, number> = { clean: 1, acceptable: 0.95, penalized: 0.8, reject: 0 };

/** Shown / logged when the picked media is not clean footage because nothing cleaner was usable. */
export const CLEANLINESS_FALLBACK_MESSAGE = "Không đủ footage sạch, đang dùng media có overlay nhẹ.";

/** Rejection reasons of a ranked pool, for the segment diagnostics. */
export const cleanlinessRejectionCounts = (items: ReadonlyArray<MediaCleanliness | undefined>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) if (item?.rejectionReason) counts[item.rejectionReason] = (counts[item.rejectionReason] ?? 0) + 1;
  return counts;
};
