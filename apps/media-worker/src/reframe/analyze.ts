import { planReframe, type CropPlan, type ExclusionRegion, type SubjectTrack } from "@lyonix/domain";
import type { ReframeAnalyzeSuccess, ReframeSubjectPreference } from "@lyonix/media-jobs";
import { MediaJobError } from "../job-errors.js";
import { computeConfidence } from "./confidence.js";
import type { FrameDetector } from "./detector.js";
import type { Box, RgbImage } from "./image-io.js";
import { cropRows, isUsableTextBox, presetLogoRegions, temporalRegions, textBands, type PresetMargins, type TimedBoxes } from "./overlays.js";
import { findSalientBox } from "./saliency.js";
import { rankSubjects, usableFaces, type FrameDetections } from "./subjects.js";
import { matchTemplate, matchToSourceBox, TEMPLATE_WORK_WIDTH, toGrey, type GreyImage } from "./template-match.js";

export type AnalysisFrame = { tMs: number; image: RgbImage };

export type AnalyzeFramesInput = {
  frames: AnalysisFrame[];
  sourceWidth: number;
  sourceHeight: number;
  /** Analysed window length (0 for stills). Frame times are relative to the window start. */
  windowDurationMs: number;
  isImage: boolean;
  /** Origin is TikTok/Apify: switch on the preset corner margins. */
  social: boolean;
  preferredSubject: ReframeSubjectPreference | null;
  detector: FrameDetector;
  settings: {
    presetMargins: PresetMargins;
    textMaxFrames: number;
    textTopPct: number;
    textBottomPct: number;
    templates: GreyImage[];
    templateThreshold: number;
    plan: Parameters<typeof planReframe>[1];
  };
  /** Absolute `Date.now()` after which the analysis aborts with DETECTOR_TIMEOUT (checked between detector calls). */
  deadlineAt?: number;
};

export type AnalyzeFramesOutput = {
  cropPlan: CropPlan;
  confidence: ReframeAnalyzeSuccess["confidence"];
  analysis: ReframeAnalyzeSuccess["analysis"];
  detectMs: number;
  planMs: number;
  rssPeakMb: number;
  /** In-memory only (CLI/debug): what the planner was given. Never serialised into the job result. */
  debug: { frames: AnalysisFrame[]; subjects: SubjectTrack[]; exclusions: ExclusionRegion[] };
};

const scaleBox = (box: Box, sx: number, sy: number, dy = 0): Box => ({ x: box.x * sx, y: (box.y + dy) * sy, w: box.w * sx, h: box.h * sy });
const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** Evenly spread `count` indices over `total` items (all of them when count >= total). */
export const spreadIndices = (total: number, count: number): number[] => {
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  return [...new Set(Array.from({ length: count }, (_, i) => Math.min(total - 1, Math.floor(((i + 0.5) * total) / count))))];
};

/**
 * The detection + planning core of `reframe.analyze` (no FFmpeg, no disk): cheap path per DEC-2026-10-02-CAPACITY-250 - faces on every
 * frame, persons only on frames without a usable face, OCR only on the top/bottom bands of <= `textMaxFrames` frames, preset corner
 * margins for social sources (zero CPU), optional template matching. Saliency only when nothing person-like was found anywhere.
 */
