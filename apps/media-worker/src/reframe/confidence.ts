import type { ReframeConfidence, ReframeSubjectSource } from "@lyonix/media-jobs";

/**
 * Confidence of a reframe analysis. PLACEHOLDER heuristics (CR §4: quality metrics are VE2E-69 targets, not guarantees): they say how
 * much evidence the analysis had, NOT a measured accuracy. Levels: high >= 0.75, medium >= 0.5, else low.
 */

export type ConfidenceInput = {
  subjectSource: ReframeSubjectSource;
  framesAnalysed: number;
  framesWithSubject: number;
  /** Primary subject's share of the ranking score (1 = alone, low = several comparable people). */
  dominance: number;
  social: boolean;
  windowDurationMs: number;
  isImage: boolean;
  overlayUnavoidable: boolean;
  textScanned: boolean;
  templatesConfigured: boolean;
};

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function computeConfidence(input: ConfidenceInput): ReframeConfidence {
  const reasons: string[] = [];
  const share = input.framesAnalysed > 0 ? input.framesWithSubject / input.framesAnalysed : 0;
  let subject: number;
  switch (input.subjectSource) {
    case "face":
    case "person":
      subject = 0.35 + 0.65 * share;
      if (input.dominance < 0.5) { subject *= 0.85; reasons.push("ambiguous_multi_person"); }
      if (share < 0.5) reasons.push("subject_in_under_half_of_frames");
      break;
    case "salient":
      subject = 0.35;
      reasons.push("salient_fallback_no_person_found");
      break;
    default:
      subject = 0.2;
      reasons.push("no_subject_found_center_crop");
  }

  let overlay = 0.85;
  if (!input.textScanned && !input.isImage) reasons.push("text_not_scanned");
  if (input.social) {
    const longEnough = input.windowDurationMs >= 8000 && input.framesAnalysed >= 6;
    overlay = longEnough ? 0.6 : 0.35;
    reasons.push("social_logo_by_preset_margins_only");
    if (!longEnough && !input.isImage) reasons.push("short_clip_low_watermark_confidence");
  }
  if (input.templatesConfigured) overlay = Math.min(1, overlay + 0.1);
  if (input.framesAnalysed < 4 && !input.isImage) { overlay *= 0.7; reasons.push("few_frames_analysed"); }
  if (input.overlayUnavoidable) reasons.push("overlay_unavoidable");

  const overall = Math.min(subject, overlay);
  return {
    overall: round2(clamp01(overall)),
    subject: round2(clamp01(subject)),
    overlay: round2(clamp01(overlay)),
    level: overall >= 0.75 ? "high" : overall >= 0.5 ? "medium" : "low",
    reasons,
  };
}
