/**
 * Stage timing of an Auto run and its render (render performance audit). Every stage emits ONE structured line
 *   [timing] {"scope":"run","id":"<runId>","stage":"generate_audio_S1","provider":"elevenlabs","durationMs":1830,...}
 * and is kept in memory so the run / render can persist the whole list as a `stage_timings` / `render_timings` StepRun
 * (read by `report:timing`). Lines never carry secrets, URLs or file paths: `detail` keeps numbers, booleans and short plain
 * identifiers only (see `sanitizeDetail`).
 */
export type StageCache = "hit" | "miss" | "n/a";
/** Where a stage spends its time: waiting on a remote provider, on our own CPU/disk, or in a queue. */
export type StageKind = "network" | "local" | "queue" | "wrapper";

export type StageTiming = {
  stage: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Run attempt (whole-pipeline retry counter) the stage ran in; 1 = first try. */
  attempt: number;
  provider: string | null;
  cache: StageCache;
  ok: boolean;
  code?: string;
  detail?: Record<string, string | number | boolean | null>;
};

type DetailValue = string | number | boolean | null | undefined;

/** Plain identifiers only (tier names, presets, codes): no `/`, no `:` runs, so a URL, path or token can never slip into a log line. */
const SAFE_STRING = /^[\w.\- ]{0,48}$/;

export function sanitizeDetail(detail: Record<string, DetailValue> | undefined): StageTiming["detail"] | undefined {
  if (!detail) return undefined;
  const clean: NonNullable<StageTiming["detail"]> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!/^[A-Za-z][\w]{0,40}$/.test(key) || value === undefined) continue;
    if (value === null || typeof value === "boolean") clean[key] = value;
    else if (typeof value === "number") { if (Number.isFinite(value)) clean[key] = Math.round(value * 1000) / 1000; }
    else if (SAFE_STRING.test(value)) clean[key] = value;
  }
  return Object.keys(clean).length ? clean : undefined;
}

export const timingLine = (scope: "run" | "render", id: string, timing: StageTiming): string =>
  `[timing] ${JSON.stringify({ scope, id, ...timing, ...(timing.detail ? { detail: sanitizeDetail(timing.detail) } : {}) })}`;

/** Collects the stages of one run / render job and logs each as it ends. */
export class StageRecorder {
  readonly events: StageTiming[] = [];

  constructor(
    readonly scope: "run" | "render",
    readonly id: string,
    private readonly sink: (line: string) => void = (line) => { if (process.env.NODE_ENV !== "test") console.info(line); },
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a stage that already happened (`startMs`..`endMs`, epoch ms). */
  add(stage: string, startMs: number, endMs: number, options: { attempt?: number; provider?: string | null; cache?: StageCache; ok?: boolean; code?: string; detail?: Record<string, DetailValue> } = {}): StageTiming {
    const detail = sanitizeDetail(options.detail);
    const timing: StageTiming = {
      stage,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      durationMs: Math.max(0, Math.round(endMs - startMs)),
      attempt: options.attempt ?? 1,
      provider: options.provider ?? null,
      cache: options.cache ?? "n/a",
      ok: options.ok ?? true,
      ...(options.code ? { code: options.code } : {}),
      ...(detail ? { detail } : {}),
    };
    this.events.push(timing);
    try {
      this.sink(timingLine(this.scope, this.id, timing));
    } catch {
      // logging must never break the pipeline
    }
    return timing;
  }

  /** A stage that was skipped because its result already existed (0 ms, cache hit). */
  hit(stage: string, options: { attempt?: number; provider?: string | null; detail?: Record<string, DetailValue> } = {}): StageTiming {
    const at = this.now();
    return this.add(stage, at, at, { ...options, cache: "hit" });
  }

  /** Times `fn`; `describe` may add cache / detail from its result. A thrown error is recorded (ok=false, its code) and rethrown. */
  async time<T>(stage: string, options: { attempt?: number; provider?: string | null; cache?: StageCache }, fn: () => Promise<T>, describe?: (value: T) => { cache?: StageCache; detail?: Record<string, DetailValue> }): Promise<T> {
    const startMs = this.now();
    try {
      const value = await fn();
      const extra = describe ? safeDescribe(describe, value) : {};
      this.add(stage, startMs, this.now(), { ...options, ...extra });
      return value;
    } catch (error) {
      this.add(stage, startMs, this.now(), { ...options, ok: false, code: errorCode(error) });
      throw error;
    }
  }
}

const safeDescribe = <T>(describe: (value: T) => { cache?: StageCache; detail?: Record<string, DetailValue> }, value: T) => {
  try {
    return describe(value);
  } catch {
    return {};
  }
};

const errorCode = (error: unknown): string => {
  const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : null;
  return typeof code === "string" && SAFE_STRING.test(code) ? code : "ERROR";
};

/**
 * What a stage waits on, by its key. `wrapper` stages (`voice_generation`, `media_sourcing`, `render_compose`) contain other
 * measured stages, so they are shown but never counted twice in the slowest list.
 */
export function stageKind(stage: string): StageKind {
  if (stage === "voice_generation" || stage === "media_sourcing" || stage === "render_compose" || stage === "run_pipeline") return "wrapper";
  if (stage === "render_queue_wait" || stage === "render_transport" || stage === "submit_render") return "queue";
  if (/^(generate_script|regenerate_script|extract_keywords|generate_audio_|import_media_|reuse_or_generate_script|media_l0_)/.test(stage)) return "network";
  return "local";
}

export type TimingSummary = {
  /** First start to last end over all stages (wall clock). */
  wallMs: number;
  /** Leaf stages (wrappers excluded), slowest first. */
  slowest: StageTiming[];
  byKind: Record<StageKind, number>;
  cacheHits: string[];
  failed: Array<{ stage: string; code: string | null; attempt: number }>;
  maxAttempt: number;
};

export function summarizeTimings(events: readonly StageTiming[]): TimingSummary {
  const byKind: Record<StageKind, number> = { network: 0, local: 0, queue: 0, wrapper: 0 };
  if (events.length === 0) return { wallMs: 0, slowest: [], byKind, cacheHits: [], failed: [], maxAttempt: 0 };
  const starts = events.map((event) => Date.parse(event.startedAt));
  const ends = events.map((event) => Date.parse(event.endedAt));
  for (const event of events) byKind[stageKind(event.stage)] += event.durationMs;
  return {
    wallMs: Math.max(...ends) - Math.min(...starts),
    slowest: events.filter((event) => stageKind(event.stage) !== "wrapper").sort((a, b) => b.durationMs - a.durationMs),
    byKind,
    cacheHits: events.filter((event) => event.cache === "hit").map((event) => event.stage),
    failed: events.filter((event) => !event.ok).map((event) => ({ stage: event.stage, code: event.code ?? null, attempt: event.attempt })),
    maxAttempt: Math.max(...events.map((event) => event.attempt)),
  };
}
