/**
 * VE2E-85 (CR-MEDIA-SLA §3.1/§7): pre-render quality gate. Pure functions - no DB/provider access, no FFmpeg.
 * Checks the planned timeline, auto-corrects what it can (repeated clip windows, low-resolution sources) and reports the rest.
 * A missing/degraded source (ladder L4-L6, `quality_degraded`) NEVER fails the job - it is only reported.
 * Person mode (the subject is one person, `input.person`): the script focus and the share of the video showing media that names the
 * person are reported with a clear warning; only `PERSON_FOCUS_STRICT=1` turns a low share into a failure.
 */
import { checkDurationBand, type DurationBandCheck } from "./duration-budget.js";
import { findFreeWindow, type ClipWindow } from "./media-ladder.js";
import { assessPersonMediaCoverage, PERSON_MEDIA_MIN_SHARE, type PersonMatchLevel, type PersonMediaCoverage, type ScriptPersonFocus } from "./person-target.js";

export const QUALITY_GATE_DEFAULT_REPEAT_WINDOW = 3;
export const QUALITY_GATE_DEFAULT_MIN_SHORT_SIDE_PX = 480;
/** Overlap shorter than this is not a visible repeat. */
export const QUALITY_GATE_MIN_OVERLAP_MS = 250;
export const QUALITY_GATE_MAX_SUBTITLE_LINES = 2;
/** Conservative characters per caption line (portrait 9:16): CJK glyphs are wide. */
export const QUALITY_GATE_CHARS_PER_LINE = { cjk: 14, latin: 26 } as const;

export type QualityGateScene = {
  sceneId: string;
  segmentId: string | null;
  assetId: string | null;
  kind: "video" | "image" | null;
  sourceStartMs: number | null;
  sourceDurationMs: number | null;
  /** Real on-timeline duration of this scene (voice duration). */
  sceneDurationMs: number;
  narration: string;
  /** VE2E-130 ladder level L4-L6 of this scene's source; absent = a normal source. */
  degradedTier?: "reuse_window" | "stock_image" | "brand_background" | null;
  /** Person mode: does this scene's source name the person (`verified` / `metadata`) or is it generic stock / a placeholder? */
  personMatch?: PersonMatchLevel | null;
};

export type QualityGateAsset = { id: string; kind: "video" | "image"; durationMs: number | null; widthPx: number | null; heightPx: number | null };

export type QualityGateConfig = {
  enabled: boolean;
  repeatWindow: number;
  minShortSidePx: number;
  /** Person mode: minimum share of the duration with media naming the person (default {@link PERSON_MEDIA_MIN_SHARE}). */
  personMinShare: number;
  /** Person mode: a share below the minimum fails the gate instead of only warning (`PERSON_FOCUS_STRICT=1`). */
  personStrict: boolean;
};

export type QualityGateFix =
  | { type: "window_changed"; sceneId: string; assetId: string; fromStartMs: number; toStartMs: number; reason: "repeat" | "low_resolution" }
  | { type: "source_swapped"; sceneId: string; segmentId: string; fromAssetId: string; toAssetId: string; toStartMs: number; reason: "repeat" | "low_resolution" };

export type QualityGateWarning = {
  code: "repeat_unfixed" | "duration_out_of_band" | "subtitle_over_lines" | "low_resolution" | "quality_degraded" | "script_off_target" | "person_media_low_confidence";
  sceneId?: string;
  detail: string;
};

export type QualityGateCheckName = "repeat_scenes" | "duration_band" | "subtitle_lines" | "min_resolution" | "source_degraded" | "range_valid" | "script_person_focus" | "person_media";
export type QualityGateCheck = { name: QualityGateCheckName; status: "ok" | "fixed" | "warning" | "failed"; detail?: string };

export type QualityGateFailure = { code: "invalid_range" | "person_low_confidence"; sceneId: string; reason: string };

export type QualityGateResult = {
  enabled: boolean;
  checks: QualityGateCheck[];
  fixes: QualityGateFix[];
  warnings: QualityGateWarning[];
  /** Scenes after the auto-corrections (same order/length as the input). */
  scenes: QualityGateScene[];
  duration: DurationBandCheck | null;
  degraded: { count: number; sceneIds: string[]; tiers: Record<string, number> };
  failure: QualityGateFailure | null;
  /** Person mode only: share of the duration showing media that names the person. */
  personMedia?: PersonMediaCoverage;
};

