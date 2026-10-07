/**
 * VE2E-65 (CR-SUBJECT-REFRAME-2026-10-02 §3 step 2): pure, deterministic reframe planner. No I/O,
 * no FFmpeg, no detector - `apps/media-worker` (VE2E-66/67) supplies the subject track + exclusion
 * regions and later applies the resulting `CropPlan`.
 *
 * Given the source size, the subject trajectory over time, the logo/text exclusion regions and the
 * target aspect (9:16, 1080x1920), it returns a crop window (static or keyframed) that keeps the
 * primary subject, excludes as much overlay as possible, uses the smallest zoom that helps (capped
 * by REFRAME_MAX_ZOOM), smooths and rate-limits panning, and flags `overlayUnavoidable` (with the
 * residual overlay percentage) instead of silently accepting an overlay that cannot be avoided.
 *
 * All coordinates are integer source pixels, all times integer ms. Types are structurally identical
 * to `SubjectTrack`/`ExclusionRegion`/`CropPlan` in `@lyonix/contracts` (domain never imports it).
 * Numbers marked PLACEHOLDER are untuned; VE2E-69 measures them on real samples.
 */

export const REFRAME_PLAN_VERSION = "crop-plan.v1";
/** Config default (CR §6 Q4 still pending): REFRAME_MAX_ZOOM env, 1.35x. Not hard-coded in the planner: pass `options.maxZoomPermille`. */
export const REFRAME_MAX_ZOOM_DEFAULT = 1.35;
/** PLACEHOLDER (untuned): zoom search granularity in permille (1000 = 1.0x). */
export const REFRAME_ZOOM_STEP_PERMILLE = 50;
/** PLACEHOLDER (untuned): moving-average window for crop-position smoothing. */
export const REFRAME_SMOOTHING_MS_DEFAULT = 600;
/** PLACEHOLDER (untuned): max pan speed as a percentage of the crop window width per second (REFRAME_MAX_PAN_PX_PER_SEC overrides in px). */
export const REFRAME_MAX_PAN_PCT_PER_SEC_DEFAULT = 60;

export type PixelBox = { xPx: number; yPx: number; widthPx: number; heightPx: number };
export type SubjectTrackSample = { tMs: number; box: PixelBox };
export type SubjectTrack = {
  subjectId: string;
  kind: "person" | "salient";
  samples: SubjectTrackSample[];
};
export type ExclusionRegion = {
  kind: "logo" | "text";
  box: PixelBox;
  /** Active interval [startMs, endMs); both omitted = whole clip. */
  startMs?: number;
  endMs?: number;
  /**
   * A guessed region (preset corner margin for a social watermark), not a detection. It steers the window position and may add a
   * little zoom (`softMaxZoomPermille`) but never counts toward `overlayUnavoidable` / `residualOverlayPct`.
   */
  soft?: boolean;
};
export type CropKeyframe = { tMs: number; xPx: number; yPx: number; widthPx: number; heightPx: number };
export type CropPlan = {
  version: typeof REFRAME_PLAN_VERSION;
  sourceWidthPx: number;
  sourceHeightPx: number;
  targetWidthPx: number;
  targetHeightPx: number;
  durationMs: number;
  /** 1000 = no zoom beyond the largest target-aspect window. */
  zoomPermille: number;
  mode: "static" | "keyframes";
  /** `static`: exactly one keyframe at tMs 0. `keyframes`: linear interpolation between them. */
  keyframes: CropKeyframe[];
  primarySubjectId: string | null;
  /** True when some overlay area is still inside the window at max zoom; never silently accepted (Auto swaps source, Studio flags the scene). */
  overlayUnavoidable: boolean;
  /** Worst-case share (0-100, rounded up) of the active overlay area still inside the window. */
  residualOverlayPct: number;
  /** Worst-case share (0-100, rounded down) of the primary subject box inside the window; 100 when no subject. */
  subjectCoveragePct: number;
};

