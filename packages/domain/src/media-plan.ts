/**
 * VE2E-31 (CR-JP-ONESHOT-MEDIA-2026-09-29 §4/§8): pure planning half of the one-shot background
 * media plan. No I/O - `apps/api/src/media-plan.service.ts` does the sourcing (Pexels search/rank/
 * moderation/import) and calls these functions before/after it.
 *
 * 1. `planBackgroundSegments` groups the script's scenes into background segments: the script's
 *    own `visualPlan` (VE2E-38) when it has one, adjusted to the run's segment-count range
 *    (VE2E-40) without ever splitting the main subject (priority 1); otherwise a deterministic
 *    duration-balanced grouping of consecutive scenes.
 * 2. `computeSegmentSourceRanges` cuts one source clip into contiguous, non-overlapping per-scene
 *    ranges sized by each scene's real voice duration, so footage runs on across scene boundaries.
 *
 * Every number marked PLACEHOLDER is untuned (same honesty rule as MEDIA_RELEVANCE_THRESHOLD):
 * Test/owner tune it against the VE2E-39 benchmark; Code does not claim these are right.
 */

export const MEDIA_PLAN_POLICY_VERSION = "media-plan-policy.v1";

/** PLACEHOLDER (untuned, CR §4 "~6s"): preferred minimum length of a background segment. Not applied to the first (hook) segment. */
export const MEDIA_PLAN_MIN_SEGMENT_MS = 6_000;
/** PLACEHOLDER (untuned, CR §4 "~20s"): preferred maximum length of a background segment. */
export const MEDIA_PLAN_MAX_SEGMENT_MS = 20_000;

export type MediaPlanScene = {
  sceneId: string;
  /** Real voice duration for the scene (AudioVersion.durationMs); callers fall back to the script's durationHintMs only when no audio exists yet. */
  durationMs: number;
};

/**
 * VE2E-88: segment keywords. `ja`/`en` are the first phrase as plain strings (every pre-88 reader keeps
 * working); the rest is optional/additive. `jaAll`/`enAll`/`broadEn` are the ordered search tiers (all
 * anchored on the video subject); `moodEn` is a generic backdrop for the photo/brand tiers (L5/L6) ONLY.
 * `subject`/`aliases`/`mustInclude`/`mustExclude` describe the video's main subject for candidate filters.
 */
export type SegmentKeywords = {
  ja: string;
  en: string;
  jaAll?: string[];
  enAll?: string[];
  broadEn?: string[];
  moodEn?: string;
  subject?: string;
  aliases?: string[];
  mustInclude?: string[];
  mustExclude?: string[];
  /** `videoSubject.kind` (person / group / team / place / event / other): `person` turns on the person-focused rules. */
  subjectKind?: string;
  /** `videoSubject.otherPeople`: other people the script names (context only). */
  otherPeople?: string[];
  /** `videoSubject.source`: who named a person subject (user > news > model). */
  targetSource?: string;
};

export type MediaPlanVideoSubject = { main: string; aliases?: string[]; mustInclude?: string[]; mustExclude?: string[]; kind?: string; otherPeople?: string[]; source?: string };

export type MediaPlanVisualSegment = {
  segmentId: string;
  sceneIds: string[];
  subject: string;
  priority: number;
  keywords: Omit<SegmentKeywords, "subject" | "aliases" | "mustInclude" | "mustExclude" | "subjectKind" | "otherPeople" | "targetSource">;
};

export type PlannedSegment = {
  segmentId: string;
  sceneIds: string[];
  subject: string | null;
  /** 1 = main subject; `null` for fallback groups (no plan to say). */
  priority: number | null;
  keywords: SegmentKeywords | null;
  durationMs: number;
  origin: "visual_plan" | "fallback";
  /** Kind the pinned template expects for this segment's scenes (set by `splitSegmentsByVisualKind`); undefined = legacy video behaviour. */
  visualKind?: "video" | "image";
};

