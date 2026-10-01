/**
 * VE2E-60: pure sequencer for the browser-side full-video preview. No DOM, no network, no
 * FFmpeg - it only turns the ordered Studio scene rows into a timeline of segments with
 * start/duration/flags, and maps a global playhead time back to a scene + offset.
 * The result is an approximation of the Creatomate render, never render evidence.
 */

/** Used when a scene has neither voice, a source range nor a usable duration hint. */
export const FULL_PREVIEW_FALLBACK_DURATION_MS = 3000;
/** Lower bound so a bad 0/negative duration can never produce a zero-length (unseekable) segment. */
export const FULL_PREVIEW_MIN_SEGMENT_MS = 500;

export type FullPreviewMediaKind = "image" | "video";

export type FullPreviewSceneInput = {
  sceneId: string;
  excluded: boolean;
  /** On-screen caption; same contract as Auto (displayText = narration). */
  narration: string;
  /** Used for the caption only when narration is empty. */
  screenText?: string | null;
  durationHintMs: number;
  mediaKind: FullPreviewMediaKind | null;
  /** Resolved (signed) URL; `null`/`undefined` when no media is bound or the URL is not resolved yet. */
  mediaUrl: string | null | undefined;
  sourceStartMs: number | null;
  sourceDurationMs: number | null;
  audioUrl: string | null | undefined;
  audioDurationMs: number | null | undefined;
};

export type FullPreviewDurationSource = "audio" | "source" | "hint" | "fallback";

export type FullPreviewSegment = {
  sceneId: string;
  /** Position among the non-excluded scenes. */
  index: number;
  startMs: number;
  durationMs: number;
  endMs: number;
  caption: string;
  mediaKind: FullPreviewMediaKind | null;
  mediaUrl: string | null;
  audioUrl: string | null;
  /** Video slice in the source file (ms); both `null` for images/missing media. */
  sourceStartMs: number | null;
  sourceEndMs: number | null;
  missingMedia: boolean;
  missingVoice: boolean;
  durationSource: FullPreviewDurationSource;
};

export type FullPreviewSequence = {
  segments: FullPreviewSegment[];
  totalDurationMs: number;
};

export type FullPreviewReadiness = {
  missingMedia: string[];
  missingVoice: string[];
  /** Distinct scene ids with any gap. */
  notReady: string[];
};

const positive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function resolveSegmentDuration(input: FullPreviewSceneInput): { durationMs: number; source: FullPreviewDurationSource } {
  const hasAudio = Boolean(input.audioUrl) && positive(input.audioDurationMs);
  if (hasAudio) return { durationMs: Math.max(FULL_PREVIEW_MIN_SEGMENT_MS, Math.round(input.audioDurationMs!)), source: "audio" };
  if (input.mediaKind === "video" && input.mediaUrl && positive(input.sourceDurationMs)) {
    return { durationMs: Math.max(FULL_PREVIEW_MIN_SEGMENT_MS, Math.round(input.sourceDurationMs)), source: "source" };
  }
  if (positive(input.durationHintMs)) return { durationMs: Math.max(FULL_PREVIEW_MIN_SEGMENT_MS, Math.round(input.durationHintMs)), source: "hint" };
  return { durationMs: FULL_PREVIEW_FALLBACK_DURATION_MS, source: "fallback" };
}

/** Builds the playback sequence in the given (timeline) order, skipping excluded scenes. */
export function buildFullPreviewSequence(inputs: FullPreviewSceneInput[]): FullPreviewSequence {
  const segments: FullPreviewSegment[] = [];
  let cursor = 0;
  for (const input of inputs) {
    if (input.excluded) continue;
    const { durationMs, source } = resolveSegmentDuration(input);
    const hasMedia = Boolean(input.mediaUrl) && input.mediaKind !== null;
    const hasVoice = Boolean(input.audioUrl) && positive(input.audioDurationMs);
    const isVideo = hasMedia && input.mediaKind === "video";
    const start = isVideo ? Math.max(0, input.sourceStartMs ?? 0) : null;
    segments.push({
      sceneId: input.sceneId,
      index: segments.length,
      startMs: cursor,
      durationMs,
      endMs: cursor + durationMs,
      caption: input.narration.trim() || (input.screenText ?? "").trim(),
      mediaKind: hasMedia ? input.mediaKind : null,
      mediaUrl: hasMedia ? input.mediaUrl! : null,
      audioUrl: hasVoice ? input.audioUrl! : null,
      sourceStartMs: start,
      sourceEndMs: start === null ? null : positive(input.sourceDurationMs) ? start + input.sourceDurationMs : null,
      missingMedia: !hasMedia,
      missingVoice: !hasVoice,
      durationSource: source,
    });
    cursor += durationMs;
  }
  return { segments, totalDurationMs: cursor };
}

export function clampTime(sequence: FullPreviewSequence, globalMs: number): number {
  if (!Number.isFinite(globalMs)) return 0;
  return Math.min(Math.max(0, globalMs), sequence.totalDurationMs);
}

/**
 * Maps a global playhead time to the segment containing it. Boundaries belong to the next
 * segment; the very end of the timeline maps to the last segment (offset == its duration).
 */
export function locateAt(sequence: FullPreviewSequence, globalMs: number): { index: number; offsetMs: number } | null {
  const { segments } = sequence;
  if (segments.length === 0) return null;
  const t = clampTime(sequence, globalMs);
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid]!.startMs <= t) lo = mid;
    else hi = mid - 1;
  }
  const seg = segments[lo]!;
  return { index: lo, offsetMs: Math.min(t - seg.startMs, seg.durationMs) };
}

/** Global time of the start of the scene (for the scene jump list); `null` if it is not in the sequence (e.g. excluded). */
export function sceneStartMs(sequence: FullPreviewSequence, sceneId: string): number | null {
  return sequence.segments.find((seg) => seg.sceneId === sceneId)?.startMs ?? null;
}

/**
 * Media-element time (seconds) for a video segment at `offsetMs` into the scene: the source
 * slice start plus the offset, never beyond the slice end (the clip freezes on its last frame
 * if the scene is longer than the slice - same as a non-looping render).
 */
export function videoSourceTimeSec(segment: FullPreviewSegment, offsetMs: number): number {
  const start = segment.sourceStartMs ?? 0;
  const raw = start + Math.max(0, offsetMs);
  const capped = segment.sourceEndMs != null ? Math.min(raw, segment.sourceEndMs) : raw;
  return capped / 1000;
}

/** Voice element time (seconds) at `offsetMs`. */
export function audioTimeSec(offsetMs: number): number {
  return Math.max(0, offsetMs) / 1000;
}

export function summarizeReadiness(sequence: FullPreviewSequence): FullPreviewReadiness {
  const missingMedia = sequence.segments.filter((s) => s.missingMedia).map((s) => s.sceneId);
  const missingVoice = sequence.segments.filter((s) => s.missingVoice).map((s) => s.sceneId);
  const notReady = sequence.segments.filter((s) => s.missingMedia || s.missingVoice).map((s) => s.sceneId);
  return { missingMedia, missingVoice, notReady };
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
