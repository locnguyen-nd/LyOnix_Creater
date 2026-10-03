import type { SubjectTrack } from "@lyonix/domain";
import type { ReframeSubjectPreference } from "@lyonix/media-jobs";
import { boxArea, type Box, type Detection } from "./image-io.js";

/**
 * Turns per-frame detections into `SubjectTrack`s and picks the primary one (CR-SUBJECT-REFRAME §3 step 1a): face first, person only for
 * frames with no usable face, then a salient region only when nothing person-like was found anywhere. All numbers marked PLACEHOLDER
 * are untuned (VE2E-69 measures them on real samples).
 */

/** PLACEHOLDER: faces/persons smaller than this share of the frame height are crowd/background noise, not a subject. */
export const MIN_FACE_HEIGHT_RATIO = 0.05;
export const MIN_PERSON_HEIGHT_RATIO = 0.12;
/** PLACEHOLDER: a face box is expanded to head + shoulders so the crop keeps some context around the face. */
export const FACE_EXPAND = { widthFactor: 2.4, topFactor: 0.7, heightFactor: 3.4 } as const;
/** PLACEHOLDER: max subject tracks kept (the planner only follows the primary one; the rest are for ranking/diagnostics). */
export const MAX_TRACKS = 5;

export type FrameDetections = {
  /** Time inside the analysed window, ms. */
  tMs: number;
  /** In SOURCE pixels. */
  faces: Detection[];
  /** In SOURCE pixels; `null` = the person detector was not run for this frame (a usable face was found). */
  persons: Detection[] | null;
};

export type Candidate = { box: Box; score: number; origin: "face" | "person" };

export function expandFaceBox(face: Box, srcWidth: number, srcHeight: number): Box {
  const w = face.w * FACE_EXPAND.widthFactor;
  const x = face.x + face.w / 2 - w / 2;
  const y = face.y - face.h * FACE_EXPAND.topFactor;
  const h = face.h * FACE_EXPAND.heightFactor;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(srcWidth, x + w);
  const y1 = Math.min(srcHeight, y + h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export const usableFaces = (faces: Detection[], srcHeight: number): Detection[] => faces.filter((f) => f.box.h >= srcHeight * MIN_FACE_HEIGHT_RATIO);
export const usablePersons = (persons: Detection[], srcHeight: number): Detection[] => persons.filter((p) => p.box.h >= srcHeight * MIN_PERSON_HEIGHT_RATIO);

/** Candidates of one frame: usable faces (expanded) if any, else usable persons. */
export function frameCandidates(frame: FrameDetections, srcWidth: number, srcHeight: number): Candidate[] {
  const faces = usableFaces(frame.faces, srcHeight);
  if (faces.length > 0) return faces.map((f) => ({ box: expandFaceBox(f.box, srcWidth, srcHeight), score: f.score, origin: "face" as const }));
  return usablePersons(frame.persons ?? [], srcHeight).map((p) => ({ box: p.box, score: p.score, origin: "person" as const }));
}

const centre = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

type Track = { id: string; samples: Array<{ tMs: number; box: Box; score: number; origin: "face" | "person" }> };

/** Greedy nearest-centre association (largest candidates first) of each frame's candidates to the existing tracks. */
export function buildTracks(frames: FrameDetections[], srcWidth: number, srcHeight: number): Track[] {
  const tracks: Track[] = [];
  const maxJump = 0.35 * Math.max(srcWidth, srcHeight);
  for (const frame of [...frames].sort((a, b) => a.tMs - b.tMs)) {
    const candidates = frameCandidates(frame, srcWidth, srcHeight).sort((a, b) => boxArea(b.box) * b.score - boxArea(a.box) * a.score);
    const taken = new Set<Track>();
    for (const candidate of candidates) {
      const c = centre(candidate.box);
      let best: Track | null = null;
      let bestDist = maxJump;
      for (const track of tracks) {
        if (taken.has(track)) continue;
        const last = centre(track.samples[track.samples.length - 1]!.box);
        const dist = Math.hypot(c.x - last.x, c.y - last.y);
        if (dist <= bestDist) { best = track; bestDist = dist; }
      }
      if (!best) {
        best = { id: `s${tracks.length + 1}`, samples: [] };
        tracks.push(best);
      }
      taken.add(best);
      best.samples.push({ tMs: frame.tMs, box: candidate.box, score: candidate.score, origin: candidate.origin });
    }
  }
  return tracks;
}

export type RankedSubjects = {
  tracks: SubjectTrack[];
  primaryId: string | null;
  /** Primary's share of the total ranking score (1 = alone). Low = several comparable people. */
  dominance: number;
  source: "face" | "person" | "none";
  framesWithSubject: number;
};

const toPx = (box: Box) => ({ xPx: Math.round(box.x), yPx: Math.round(box.y), widthPx: Math.max(1, Math.round(box.w)), heightPx: Math.max(1, Math.round(box.h)) });

/**
 * Ranking rule for crowded frames: `largest` (default) = biggest summed box area, halved for tracks present in under half of the
 * frames (large AND stable); `center` = area weighted by closeness to the frame centre. Ties go to the smaller id (deterministic).
 */
export function rankSubjects(frames: FrameDetections[], srcWidth: number, srcHeight: number, preference: ReframeSubjectPreference | null): RankedSubjects {
  const total = Math.max(1, frames.length);
  const scored = buildTracks(frames, srcWidth, srcHeight).map((track) => {
    const presence = track.samples.length / total;
    const sum = track.samples.reduce((acc, s) => {
      const area = boxArea(s.box);
      if (preference === "center") {
        const c = centre(s.box);
        const d = Math.hypot(c.x - srcWidth / 2, c.y - srcHeight / 2) / (0.35 * Math.max(srcWidth, srcHeight));
        return acc + area * Math.exp(-d * d);
      }
      return acc + area;
    }, 0);
    return { track, score: presence < 0.5 ? sum * 0.5 : sum };
  });
  scored.sort((a, b) => b.score - a.score || (a.track.id < b.track.id ? -1 : 1));
  const kept = scored.slice(0, MAX_TRACKS);
  const sum = kept.reduce((acc, s) => acc + s.score, 0);
  const primary = kept[0] ?? null;
  const framesWithSubject = new Set(kept.flatMap((s) => s.track.samples.map((p) => p.tMs))).size;
  const faceVotes = primary ? primary.track.samples.filter((s) => s.origin === "face").length : 0;
  return {
    tracks: kept.map(({ track }) => ({ subjectId: track.id, kind: "person" as const, samples: track.samples.map((s) => ({ tMs: s.tMs, box: toPx(s.box) })) })),
    primaryId: primary?.track.id ?? null,
    dominance: primary && sum > 0 ? primary.score / sum : 0,
    source: primary ? (faceVotes >= primary.track.samples.length / 2 ? "face" : "person") : "none",
    framesWithSubject,
  };
}
