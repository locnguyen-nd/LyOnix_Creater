/**
 * VE2E-130 (CR-MEDIA-SLA-2026-10-07 §3.1/§7): pure helpers of the per-segment media ladder.
 *
 * - `parseSegmentKeywords`: reads the legacy `{ja, en}` keyword format AND the multi-tier format of
 *   VE2E-88 (`ja[]`, `en[]`, `broad_en[]`, `mood_en`), defensively (everything optional).
 * - `raceByPriority`: runs the tiers (ja > en > broad > Pexels) concurrently under one deadline and picks by priority.
 * - `findFreeWindow`: L4 - a window of an already chosen clip of the same job that no other segment uses.
 * - `kenBurnsFor`: L5 - deterministic pan/zoom parameters for a still image (applied by the render/media-worker, never FFmpeg in api).
 */

export const MEDIA_SEGMENT_DEADLINE_DEFAULT_MS = 75_000;

/** Per-segment deadline: env `MEDIA_SEGMENT_DEADLINE_MS` (positive integer ms), default 75 s. */
export const mediaSegmentDeadlineMs = (env: Record<string, string | undefined> = process.env): number => {
  const parsed = Number(env.MEDIA_SEGMENT_DEADLINE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : MEDIA_SEGMENT_DEADLINE_DEFAULT_MS;
};

export type ParsedSegmentKeywords = { ja: string[]; en: string[]; broad: string[]; mood: string | null };

const asList = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text && !out.some((existing) => existing.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

const firstDefined = (record: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
};

/**
 * Tolerant keyword reader. Accepts `{ja: string, en: string}` (legacy), `{ja: string[], en: string[], broad_en: string[], mood_en: string}`
 * (VE2E-88) and the camelCase / short aliases of those. Anything else yields empty lists. The `subject` is NOT mixed in here.
 */
export function parseSegmentKeywords(raw: unknown): ParsedSegmentKeywords {
  if (!raw || typeof raw !== "object") return { ja: [], en: [], broad: [], mood: null };
  const record = raw as Record<string, unknown>;
  return {
    // VE2E-88: `jaAll`/`enAll` are the full ordered lists next to the first-phrase strings `ja`/`en`.
    ja: asList([...asArray(record.ja), ...asArray(record.jaAll)]),
    en: asList([...asArray(record.en), ...asArray(record.enAll)]),
    broad: asList(firstDefined(record, ["broad_en", "broadEn", "broad"])),
    mood: asList(firstDefined(record, ["mood_en", "moodEn", "mood"]))[0] ?? null,
  };
}

export type KeywordTier = "ja" | "en" | "broad";

/**
 * The (at most 3) search keywords of a segment, in priority order ja > en > broad, each bound to the video's subject.
 * `isValidJa` filters the ja list (Japanese-script check lives in providers). A tier whose keyword repeats an earlier tier's is dropped
 * (no duplicate search). `broad` falls back to the segment's `subject` (never to `mood`, which is generic and only for L5/L6).
 */
export function segmentTierKeywords(raw: unknown, subject: string | null | undefined, isValidJa: (value: string) => boolean = () => true): Array<{ tier: KeywordTier; keyword: string }> {
  const parsed = parseSegmentKeywords(raw);
  const candidates: Array<{ tier: KeywordTier; keyword: string | null }> = [
    { tier: "ja", keyword: parsed.ja.find(isValidJa) ?? null },
    { tier: "en", keyword: parsed.en[0] ?? null },
    { tier: "broad", keyword: parsed.broad[0] ?? subject?.trim() ?? null },
  ];
  const seen = new Set<string>();
  const out: Array<{ tier: KeywordTier; keyword: string }> = [];
  for (const { tier, keyword } of candidates) {
    const text = keyword?.trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ tier, keyword: text });
  }
  return out;
}

export type RaceResult<T> = { index: number; value: T };

/**
 * Starts every task now. Picks by priority (lower index = higher priority): the best task that has produced a value wins as soon as
 * every higher-priority task has finished without one (so a slow ja search is awaited while en/Pexels are already done), or - at the
 * deadline - the best task that has a value so far. `null` = nothing (all tasks empty/failed, or deadline with no value).
 * A task that returns `null` or throws counts as "no value". `onDiscard` receives every value that is not chosen (also late ones),
 * so the caller can release reservations / clean up.
 */