export async function analyzeFrames(input: AnalyzeFramesInput): Promise<AnalyzeFramesOutput> {
  const { frames, detector, settings } = input;
  if (frames.length === 0) throw new MediaJobError("OUTPUT_INVALID", "no frame available to analyse");
  const started = performance.now();
  let rssPeak = process.memoryUsage().rss;
  const checkpoint = () => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    if (input.deadlineAt !== undefined && Date.now() > input.deadlineAt) throw new MediaJobError("DETECTOR_TIMEOUT", "reframe analysis exceeded its time budget", true);
  };
  const salientOnly = input.preferredSubject === "salient";
  const detections: FrameDetections[] = [];
  const frameScale = frames.map((f) => ({ sx: input.sourceWidth / f.image.width, sy: input.sourceHeight / f.image.height }));

  for (const [index, frame] of frames.entries()) {
    checkpoint();
    const { sx, sy } = frameScale[index]!;
    let faces: FrameDetections["faces"] = [];
    let persons: FrameDetections["persons"] = null;
    if (!salientOnly) {
      faces = (await detector.detectFaces(frame.image)).map((d) => ({ box: scaleBox(d.box, sx, sy), score: d.score }));
      if (usableFaces(faces, input.sourceHeight).length === 0) {
        checkpoint();
        persons = (await detector.detectPersons(frame.image)).map((d) => ({ box: scaleBox(d.box, sx, sy), score: d.score }));
      }
    }
    detections.push({ tMs: frame.tMs, faces, persons });
  }

  // Text: bands only, <= textMaxFrames frames.
  const textFrames = spreadIndices(frames.length, settings.textMaxFrames);
  const textSamples: TimedBoxes[] = [];
  for (const index of textFrames) {
    checkpoint();
    const frame = frames[index]!;
    const { sx, sy } = frameScale[index]!;
    const boxes: Box[] = [];
    for (const band of textBands(frame.image.height, settings.textTopPct, settings.textBottomPct)) {
      const found = await detector.detectText(cropRows(frame.image, band.y0, band.y1));
      for (const d of found) {
        const box = { x: d.box.x, y: d.box.y + band.y0, w: d.box.w, h: d.box.h };
        if (isUsableTextBox(box, frame.image.width, frame.image.height)) boxes.push(scaleBox(box, sx, sy));
      }
    }
    textSamples.push({ tMs: frames[index]!.tMs, boxes });
  }

  // Optional known-logo templates (every frame; cheap grey NCC at 160 px).
  const templateSamples: TimedBoxes[] = [];
  if (settings.templates.length > 0) {
    for (const [index, frame] of frames.entries()) {
      checkpoint();
      const grey = toGrey(frame.image, TEMPLATE_WORK_WIDTH);
      const boxes: Box[] = [];
      for (const template of settings.templates) {
        const match = matchTemplate(grey, template);
        if (match && match.score >= settings.templateThreshold) boxes.push(matchToSourceBox(match, template, TEMPLATE_WORK_WIDTH, input.sourceWidth, input.sourceHeight));
      }
      templateSamples.push({ tMs: frame.tMs, boxes });
      void index;
    }
  }

  // Subject: face -> person -> salient -> none.
  const ranked = salientOnly ? { tracks: [] as SubjectTrack[], primaryId: null, dominance: 0, source: "none" as const, framesWithSubject: 0 } : rankSubjects(detections, input.sourceWidth, input.sourceHeight, input.preferredSubject);
  let subjects: SubjectTrack[] = ranked.tracks;
  let primaryId = ranked.primaryId;
  let subjectSource: ReframeAnalyzeSuccess["analysis"]["subjectSource"] = ranked.source;
  let framesWithSubject = ranked.framesWithSubject;
  let dominance = ranked.dominance;
  if (subjects.length === 0) {
    const samples = [];
    for (const [index, frame] of frames.entries()) {
      checkpoint();
      const salient = findSalientBox(frame.image);
      if (salient) {
        const { sx, sy } = frameScale[index]!;
        const box = scaleBox(salient.box, sx, sy);
        samples.push({ tMs: frame.tMs, box: { xPx: Math.round(box.x), yPx: Math.round(box.y), widthPx: Math.max(1, Math.round(box.w)), heightPx: Math.max(1, Math.round(box.h)) } });
      }
    }
    if (samples.length > 0) {
      subjects = [{ subjectId: "salient1", kind: "salient", samples }];
      primaryId = "salient1";
      subjectSource = "salient";
      framesWithSubject = samples.length;
      dominance = 1;
    } else {
      subjectSource = "none";
    }
  }
  const detectMs = performance.now() - started;

  // Exclusions.
  const durationMs = input.isImage ? 0 : input.windowDurationMs;
  const textRegions = temporalRegions("text", textSamples, textSamples.map((s) => s.tMs), durationMs);
  const templateRegions: ExclusionRegion[] = temporalRegions("logo", templateSamples, templateSamples.map((s) => s.tMs), durationMs);
  const presetRegions = input.social ? presetLogoRegions(input.sourceWidth, input.sourceHeight, settings.presetMargins) : [];
  const exclusions = [...presetRegions, ...templateRegions, ...textRegions];

  const planStarted = performance.now();
  const cropPlan = planReframe(
    { sourceWidthPx: input.sourceWidth, sourceHeightPx: input.sourceHeight, targetWidthPx: 1080, targetHeightPx: 1920, durationMs, subjects, exclusions },
    { ...settings.plan, ...(primaryId ? { preferredSubjectId: primaryId } : {}) },
  );
  const planMs = performance.now() - planStarted;
  checkpoint();

  const confidence = computeConfidence({
    subjectSource,
    framesAnalysed: frames.length,
    framesWithSubject,
    dominance,
    social: input.social,
    windowDurationMs: input.windowDurationMs,
    isImage: input.isImage,
    overlayUnavoidable: cropPlan.overlayUnavoidable,
    textScanned: textFrames.length > 0,
    templatesConfigured: settings.templates.length > 0,
  });
  const warnings: string[] = [];
  if (subjectSource === "salient") warnings.push("subject_is_salient_region_fallback");
  if (subjectSource === "none") warnings.push("no_subject_found_plan_is_centered");
  if (cropPlan.overlayUnavoidable) warnings.push(`overlay_unavoidable_residual_${cropPlan.residualOverlayPct}pct`);
  if (cropPlan.subjectCoveragePct < 100) warnings.push(`subject_partially_outside_crop_${cropPlan.subjectCoveragePct}pct`);

  return {
    cropPlan,
    confidence,
    analysis: {
      framesSampled: frames.length,
      framesAnalysed: frames.length,
      subjectSource,
      framesWithFace: detections.filter((d) => usableFaces(d.faces, input.sourceHeight).length > 0).length,
      framesWithPerson: detections.filter((d) => d.persons !== null && d.persons.length > 0).length,
      textRegions: textRegions.length,
      presetLogoRegions: presetRegions.length,
      logoTemplateMatches: templateRegions.length,
      warnings,
    },
    detectMs,
    planMs,
    rssPeakMb: mb(rssPeak),
    debug: { frames, subjects, exclusions },
  };
}