export function qualityGateConfigFromEnv(env: Record<string, string | undefined> = process.env): QualityGateConfig {
  const int = (raw: string | undefined, fallback: number, min: number) => {
    const value = Number(raw);
    return raw !== undefined && Number.isFinite(value) && value >= min ? Math.trunc(value) : fallback;
  };
  const flag = env.QUALITY_GATE?.trim().toLowerCase();
  const share = Number(env.QUALITY_GATE_PERSON_MIN_SHARE);
  return {
    enabled: flag !== "0" && flag !== "false" && flag !== "off",
    repeatWindow: int(env.QUALITY_GATE_REPEAT_WINDOW, QUALITY_GATE_DEFAULT_REPEAT_WINDOW, 1),
    minShortSidePx: int(env.QUALITY_GATE_MIN_SHORT_SIDE_PX, QUALITY_GATE_DEFAULT_MIN_SHORT_SIDE_PX, 1),
    personMinShare: env.QUALITY_GATE_PERSON_MIN_SHARE !== undefined && Number.isFinite(share) && share >= 0 && share <= 1 ? share : PERSON_MEDIA_MIN_SHARE,
    personStrict: /^(1|true|on)$/i.test(env.PERSON_FOCUS_STRICT?.trim() ?? ""),
  };
}

const CJK = /[぀-ヿ㐀-鿿ｦ-ﾟ가-힯]/;

/** Estimated caption lines for a narration: CJK-dominant text wraps by glyph count, other text by words. */
export function estimateCaptionLines(text: string): number {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return 0;
  const glyphs = [...clean];
  const cjk = glyphs.filter((ch) => CJK.test(ch)).length;
  if (cjk >= glyphs.length / 2) return Math.ceil(glyphs.length / QUALITY_GATE_CHARS_PER_LINE.cjk);
  const max = QUALITY_GATE_CHARS_PER_LINE.latin;
  let lines = 1;
  let width = 0;
  for (const word of clean.split(" ")) {
    const need = width === 0 ? word.length : word.length + 1;
    if (width > 0 && width + need > max) {
      lines += 1;
      width = word.length;
    } else {
      width += need;
    }
    while (width > max) {
      lines += 1;
      width -= max;
    }
  }
  return lines;
}

const rangeOf = (scene: QualityGateScene): ClipWindow | null => {
  if (scene.kind !== "video" || scene.sourceStartMs === null || scene.sourceDurationMs === null) return null;
  return { startMs: scene.sourceStartMs, endMs: scene.sourceStartMs + scene.sourceDurationMs };
};
const overlapMs = (a: ClipWindow, b: ClipWindow) => Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);