export type SegmentCountRange = { min: number; max: number };

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * How many segments a duration-balanced fallback grouping uses: inside `range` (clamped to the
 * scene count), the smallest count whose average segment fits under MAX, but not so many that the
 * average drops under MIN (unless `range.min` forces it).
 */
export function chooseFallbackSegmentCount(totalMs: number, sceneCount: number, range: SegmentCountRange | null): number {
  if (sceneCount <= 0) return 0;
  const lo = Math.min(Math.max(1, range?.min ?? 1), sceneCount);
  const hi = Math.min(Math.max(lo, range?.max ?? sceneCount), sceneCount);
  let count = lo;
  while (count < hi && totalMs / count > MEDIA_PLAN_MAX_SEGMENT_MS && totalMs / (count + 1) >= MEDIA_PLAN_MIN_SEGMENT_MS) count += 1;
  return count;
}

/** Splits consecutive scenes into `count` groups with cumulative-duration boundaries as even as possible (deterministic). */
export function groupScenesByDuration(scenes: MediaPlanScene[], count: number): MediaPlanScene[][] {
  if (scenes.length === 0 || count <= 0) return [];
  const groups = Math.min(count, scenes.length);
  const total = sum(scenes.map((s) => Math.max(0, s.durationMs)));
  const result: MediaPlanScene[][] = [];
  let index = 0;
  let consumed = 0;
  for (let g = 0; g < groups; g += 1) {
    const remainingGroups = groups - g;
    const group: MediaPlanScene[] = [];
    if (remainingGroups === 1) {
      group.push(...scenes.slice(index));
      index = scenes.length;
    } else {
      const target = (total * (g + 1)) / groups;
      // Always take at least one scene, and leave at least one scene for each remaining group.
      while (index < scenes.length - (remainingGroups - 1)) {
        const scene = scenes[index]!;
        const next = consumed + Math.max(0, scene.durationMs);
        if (group.length > 0 && Math.abs(next - target) > Math.abs(consumed - target)) break;
        group.push(scene);
        consumed = next;
        index += 1;
      }
    }
    result.push(group);
  }
  return result;
}

const plannedKeywords = (segment: MediaPlanVisualSegment, videoSubject: MediaPlanVideoSubject | null | undefined): SegmentKeywords => {
  const k = segment.keywords;
  return {
    ja: k.ja,
    en: k.en,
    ...(k.jaAll ? { jaAll: [...k.jaAll] } : {}),
    ...(k.enAll ? { enAll: [...k.enAll] } : {}),
    ...(k.broadEn ? { broadEn: [...k.broadEn] } : {}),
    ...(k.moodEn ? { moodEn: k.moodEn } : {}),
    ...(videoSubject?.main ? { subject: videoSubject.main } : {}),
    ...(videoSubject?.aliases?.length ? { aliases: [...videoSubject.aliases] } : {}),
    ...(videoSubject?.mustInclude?.length ? { mustInclude: [...videoSubject.mustInclude] } : {}),
    ...(videoSubject?.mustExclude?.length ? { mustExclude: [...videoSubject.mustExclude] } : {}),
    ...(videoSubject?.kind ? { subjectKind: videoSubject.kind } : {}),
    ...(videoSubject?.otherPeople?.length ? { otherPeople: [...videoSubject.otherPeople] } : {}),
    ...(videoSubject?.source ? { targetSource: videoSubject.source } : {}),
  };
};

const toPlanned = (segment: MediaPlanVisualSegment, durations: Map<string, number>, videoSubject?: MediaPlanVideoSubject | null): PlannedSegment => ({
  segmentId: segment.segmentId,
  sceneIds: [...segment.sceneIds],
  subject: segment.subject || null,
  priority: segment.priority,
  keywords: plannedKeywords(segment, videoSubject),
  durationMs: sum(segment.sceneIds.map((id) => durations.get(id) ?? 0)),
  origin: "visual_plan",
});