export function raceByPriority<T>(tasks: ReadonlyArray<() => Promise<T | null>>, deadlineMs: number, discardHandler?: (index: number, value: T) => void): Promise<RaceResult<T> | null> {
  const onDiscard = discardHandler ? (index: number, value: T) => { try { discardHandler(index, value); } catch { /* cleanup is best-effort */ } } : undefined;
  return new Promise((resolve) => {
    const state: Array<"pending" | "value" | "none"> = tasks.map(() => "pending");
    const values: Array<T | null> = tasks.map(() => null);
    let decided = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (index: number | null) => {
      if (decided) return;
      decided = true;
      if (timer) clearTimeout(timer);
      for (let i = 0; i < tasks.length; i += 1) if (i !== index && state[i] === "value") onDiscard?.(i, values[i] as T);
      resolve(index === null ? null : { index, value: values[index] as T });
    };
    const evaluate = (final: boolean) => {
      for (let i = 0; i < tasks.length; i += 1) {
        if (state[i] === "value") return finish(i);
        if (state[i] === "pending" && !final) return;
      }
      if (final || state.every((entry) => entry !== "pending")) finish(null);
    };
    if (tasks.length === 0) return finish(null);
    tasks.forEach((task, index) => {
      void Promise.resolve()
        .then(task)
        .then(
          (value) => ({ value }),
          () => ({ value: null as T | null }),
        )
        .then(({ value }) => {
          if (value === null || value === undefined) state[index] = "none";
          else {
            state[index] = "value";
            values[index] = value;
          }
          if (decided) {
            if (state[index] === "value") onDiscard?.(index, value as T);
            return;
          }
          evaluate(false);
        });
    });
    timer = setTimeout(() => evaluate(true), Math.max(0, deadlineMs));
  });
}

export type ClipWindow = { startMs: number; endMs: number };
export type FreeWindowClip = { id: string; durationMs: number; usedWindows: readonly ClipWindow[]; startGuardMs?: number; endGuardMs?: number };
export type FreeWindowPick = { clipId: string; startMs: number; durationMs: number; full: boolean };

/**
 * L4: the best window of an already chosen clip that no earlier segment uses. Gaps are measured inside `[startGuard, duration - endGuard]`
 * minus the used windows. A gap that fits `neededMs` wins (`full: true`; the earliest such gap, shortest clip list order = given order);
 * otherwise the largest gap of at least `max(minPartialMs, minPartialRatio * neededMs)` is returned (`full: false`, the binding loops/ shortens).
 * `null` = no clip has a usable free window.
 */
export function findFreeWindow(clips: readonly FreeWindowClip[], neededMs: number, options: { minPartialRatio?: number; minPartialMs?: number } = {}): FreeWindowPick | null {
  const need = Math.max(1, Math.round(neededMs));
  const minPartial = Math.max(options.minPartialMs ?? 1_500, Math.round((options.minPartialRatio ?? 0.6) * need));
  let best: FreeWindowPick | null = null;
  for (const clip of clips) {
    if (!(clip.durationMs > 0)) continue;
    const lo = Math.max(0, clip.startGuardMs ?? 0);
    const hi = clip.durationMs - Math.max(0, clip.endGuardMs ?? 0);
    if (hi - lo <= 0) continue;
    const used = [...clip.usedWindows].filter((w) => w.endMs > lo && w.startMs < hi).sort((a, b) => a.startMs - b.startMs);
    const gaps: ClipWindow[] = [];
    let cursor = lo;
    for (const window of used) {
      if (window.startMs > cursor) gaps.push({ startMs: cursor, endMs: window.startMs });
      cursor = Math.max(cursor, window.endMs);
    }
    if (cursor < hi) gaps.push({ startMs: cursor, endMs: hi });
    for (const gap of gaps) {
      const length = gap.endMs - gap.startMs;
      if (length >= need) return { clipId: clip.id, startMs: gap.startMs, durationMs: need, full: true };
      if (length >= minPartial && (!best || length > best.durationMs)) best = { clipId: clip.id, startMs: gap.startMs, durationMs: length, full: false };
    }
  }
  return best;
}

export type KenBurnsPlan = {
  /** 1 = frame filled exactly; >1 = zoomed in. */
  zoomFrom: number;
  zoomTo: number;
  /** Normalised focus point (0..1) at the start / end of the move. */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs: number;
};

const KEN_BURNS_PRESETS: ReadonlyArray<Omit<KenBurnsPlan, "durationMs">> = [
  { zoomFrom: 1, zoomTo: 1.15, fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5 },
  { zoomFrom: 1.15, zoomTo: 1, fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.5 },
  { zoomFrom: 1.12, zoomTo: 1.12, fromX: 0.35, fromY: 0.5, toX: 0.65, toY: 0.5 },
  { zoomFrom: 1.12, zoomTo: 1.12, fromX: 0.65, fromY: 0.45, toX: 0.35, toY: 0.55 },
];

/** Deterministic slow zoom/pan for a still image scene; `index` varies the move between consecutive scenes. */
export function kenBurnsFor(index: number, durationMs: number): KenBurnsPlan {
  const preset = KEN_BURNS_PRESETS[((Math.trunc(index) % KEN_BURNS_PRESETS.length) + KEN_BURNS_PRESETS.length) % KEN_BURNS_PRESETS.length]!;
  return { ...preset, durationMs: Math.max(1, Math.round(durationMs)) };
}

export type DegradedTier = "reuse_window" | "stock_image" | "brand_background";