export type PlanReframeInput = {
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Target size; only the aspect ratio matters (default 1080x1920). */
  targetWidthPx?: number;
  targetHeightPx?: number;
  /** Clip length; defaults to the last subject sample time (0 for stills). */
  durationMs?: number;
  subjects?: SubjectTrack[];
  exclusions?: ExclusionRegion[];
};

export type PlanReframeOptions = {
  maxZoomPermille?: number;
  smoothingMs?: number;
  /** Pan speed cap in source px per second (default: REFRAME_MAX_PAN_PCT_PER_SEC_DEFAULT % of the window width). */
  maxPanPxPerSec?: number;
  /** Largest zoom (permille) the planner may spend only to avoid `soft` regions (default 1150). Hard regions and the subject may use `maxZoomPermille`. */
  softMaxZoomPermille?: number;
  /** Hard overlay residual (percent) up to which the plan is still accepted: `overlayUnavoidable` is `residual > this` (default 0 = any). */
  unavoidableMinPct?: number;
  /** Force this subject as primary (e.g. from `visualPlan.subject`) when it exists in `subjects`. */
  preferredSubjectId?: string;
};

/** Reads REFRAME_MAX_ZOOM (default 1.35), optional REFRAME_MAX_PAN_PX_PER_SEC and REFRAME_SMOOTHING_MS. Invalid values fall back to defaults. */
export function reframeOptionsFromEnv(env: Record<string, string | undefined> = process.env): PlanReframeOptions & { maxZoomPermille: number } {
  const num = (value: string | undefined) => (value === undefined || value.trim() === "" ? Number.NaN : Number(value));
  const zoom = num(env.REFRAME_MAX_ZOOM);
  const pan = num(env.REFRAME_MAX_PAN_PX_PER_SEC);
  const smooth = num(env.REFRAME_SMOOTHING_MS);
  const softZoom = num(env.REFRAME_SOFT_MAX_ZOOM);
  const minPct = num(env.REFRAME_UNAVOIDABLE_MIN_PCT);
  return {
    ...(Number.isFinite(softZoom) && softZoom >= 1 ? { softMaxZoomPermille: Math.round(softZoom * 1000) } : {}),
    ...(Number.isFinite(minPct) && minPct >= 0 && minPct <= 100 ? { unavoidableMinPct: Math.floor(minPct) } : {}),
    maxZoomPermille: Number.isFinite(zoom) && zoom >= 1 ? Math.round(zoom * 1000) : Math.round(REFRAME_MAX_ZOOM_DEFAULT * 1000),
    ...(Number.isFinite(pan) && pan > 0 ? { maxPanPxPerSec: Math.floor(pan) } : {}),
    ...(Number.isFinite(smooth) && smooth >= 0 ? { smoothingMs: Math.floor(smooth) } : {}),
  };
}