const isMainSubject = (segment: PlannedSegment) => segment.priority === 1;

/**
 * Adjusts a (valid, full-coverage) visual plan to `range`:
 * - too many segments: repeatedly merge the adjacent pair with the smallest combined duration,
 *   preferring pairs that do not involve a main-subject segment; the merged segment keeps the
 *   higher-priority side's subject/keywords/id (merging never splits a subject).
 * - too few: repeatedly split the longest non-main-subject segment with >= 2 scenes at the scene
 *   boundary nearest its duration midpoint (second half id `<id>-b`, same keywords). If only
 *   main-subject segments remain splittable, the count stays below `range.min` - keeping the main
 *   subject whole wins over the count (CR §4).
 */
export function fitSegmentsToRange(segments: PlannedSegment[], range: SegmentCountRange | null, durations: Map<string, number>): PlannedSegment[] {
  if (!range) return segments;
  let result = segments.map((s) => ({ ...s, sceneIds: [...s.sceneIds] }));
  while (result.length > range.max && result.length > 1) {
    let best = -1;
    let bestKey: [number, number] | null = null;
    for (let i = 0; i < result.length - 1; i += 1) {
      const a = result[i]!;
      const b = result[i + 1]!;
      const key: [number, number] = [isMainSubject(a) || isMainSubject(b) ? 1 : 0, a.durationMs + b.durationMs];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        bestKey = key;
        best = i;
      }
    }
    const a = result[best]!;
    const b = result[best + 1]!;
    const keep = (b.priority ?? Number.MAX_SAFE_INTEGER) < (a.priority ?? Number.MAX_SAFE_INTEGER) ? b : a;
    const merged: PlannedSegment = { ...keep, sceneIds: [...a.sceneIds, ...b.sceneIds], durationMs: a.durationMs + b.durationMs };
    result = [...result.slice(0, best), merged, ...result.slice(best + 2)];
  }
  while (result.length < range.min) {
    let best = -1;
    for (let i = 0; i < result.length; i += 1) {
      const candidate = result[i]!;
      if (isMainSubject(candidate) || candidate.sceneIds.length < 2) continue;
      if (best === -1 || candidate.durationMs > result[best]!.durationMs) best = i;
    }
    if (best === -1) break;
    const target = result[best]!;
    const sceneDurations = target.sceneIds.map((id) => durations.get(id) ?? 0);
    let cut = 1;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let k = 1; k < target.sceneIds.length; k += 1) {
      const gap = Math.abs(sum(sceneDurations.slice(0, k)) - target.durationMs / 2);
      if (gap < bestGap) {
        bestGap = gap;
        cut = k;
      }
    }
    const first: PlannedSegment = { ...target, sceneIds: target.sceneIds.slice(0, cut), durationMs: sum(sceneDurations.slice(0, cut)) };
    // Splitting the same segment twice (or a segment whose `-b` already exists) must not mint a duplicate id: the timeline rejects it ("segmentId trùng lặp").
    const taken = new Set(result.map((segment) => segment.segmentId));
    let secondId = `${target.segmentId}-b`;
    for (let n = 2; taken.has(secondId); n += 1) secondId = `${target.segmentId}-b${n}`;
    const second: PlannedSegment = { ...target, segmentId: secondId, sceneIds: target.sceneIds.slice(cut), durationMs: sum(sceneDurations.slice(cut)) };
    result = [...result.slice(0, best), first, second, ...result.slice(best + 1)];
  }
  return result;
}

/** Whether a visual plan covers exactly these scenes, in order, as consecutive runs (the VE2E-38 normalizer already guarantees this for a parsed plan; re-checked here because the scene list may have changed since). */
const coversScenesInOrder = (plan: MediaPlanVisualSegment[], sceneIds: string[]) => {
  const flattened = plan.flatMap((segment) => segment.sceneIds);
  return flattened.length === sceneIds.length && flattened.every((id, index) => id === sceneIds[index]) && plan.every((segment) => segment.sceneIds.length > 0);
};