export function runQualityGate(input: {
  scenes: readonly QualityGateScene[];
  assets: readonly QualityGateAsset[];
  targetSec: number;
  config?: Partial<QualityGateConfig>;
  /** Person mode (the subject is one person): the script focus check (computed by the caller from the script) turns on the person checks. */
  person?: { focus: ScriptPersonFocus | null; name: string } | null;
}): QualityGateResult {
  const config: QualityGateConfig = { ...qualityGateConfigFromEnv({}), ...input.config };
  const scenes = input.scenes.map((scene) => ({ ...scene }));
  const empty: QualityGateResult = { enabled: false, checks: [], fixes: [], warnings: [], scenes, duration: null, degraded: { count: 0, sceneIds: [], tiers: {} }, failure: null };
  if (!config.enabled) return empty;
  const assets = new Map(input.assets.map((asset) => [asset.id, asset] as const));
  const fixes: QualityGateFix[] = [];
  const warnings: QualityGateWarning[] = [];
  const checks: QualityGateCheck[] = [];

  // (0) structural: a video scene must have a usable range (a missing source is degraded, never failed).
  let failure: QualityGateFailure | null = null;
  for (const scene of scenes) {
    if (scene.kind !== "video" || !scene.assetId || scene.sourceDurationMs === null) continue;
    const badDuration = !Number.isFinite(scene.sourceDurationMs) || scene.sourceDurationMs <= 0;
    const badStart = scene.sourceStartMs !== null && (!Number.isFinite(scene.sourceStartMs) || scene.sourceStartMs < 0);
    if (badDuration || badStart) {
      failure = { code: "invalid_range", sceneId: scene.sceneId, reason: `Cảnh ${scene.sceneId}: khoảng cắt nguồn không hợp lệ (start=${scene.sourceStartMs}, duration=${scene.sourceDurationMs})` };
      break;
    }
  }
  if (failure) return { ...empty, enabled: true, checks: [{ name: "range_valid", status: "failed", detail: failure.reason }], failure };
  checks.push({ name: "range_valid", status: "ok" });

  const usedWindowsOf = (assetId: string, exceptIndex: number): ClipWindow[] =>
    scenes.flatMap((scene, index) => {
      if (index === exceptIndex || scene.assetId !== assetId) return [];
      const range = rangeOf(scene);
      return range ? [range] : [];
    });
  const segmentSize = (segmentId: string | null) => (segmentId ? scenes.filter((scene) => scene.segmentId === segmentId).length : 1);
  /** An alternative window: first inside the SAME clip, then inside another video clip of this job (only a single-scene segment may switch clip). */
  const findAlternative = (index: number, avoid: (asset: QualityGateAsset) => boolean): { assetId: string; startMs: number } | null => {
    const scene = scenes[index]!;
    const need = Math.max(1, Math.round(scene.sourceDurationMs ?? scene.sceneDurationMs));
    const candidates = [...assets.values()].filter((asset) => asset.kind === "video" && (asset.durationMs ?? 0) > 0 && !avoid(asset));
    const clips = (list: QualityGateAsset[]) => list.map((asset) => ({ id: asset.id, durationMs: asset.durationMs!, usedWindows: usedWindowsOf(asset.id, index) }));
    const sameClip = scene.assetId ? candidates.filter((asset) => asset.id === scene.assetId) : [];
    const others = segmentSize(scene.segmentId) === 1 ? candidates.filter((asset) => asset.id !== scene.assetId) : [];
    for (const list of [sameClip, others]) {
      const pick = findFreeWindow(clips(list), need);
      if (pick?.full) return { assetId: pick.clipId, startMs: pick.startMs };
    }
    return null;
  };
  const applyAlternative = (index: number, alt: { assetId: string; startMs: number }, reason: "repeat" | "low_resolution") => {
    const scene = scenes[index]!;
    if (alt.assetId === scene.assetId) {
      fixes.push({ type: "window_changed", sceneId: scene.sceneId, assetId: alt.assetId, fromStartMs: scene.sourceStartMs ?? 0, toStartMs: alt.startMs, reason });
    } else {
      fixes.push({ type: "source_swapped", sceneId: scene.sceneId, segmentId: scene.segmentId ?? scene.sceneId, fromAssetId: scene.assetId ?? "", toAssetId: alt.assetId, toStartMs: alt.startMs, reason });
      scene.assetId = alt.assetId;
      scene.kind = "video";
      scene.degradedTier = null;
    }
    scene.sourceStartMs = alt.startMs;
  };

  // (4) minimum resolution first, so the repeat check sees the final clip choice.
  const tooSmall = (assetId: string | null) => {
    const asset = assetId ? assets.get(assetId) : undefined;
    if (!asset || asset.widthPx === null || asset.heightPx === null) return false;
    return Math.min(asset.widthPx, asset.heightPx) < config.minShortSidePx;
  };
  const resolutionFixesBefore = fixes.length;
  let lowRes = 0;
  scenes.forEach((scene, index) => {
    if (!tooSmall(scene.assetId)) return;
    lowRes += 1;
    const alt = scene.kind === "video" ? findAlternative(index, (asset) => tooSmall(asset.id)) : null;
    if (alt) applyAlternative(index, alt, "low_resolution");
    else warnings.push({ code: "low_resolution", sceneId: scene.sceneId, detail: `Nguồn ${scene.assetId} dưới ${config.minShortSidePx}px cạnh ngắn, không có nguồn thay thế` });
  });
  const lowResFixed = fixes.length - resolutionFixesBefore;
  checks.push({ name: "min_resolution", status: lowRes === 0 ? "ok" : lowResFixed === lowRes ? "fixed" : "warning", ...(lowRes ? { detail: `${lowRes} cảnh dưới tối thiểu, ${lowResFixed} đã thay` } : {}) });

  // (1) repeated clip / window within N adjacent scenes. Only the later scene moves.
  const repeatFixesBefore = fixes.length;
  let repeats = 0;
  let repeatsUnfixed = 0;
  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i]!;
    if (!scene.assetId) continue;
    const range = rangeOf(scene);
    const clash = (j: number) => {
      const other = scenes[j]!;
      if (other.assetId !== scene.assetId || (scene.segmentId !== null && other.segmentId === scene.segmentId)) return false;
      const otherRange = rangeOf(other);
      if (!range || !otherRange) return scene.kind === "image" && other.kind === "image"; // the same still twice cannot be re-windowed
      return overlapMs(range, otherRange) >= QUALITY_GATE_MIN_OVERLAP_MS;
    };
    const from = Math.max(0, i - config.repeatWindow);
    const clashes = Array.from({ length: i - from }, (_, k) => from + k).filter(clash);
    if (clashes.length === 0) continue;
    repeats += 1;
    const alt = scene.kind === "video" ? findAlternative(i, (asset) => tooSmall(asset.id)) : null;
    if (alt) applyAlternative(i, alt, "repeat");
    else {
      repeatsUnfixed += 1;
      warnings.push({ code: "repeat_unfixed", sceneId: scene.sceneId, detail: `Cảnh ${scene.sceneId} lặp ${scenes[clashes[0]!]!.sceneId} (cùng nguồn/cửa sổ), không có cửa sổ hoặc nguồn khác trong job` });
    }
  }
  const repeatFixed = fixes.length - repeatFixesBefore;
  checks.push({ name: "repeat_scenes", status: repeats === 0 ? "ok" : repeatsUnfixed === 0 ? "fixed" : "warning", ...(repeats ? { detail: `${repeats} cảnh lặp trong ${config.repeatWindow} cảnh liền kề, ${repeatFixed} đã sửa` } : {}) });

  // (2) total duration band (VE2E-54 logic). The voice length is fixed at this point: report only.
  const totalMs = scenes.reduce((sum, scene) => sum + Math.max(0, scene.sceneDurationMs), 0);
  const duration = checkDurationBand({ targetSec: input.targetSec, totalMs });
  if (!duration.inBand) warnings.push({ code: "duration_out_of_band", detail: `Tổng ${duration.totalSec.toFixed(1)}s lệch ${duration.deviationSec.toFixed(1)}s so với mục tiêu ${duration.targetSec}s (±${duration.toleranceSec}s)` });
  checks.push({ name: "duration_band", status: duration.inBand ? "ok" : "warning", detail: `${duration.totalSec.toFixed(1)}s / ${duration.targetSec}s` });

  // (3) subtitle > 2 lines (caption-ass splits such a cue into consecutive cues at render; reported, not blocked).
  const longCaptions = scenes.filter((scene) => estimateCaptionLines(scene.narration) > QUALITY_GATE_MAX_SUBTITLE_LINES);
  for (const scene of longCaptions) warnings.push({ code: "subtitle_over_lines", sceneId: scene.sceneId, detail: `Phụ đề ước tính ${estimateCaptionLines(scene.narration)} dòng (> ${QUALITY_GATE_MAX_SUBTITLE_LINES}); render sẽ tách thành nhiều cue` });
  checks.push({ name: "subtitle_lines", status: longCaptions.length ? "warning" : "ok", ...(longCaptions.length ? { detail: `${longCaptions.length} cảnh` } : {}) });

  // (5) degraded sources (never fails the job).
  const degradedScenes = scenes.filter((scene) => scene.degradedTier);
  const tiers: Record<string, number> = {};
  for (const scene of degradedScenes) tiers[scene.degradedTier!] = (tiers[scene.degradedTier!] ?? 0) + 1;
  if (degradedScenes.length) warnings.push({ code: "quality_degraded", detail: `${degradedScenes.length} cảnh dùng nguồn bậc thấp (${Object.entries(tiers).map(([tier, n]) => `${tier}:${n}`).join(", ")}); job vẫn render` });
  checks.push({ name: "source_degraded", status: degradedScenes.length ? "warning" : "ok", ...(degradedScenes.length ? { detail: `${degradedScenes.length} cảnh` } : {}) });

  // (6) person mode: the script stays on the person, and most of the video shows media naming the person (not stock / a placeholder).
  let personMedia: PersonMediaCoverage | undefined;
  let personFailure: QualityGateFailure | null = null;
  if (input.person) {
    const name = input.person.name;
    const focus = input.person.focus;
    if (focus) {
      if (!focus.ok) warnings.push({ code: "script_off_target", detail: `Kịch bản chưa bám sát ${name}: ${focus.reasons.join(", ")} (độ phủ tên ${Math.round(focus.coverage * 100)}%${focus.dominantOther ? `, nhắc ${focus.dominantOther} nhiều hơn` : ""})` });
      checks.push({ name: "script_person_focus", status: focus.ok ? "ok" : "warning", detail: `${Math.round(focus.coverage * 100)}% cảnh nhắc ${name}` });
    }
    personMedia = assessPersonMediaCoverage(scenes.map((scene) => ({ durationMs: scene.sceneDurationMs, personMatch: scene.personMatch ?? null })), config.personMinShare);
    const detail = `${Math.round(personMedia.onTargetShare * 100)}% thời lượng có media đúng ${name} (tối thiểu ${Math.round(config.personMinShare * 100)}%), ${Math.round(personMedia.genericShare * 100)}% là media chung/stock`;
    if (personMedia.lowConfidence) {
      warnings.push({ code: "person_media_low_confidence", detail: `Không đủ media chắc chắn là ${name}: ${detail}` });
      if (config.personStrict) personFailure = { code: "person_low_confidence", sceneId: scenes[0]?.sceneId ?? "", reason: `Không đủ media chắc chắn là ${name} (${detail}); PERSON_FOCUS_STRICT=1 chặn render` };
    }
    checks.push({ name: "person_media", status: personFailure ? "failed" : personMedia.lowConfidence ? "warning" : "ok", detail });
  }

  return { enabled: true, checks, fixes, warnings, scenes, duration, degraded: { count: degradedScenes.length, sceneIds: degradedScenes.map((scene) => scene.sceneId), tiers }, failure: personFailure, ...(personMedia ? { personMedia } : {}) };
}