const area = (box: PixelBox) => Math.max(0, box.widthPx) * Math.max(0, box.heightPx);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
function intersectArea(a: PixelBox, b: PixelBox): number {
  const w = Math.min(a.xPx + a.widthPx, b.xPx + b.widthPx) - Math.max(a.xPx, b.xPx);
  const h = Math.min(a.yPx + a.heightPx, b.yPx + b.heightPx) - Math.max(a.yPx, b.yPx);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Primary subject: preferred id if present, else largest summed box area over time (favours big and long-lived), ties by id. */
function pickPrimary(subjects: SubjectTrack[], preferredId: string | undefined): SubjectTrack | null {
  const usable = subjects.filter((s) => s.samples.length > 0);
  if (preferredId !== undefined) {
    const preferred = usable.find((s) => s.subjectId === preferredId);
    if (preferred) return preferred;
  }
  let best: SubjectTrack | null = null;
  let bestScore = -1;
  for (const s of usable) {
    const score = s.samples.reduce((total, sample) => total + area(sample.box), 0);
    if (score > bestScore || (score === bestScore && best !== null && s.subjectId < best.subjectId)) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

function boxAt(samples: SubjectTrackSample[], tMs: number): PixelBox {
  const first = samples[0]!;
  if (tMs <= first.tMs) return first.box;
  const last = samples[samples.length - 1]!;
  if (tMs >= last.tMs) return last.box;
  let i = 1;
  while (samples[i]!.tMs < tMs) i += 1;
  const a = samples[i - 1]!;
  const b = samples[i]!;
  const span = b.tMs - a.tMs;
  const mix = (p: number, q: number) => Math.round(p + ((q - p) * (tMs - a.tMs)) / span);
  return { xPx: mix(a.box.xPx, b.box.xPx), yPx: mix(a.box.yPx, b.box.yPx), widthPx: mix(a.box.widthPx, b.box.widthPx), heightPx: mix(a.box.heightPx, b.box.heightPx) };
}

type Frame = { tMs: number; subject: PixelBox | null; overlays: PixelBox[]; soft: PixelBox[] };
type Pos = { xPx: number; yPx: number };
type Score = { miss: number; overlay: number; soft: number };

const scoreAt = (frame: Frame, win: PixelBox): Score => ({
  miss: frame.subject ? area(frame.subject) - intersectArea(frame.subject, win) : 0,
  overlay: frame.overlays.reduce((total, box) => total + intersectArea(box, win), 0),
  soft: frame.soft.reduce((total, box) => total + intersectArea(box, win), 0),
});
/** True when `a` is strictly worse than `b`: subject loss dominates, overlay breaks ties. */
const worse = (a: Score, b: Score) => a.miss > b.miss || (a.miss === b.miss && (a.overlay > b.overlay || (a.overlay === b.overlay && a.soft > b.soft)));

function windowSize(srcW: number, srcH: number, tw: number, th: number, zoomPermille: number): { w: number; h: number } {
  if (srcW * th >= srcH * tw) {
    const h = Math.max(1, Math.floor((srcH * 1000) / zoomPermille));
    return { w: Math.min(srcW, Math.max(1, Math.floor((h * tw) / th))), h };
  }
  const w = Math.max(1, Math.floor((srcW * 1000) / zoomPermille));
  return { w, h: Math.min(srcH, Math.max(1, Math.floor((w * th) / tw))) };
}

/** Best window position for one frame at a fixed window size: subject first, then overlay, then closeness to the subject-centred position. */
function bestPosition(frame: Frame, srcW: number, srcH: number, w: number, h: number): { pos: Pos; score: Score } {
  const maxX = Math.max(0, srcW - w);
  const maxY = Math.max(0, srcH - h);
  const subj = frame.subject;
  const idealX = subj ? clamp(Math.round(subj.xPx + subj.widthPx / 2 - w / 2), 0, maxX) : Math.round(maxX / 2);
  const idealY = subj ? clamp(Math.round(subj.yPx + subj.heightPx / 2 - h / 2), 0, maxY) : Math.round(maxY / 2);
  const xs = new Set<number>([idealX, 0, maxX]);
  const ys = new Set<number>([idealY, 0, maxY]);
  if (subj) {
    xs.add(clamp(subj.xPx + subj.widthPx - w, 0, maxX)).add(clamp(subj.xPx, 0, maxX));
    ys.add(clamp(subj.yPx + subj.heightPx - h, 0, maxY)).add(clamp(subj.yPx, 0, maxY));
  }
  for (const o of [...frame.overlays, ...frame.soft]) {
    xs.add(clamp(o.xPx + o.widthPx, 0, maxX)).add(clamp(o.xPx - w, 0, maxX));
    ys.add(clamp(o.yPx + o.heightPx, 0, maxY)).add(clamp(o.yPx - h, 0, maxY));
  }
  const xl = [...xs].sort((a, b) => a - b);
  const yl = [...ys].sort((a, b) => a - b);
  let best: { pos: Pos; score: Score; dist: number } | null = null;
  for (const yPx of yl) {
    for (const xPx of xl) {
      const score = scoreAt(frame, { xPx, yPx, widthPx: w, heightPx: h });
      const dist = (xPx - idealX) ** 2 + (yPx - idealY) ** 2;
      const equal = best !== null && !worse(best.score, score) && !worse(score, best.score);
      if (!best || worse(best.score, score) || (equal && dist < best.dist)) best = { pos: { xPx, yPx }, score, dist };
    }
  }
  return { pos: best!.pos, score: best!.score };
}

export function planReframe(input: PlanReframeInput, options: PlanReframeOptions = {}): CropPlan {
  const srcW = Math.floor(input.sourceWidthPx);
  const srcH = Math.floor(input.sourceHeightPx);
  const tw = Math.floor(input.targetWidthPx ?? 1080);
  const th = Math.floor(input.targetHeightPx ?? 1920);
  if (!(srcW > 0 && srcH > 0 && tw > 0 && th > 0)) throw new RangeError("planReframe: source and target sizes must be positive integers");
  const maxZoom = Math.max(1000, Math.floor(options.maxZoomPermille ?? Math.round(REFRAME_MAX_ZOOM_DEFAULT * 1000)));
  const smoothingMs = Math.max(0, Math.floor(options.smoothingMs ?? REFRAME_SMOOTHING_MS_DEFAULT));
  const softCap = Math.min(maxZoom, Math.max(1000, Math.floor(options.softMaxZoomPermille ?? 1150)));
  const unavoidableMinPct = Math.min(100, Math.max(0, Math.floor(options.unavoidableMinPct ?? 0)));

  const primary = pickPrimary(input.subjects ?? [], options.preferredSubjectId);
  const samples = primary ? primary.samples.map((s) => ({ tMs: Math.max(0, Math.round(s.tMs)), box: s.box })).sort((a, b) => a.tMs - b.tMs) : [];
  const exclusions = (input.exclusions ?? []).filter((e) => area(e.box) > 0);
  const durationMs = Math.max(0, Math.round(input.durationMs ?? (samples.length ? samples[samples.length - 1]!.tMs : 0)));

  // Timeline: subject sample times plus every overlay on/off boundary, within [0, duration].
  // Detectors sample video frames inside the window (often first at ~300ms), but clip.prepare
  // requires the crop trajectory to cover the cut from its first frame at t=0.
  const times = new Set<number>([0, ...samples.map((s) => Math.min(s.tMs, durationMs))]);
  for (const e of exclusions) {
    if (e.startMs !== undefined) times.add(clamp(Math.round(e.startMs), 0, durationMs));
    if (e.endMs !== undefined) times.add(clamp(Math.round(e.endMs) - 1, 0, durationMs));
  }
  const timeline = [...times].sort((a, b) => a - b);
  const frames: Frame[] = timeline.map((tMs) => ({
    tMs,
    subject: samples.length ? boxAt(samples, tMs) : null,
    overlays: exclusions.filter((e) => !e.soft && (e.startMs === undefined || tMs >= e.startMs) && (e.endMs === undefined || tMs < e.endMs)).map((e) => e.box),
    soft: exclusions.filter((e) => e.soft && (e.startMs === undefined || tMs >= e.startMs) && (e.endMs === undefined || tMs < e.endMs)).map((e) => e.box),
  }));

  // One zoom for the whole clip (no pumping): the smallest that keeps the subject whole with no overlay; else the best worst-case.
  const zooms: number[] = [];
  for (let z = 1000; z < maxZoom; z += REFRAME_ZOOM_STEP_PERMILLE) zooms.push(z);
  zooms.push(maxZoom);
  let chosen: { zoom: number; w: number; h: number; raw: Pos[]; worst: Score } | null = null;
  for (const zoom of zooms) {
    const { w, h } = windowSize(srcW, srcH, tw, th, zoom);
    const results = frames.map((frame) => bestPosition(frame, srcW, srcH, w, h));
    const worst = results.reduce<Score>((acc, r) => ({ miss: Math.max(acc.miss, r.score.miss), overlay: Math.max(acc.overlay, r.score.overlay), soft: Math.max(acc.soft, r.score.soft) }), { miss: 0, overlay: 0, soft: 0 });
    // Zoom beyond `softCap` is never spent on soft regions alone: past it they stop counting in the comparison.
    const comparable: Score = zoom > softCap ? { ...worst, soft: 0 } : worst;
    if (!chosen || worse(chosen.worst, comparable)) chosen = { zoom, w, h, raw: results.map((r) => r.pos), worst: comparable };
    if (worst.miss === 0 && worst.overlay === 0 && (worst.soft === 0 || zoom >= softCap)) break;
  }
  const { zoom, w, h, raw } = chosen!;

  // Smooth, then limit pan speed; where that would make a frame worse than its raw choice (subject lost / overlay re-entered) keep the raw position.
  const maxX = Math.max(0, srcW - w);
  const maxY = Math.max(0, srcH - h);
  const speed = Math.max(1, Math.floor(options.maxPanPxPerSec ?? (w * REFRAME_MAX_PAN_PCT_PER_SEC_DEFAULT) / 100));
  const half = Math.floor(smoothingMs / 2);
  const smooth = (axis: "xPx" | "yPx", i: number) => {
    let total = 0;
    let n = 0;
    for (let j = 0; j < frames.length; j += 1) {
      if (Math.abs(frames[j]!.tMs - frames[i]!.tMs) <= half) {
        total += raw[j]![axis];
        n += 1;
      }
    }
    return Math.round(total / n);
  };
  const winOf = (p: Pos): PixelBox => ({ xPx: p.xPx, yPx: p.yPx, widthPx: w, heightPx: h });
  const finalPos: Pos[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    let candidate: Pos = { xPx: clamp(smooth("xPx", i), 0, maxX), yPx: clamp(smooth("yPx", i), 0, maxY) };
    if (i > 0) {
      const prev = finalPos[i - 1]!;
      const step = Math.floor((speed * (frames[i]!.tMs - frames[i - 1]!.tMs)) / 1000);
      candidate = { xPx: clamp(candidate.xPx, prev.xPx - step, prev.xPx + step), yPx: clamp(candidate.yPx, prev.yPx - step, prev.yPx + step) };
    }
    finalPos.push(worse(scoreAt(frames[i]!, winOf(candidate)), scoreAt(frames[i]!, winOf(raw[i]!))) ? raw[i]! : candidate);
  }

  // Keyframes: drop interior frames of constant runs; all-equal = static.
  const isStatic = finalPos.every((p) => p.xPx === finalPos[0]!.xPx && p.yPx === finalPos[0]!.yPx);
  const keyframes: CropKeyframe[] = isStatic
    ? [{ tMs: 0, xPx: finalPos[0]!.xPx, yPx: finalPos[0]!.yPx, widthPx: w, heightPx: h }]
    : finalPos
        .map((p, i) => ({ p, i }))
        .filter(({ p, i }) => {
          if (i === 0 || i === finalPos.length - 1) return true;
          const a = finalPos[i - 1]!;
          const b = finalPos[i + 1]!;
          return !(a.xPx === p.xPx && a.yPx === p.yPx && b.xPx === p.xPx && b.yPx === p.yPx);
        })
        .map(({ p, i }) => ({ tMs: frames[i]!.tMs, xPx: p.xPx, yPx: p.yPx, widthPx: w, heightPx: h }));

  let residual = 0;
  let coverage = 100;
  frames.forEach((frame, i) => {
    const win = winOf(finalPos[i]!);
    const overlayTotal = frame.overlays.reduce((total, box) => total + area(box), 0);
    if (overlayTotal > 0) residual = Math.max(residual, Math.ceil((frame.overlays.reduce((total, box) => total + intersectArea(box, win), 0) * 100) / overlayTotal));
    if (frame.subject && area(frame.subject) > 0) coverage = Math.min(coverage, Math.floor((intersectArea(frame.subject, win) * 100) / area(frame.subject)));
  });

  return {
    version: REFRAME_PLAN_VERSION,
    sourceWidthPx: srcW,
    sourceHeightPx: srcH,
    targetWidthPx: tw,
    targetHeightPx: th,
    durationMs,
    zoomPermille: zoom,
    mode: isStatic ? "static" : "keyframes",
    keyframes,
    primarySubjectId: primary?.subjectId ?? null,
    overlayUnavoidable: residual > unavoidableMinPct,
    residualOverlayPct: residual,
    subjectCoveragePct: coverage,
  };
}