/** VE2E-88: default share of the video's duration given to the main subject (priority 1). Env `SUBJECT_SHARE_TARGET` (0..0.95, fraction or percent like "60"); invalid -> default. */
export const DEFAULT_SUBJECT_SHARE_TARGET = 0.6;
export const SUBJECT_SHARE_TARGET_MAX = 0.95;

export function subjectShareTargetFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SUBJECT_SHARE_TARGET;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SUBJECT_SHARE_TARGET;
  const fraction = n > 1 ? n / 100 : n;
  return Math.min(SUBJECT_SHARE_TARGET_MAX, fraction);
}

/** Fraction of the total duration that belongs to main-subject (priority 1) segments; 0 when there is no duration. */
export function mainSubjectShare(segments: PlannedSegment[]): number {
  const total = sum(segments.map((s) => s.durationMs));
  return total > 0 ? sum(segments.filter(isMainSubject).map((s) => s.durationMs)) / total : 0;
}

/**
 * VE2E-88 weighted allocation: when the main subject (priority 1) holds less than `target` of the
 * duration, move boundary scenes from the neighbouring non-main segments into the adjacent main
 * segment (one scene at a time, the scene next to the boundary whose move gets closest to the target
 * without overshooting by more than that scene), never emptying a non-main segment (each keeps >= 1
 * scene - related B-roll stays short but present) and never touching consecutive order. No-op when
 * there is no main segment, `target <= 0`, or the target is already met.
 */
export function allocateSubjectShare(segments: PlannedSegment[], scenes: MediaPlanScene[], target: number): PlannedSegment[] {
  if (!(target > 0) || !segments.some(isMainSubject)) return segments;
  const durations = new Map(scenes.map((scene) => [scene.sceneId, Math.max(0, scene.durationMs)]));
  const result = segments.map((s) => ({ ...s, sceneIds: [...s.sceneIds] }));
  const goal = Math.min(SUBJECT_SHARE_TARGET_MAX, target);
  const total = sum(result.map((s) => s.durationMs));
  if (total <= 0) return segments;
  const share = () => sum(result.filter(isMainSubject).map((s) => s.durationMs)) / total;
  const move = (from: number, to: number, takeFirst: boolean): boolean => {
    const source = result[from]!;
    if (source.sceneIds.length < 2 || isMainSubject(source)) return false;
    const sceneId = takeFirst ? source.sceneIds.shift()! : source.sceneIds.pop()!;
    const ms = durations.get(sceneId) ?? 0;
    const dest = result[to]!;
    if (takeFirst) dest.sceneIds.push(sceneId);
    else dest.sceneIds.unshift(sceneId);
    source.durationMs -= ms;
    dest.durationMs += ms;
    return true;
  };
  let guard = result.reduce((n, s) => n + s.sceneIds.length, 0);
  while (share() < goal && guard-- > 0) {
    let moved = false;
    for (let i = 0; i < result.length && share() < goal; i += 1) {
      if (!isMainSubject(result[i]!)) continue;
      // A non-main neighbour AFTER the main segment gives its first scene; one BEFORE gives its last scene.
      if (i + 1 < result.length && move(i + 1, i, true)) moved = true;
      if (share() >= goal) break;
      if (i > 0 && move(i - 1, i, false)) moved = true;
    }
    if (!moved) break;
  }
  return result;
}

export type PlanBackgroundOptions = {
  /** VE2E-88: the video's main subject (copied onto every planned segment's keywords for candidate filtering). */
  videoSubject?: MediaPlanVideoSubject | null;
  /** VE2E-88: opt-in weighted allocation target (fraction 0..0.95); see {@link allocateSubjectShare}. Absent = no re-allocation (pre-88 behaviour). */
  subjectShareTarget?: number | null;
};

export function planBackgroundSegments(
  scenes: MediaPlanScene[],
  visualPlan: { segments: MediaPlanVisualSegment[]; videoSubject?: MediaPlanVideoSubject | null } | null | undefined,
  range: SegmentCountRange | null,
  options: PlanBackgroundOptions = {},
): PlannedSegment[] {
  if (scenes.length === 0) return [];
  const durations = new Map(scenes.map((scene) => [scene.sceneId, Math.max(0, scene.durationMs)]));
  const sceneIds = scenes.map((scene) => scene.sceneId);
  if (visualPlan && visualPlan.segments.length > 0 && coversScenesInOrder(visualPlan.segments, sceneIds)) {
    const videoSubject = options.videoSubject ?? visualPlan.videoSubject ?? null;
    const fitted = fitSegmentsToRange(visualPlan.segments.map((segment) => toPlanned(segment, durations, videoSubject)), range, durations);
    return options.subjectShareTarget ? allocateSubjectShare(fitted, scenes, options.subjectShareTarget) : fitted;
  }
  const count = chooseFallbackSegmentCount(sum([...durations.values()]), scenes.length, range);
  // VE2E-151: an explicit subject (the user's target person) still binds the fallback segments (no visualPlan keywords: the subject only).
  const subjectOnly = options.videoSubject?.main ? plannedKeywords({ segmentId: "", sceneIds: [], subject: "", priority: 1, keywords: { ja: "", en: "" } }, options.videoSubject) : null;
  return groupScenesByDuration(scenes, count).map((group, index) => ({
    segmentId: `seg-${index + 1}`,
    sceneIds: group.map((scene) => scene.sceneId),
    subject: subjectOnly ? options.videoSubject!.main : null,
    priority: subjectOnly ? 1 : null,
    keywords: subjectOnly ? { ...subjectOnly } : null,
    durationMs: sum(group.map((scene) => Math.max(0, scene.durationMs))),
    origin: "fallback",
  }));
}

export type SceneSourceRange = { sceneId: string; sourceStartMs: number; sourceDurationMs: number; looped: boolean; short: boolean };

/**
 * Contiguous, non-overlapping per-scene ranges inside one source clip, in scene order, each sized
 * to the scene's voice duration.
 *
 * Source-too-short policy (chosen for v1, documented, CR §4 allowed "loop hoặc phủ bằng clip thứ
 * 2"): LOOP AT A SCENE BOUNDARY. When the next scene no longer fits in what is left of the source,
 * it restarts from 0 (`looped: true`) - the jump back happens only at a scene cut, never mid-scene,
 * and costs no extra provider search/import. A single scene longer than the whole source gets the
 * whole source (`short: true`, range shorter than the voice). A second same-keyword clip was not
 * chosen: it doubles search/import/moderation per short segment and still needs a policy for when
 * that clip is short too. Revisit after the VE2E-39 benchmark.
 *
 * Returns `null` when the source duration is unknown/non-positive (e.g. a photo, or a legacy asset
 * without duration) - callers then bind the asset without ranges, exactly as before VE2E-31.
 */
export function computeSegmentSourceRanges(scenes: MediaPlanScene[], sourceDurationMs: number | null | undefined): SceneSourceRange[] | null {
  if (typeof sourceDurationMs !== "number" || !Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) return null;
  const source = Math.floor(sourceDurationMs);
  const ranges: SceneSourceRange[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    const wanted = Math.max(1, Math.round(scene.durationMs));
    if (wanted >= source) {
      ranges.push({ sceneId: scene.sceneId, sourceStartMs: 0, sourceDurationMs: source, looped: cursor > 0, short: wanted > source });
      cursor = source;
      continue;
    }
    let looped = false;
    if (cursor + wanted > source) {
      cursor = 0;
      looped = true;
    }
    ranges.push({ sceneId: scene.sceneId, sourceStartMs: cursor, sourceDurationMs: wanted, looped, short: false });
    cursor += wanted;
  }
  return ranges;
}

/** VE2E-53: apify (social) clips start with the author's own intro and end with outro/watermark - keep ranges inside [startGuard, duration - endGuard]. */
export const SOCIAL_CLIP_START_GUARD_MS = 1_000;
export const SOCIAL_CLIP_END_GUARD_MS = 1_500;

export type SocialWindowOptions = { startGuardMs?: number; endGuardMs?: number };

export type SocialWindowPlan = {
  ranges: SceneSourceRange[];
  /** Usable window [startMs, endMs] inside the source (endMs - startMs may be <= 0 for tiny sources). */
  window: { startMs: number; endMs: number; usableMs: number };
  neededMs: number;
  coveredMs: number;
  /** The window cannot cover every scene: scenes after the covered part have no range; caller should fetch a second source for them (never loop overlapping footage). */
  needsSecondSource: boolean;
  /** Ids of the scenes that are not (fully) covered, in order (a partially covered scene is included). */
  uncoveredSceneIds: string[];
};

/** Reads guard overrides from env (`SOCIAL_CLIP_START_GUARD_MS` / `SOCIAL_CLIP_END_GUARD_MS`); invalid values fall back to the defaults. */
export function socialWindowOptionsFromEnv(env: Record<string, string | undefined> = process.env): Required<SocialWindowOptions> {
  const read = (value: string | undefined, fallback: number) => {
    const n = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return { startGuardMs: read(env.SOCIAL_CLIP_START_GUARD_MS, SOCIAL_CLIP_START_GUARD_MS), endGuardMs: read(env.SOCIAL_CLIP_END_GUARD_MS, SOCIAL_CLIP_END_GUARD_MS) };
}

/**
 * Deterministic window planner for origin=apify sources: contiguous, non-overlapping per-scene
 * ranges starting at `startGuardMs` and ending no later than `duration - endGuardMs`. NEVER loops:
 * when the usable window is shorter than the scenes, the last covered scene gets the remainder
 * (`short: true`), later scenes get no range and `needsSecondSource` is set. Returns `null` when the
 * source duration is unknown (caller keeps the legacy behaviour).
 */
export function computeSocialWindowRanges(scenes: MediaPlanScene[], sourceDurationMs: number | null | undefined, options: SocialWindowOptions = {}): SocialWindowPlan | null {
  if (typeof sourceDurationMs !== "number" || !Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) return null;
  const startGuard = Math.max(0, Math.floor(options.startGuardMs ?? SOCIAL_CLIP_START_GUARD_MS));
  const endGuard = Math.max(0, Math.floor(options.endGuardMs ?? SOCIAL_CLIP_END_GUARD_MS));
  const source = Math.floor(sourceDurationMs);
  const startMs = startGuard;
  const endMs = source - endGuard;
  const usableMs = Math.max(0, endMs - startMs);
  const wanted = scenes.map((scene) => Math.max(1, Math.round(scene.durationMs)));
  const neededMs = sum(wanted);
  const ranges: SceneSourceRange[] = [];
  const uncoveredSceneIds: string[] = [];
  let cursor = startMs;
  let remaining = usableMs;
  scenes.forEach((scene, index) => {
    const want = wanted[index]!;
    if (remaining <= 0) {
      uncoveredSceneIds.push(scene.sceneId);
      return;
    }
    const take = Math.min(want, remaining);
    ranges.push({ sceneId: scene.sceneId, sourceStartMs: cursor, sourceDurationMs: take, looped: false, short: take < want });
    if (take < want) uncoveredSceneIds.push(scene.sceneId);
    cursor += take;
    remaining -= take;
  });
  const coveredMs = sum(ranges.map((r) => r.sourceDurationMs));
  return { ranges, window: { startMs, endMs, usableMs }, neededMs, coveredMs, needsSecondSource: coveredMs < neededMs, uncoveredSceneIds };
}
