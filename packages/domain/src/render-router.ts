/**
 * VE2E-109: Render Router - decides which engine renders a job. Pure (no I/O): the API gathers the facts (template, engine health, spend
 * so far) and applies the decision; this module only encodes the rules of docs/plans/self-render-engine.md §2, in this order, first match wins:
 *
 *  1. an admin forced an engine                                  -> that engine, `forced`
 *  2. the chosen template belongs to a paid provider              -> that provider, unchanged behaviour
 *       (`providerOnly` Creatomate template -> `template_requires_provider`; Orshot template -> `orshot_template`)
 *  3. an internal (`lyonix`) template:
 *       a. job outside the template's `rolloutPercent`            -> provider fallback, `canary_holdout`   (0 % = never use the internal engine)
 *       b. internal engine unhealthy                              -> provider fallback, `local_unhealthy`
 *       c. estimated wait > SLA and overflow is enabled           -> provider fallback, `overflow`          (overflow is OFF by default)
 *       d. otherwise                                              -> internal engine, `default`
 *  4. after an internal-engine technical failure                  -> ONE provider fallback, `fallback_after_error`
 *       (never for input-data errors, never twice)
 *
 * Every provider *fallback* (3a-3c, 4) is gated by the spend ceiling: over it the job is `blocked` with `budget_exhausted` and no provider is
 * called. Direct provider choices (1, 2) are the user's explicit decision and are not budget-gated here.
 */

export type RouterEngine = "lyonix" | "creatomate" | "orshot";

export type RouteReason =
  | "forced"
  | "template_requires_provider"
  | "orshot_template"
  | "canary_holdout"
  | "overflow"
  | "local_unhealthy"
  | "default"
  | "fallback_after_error"
  | "budget_exhausted";

export type RouterTemplate = {
  /** TemplateSnapshot id the user picked. */
  snapshotId: string;
  engine: RouterEngine;
  /** Uses a feature the internal engine cannot render (flip, per-letter text scale, ...): never routed to `lyonix`. */
  providerOnly: boolean;
  /** 0..100; share of eligible jobs that use the internal engine (internal templates only). */
  rolloutPercent: number;
  /** Provider snapshots equivalent to this internal template, in preference order (`TemplateSnapshot.fallbackSnapshotIds`). */
  fallbackSnapshots: Array<{ snapshotId: string; engine: Exclude<RouterEngine, "lyonix"> }>;
};

export type RouterConfig = {
  /** Allow sending jobs to a provider when the internal queue is too long. Default off. */
  overflowEnabled: boolean;
  /** Estimated wait (ms) above which `overflow` applies. */
  overflowSlaMs: number;
  /** Daily / monthly ceiling (USD) on provider spend caused by Router fallbacks. `null` monthly = no monthly ceiling. */
  fallbackDailyUsd: number;
  fallbackMonthlyUsd: number | null;
};

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  overflowEnabled: false,
  overflowSlaMs: 10 * 60_000,
  fallbackDailyUsd: 50,
  fallbackMonthlyUsd: null,
};

export type RouterInput = {
  /** Stable per-job seed (e.g. the request fingerprint): the same job always lands in the same canary bucket. */
  jobKey: string;
  /** Admin override; `null` for everyone else. */
  forcedEngine: RouterEngine | null;
  template: RouterTemplate;
  local: { healthy: boolean; estimatedWaitMs: number };
  spend: { todayUsd: number; monthUsd: number };
  /** Estimated cost (USD) of the provider render this job would fall back to. */
  fallbackCostUsd: number;
  /** Set when the internal engine already tried and failed technically. */
  afterError: { code: string; isInputError: boolean; alreadyFellBack: boolean } | null;
};

export type RouteDecision =
  | { kind: "route"; engine: RouterEngine; snapshotId: string; reason: RouteReason; isFallback: boolean }
  | { kind: "blocked"; reason: "budget_exhausted"; wouldRoute: { engine: RouterEngine; snapshotId: string; reason: RouteReason }; detail: string }
  | { kind: "fail"; code: "NO_FALLBACK_TEMPLATE" | "INPUT_ERROR" | "ALREADY_FELL_BACK"; message: string };

export type BudgetCheck = { ok: boolean; reason?: "daily" | "monthly"; remainingDailyUsd: number; remainingMonthlyUsd: number | null };

/** Would spending `costUsd` more stay within the daily (and monthly) ceiling? */
export function checkBudget(spend: RouterInput["spend"], costUsd: number, config: Pick<RouterConfig, "fallbackDailyUsd" | "fallbackMonthlyUsd">): BudgetCheck {
  const remainingDailyUsd = config.fallbackDailyUsd - spend.todayUsd;
  const remainingMonthlyUsd = config.fallbackMonthlyUsd === null ? null : config.fallbackMonthlyUsd - spend.monthUsd;
  if (costUsd > remainingDailyUsd + 1e-9) return { ok: false, reason: "daily", remainingDailyUsd, remainingMonthlyUsd };
  if (remainingMonthlyUsd !== null && costUsd > remainingMonthlyUsd + 1e-9) return { ok: false, reason: "monthly", remainingDailyUsd, remainingMonthlyUsd };
  return { ok: true, remainingDailyUsd, remainingMonthlyUsd };
}

/** FNV-1a (32-bit) -> bucket 0..99; deterministic, no crypto so it also runs in the browser. */
export function canaryBucket(templateId: string, jobKey: string): number {
  let hash = 0x811c9dc5;
  for (const ch of `${templateId}:${jobKey}`) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/** Is this job inside the template's rollout share? 0 % -> never, 100 % -> always. */
export const isInRollout = (template: Pick<RouterTemplate, "snapshotId" | "rolloutPercent">, jobKey: string): boolean =>
  template.rolloutPercent >= 100 || (template.rolloutPercent > 0 && canaryBucket(template.snapshotId, jobKey) < template.rolloutPercent);

/**
 * Rough provider price of a render (USD), used only to gate fallbacks against the budget ceiling. Creatomate bills `w x h x fps x seconds / 1e8`
 * credits (87 credits for 70 s of 1080p60 = ~$0.52 => ~$0.006/credit); Orshot bills 1 credit per second (~$0.33 per 70 s => ~$0.0047/credit).
 * The real cost is recorded from the provider's own report after the render (VE2E-110).
 */
export const PROVIDER_USD_PER_CREDIT = { creatomate: 0.006, orshot: 0.0047 } as const;

export function estimateProviderCostUsd(engine: Exclude<RouterEngine, "lyonix">, video: { durationSec: number; width: number; height: number; fps: number }): number {
  const credits = engine === "creatomate" ? (video.width * video.height * video.fps * video.durationSec) / 1e8 : video.durationSec;
  return Math.round(credits * PROVIDER_USD_PER_CREDIT[engine] * 10_000) / 10_000;
}

const pickFallback = (template: RouterTemplate) => template.fallbackSnapshots[0] ?? null;

export function routeRender(input: RouterInput, config: RouterConfig = DEFAULT_ROUTER_CONFIG): RouteDecision {
  const { template } = input;

  // 1. admin override
  if (input.forcedEngine) {
    if (input.forcedEngine === template.engine) return { kind: "route", engine: template.engine, snapshotId: template.snapshotId, reason: "forced", isFallback: false };
    const equivalent = template.fallbackSnapshots.find((s) => s.engine === input.forcedEngine);
    if (equivalent) return { kind: "route", engine: equivalent.engine, snapshotId: equivalent.snapshotId, reason: "forced", isFallback: false };
    return { kind: "fail", code: "NO_FALLBACK_TEMPLATE", message: `Mẫu này không có bản tương đương cho engine ${input.forcedEngine}` };
  }

  // 2. provider-owned template: unchanged behaviour
  if (template.engine !== "lyonix") {
    return { kind: "route", engine: template.engine, snapshotId: template.snapshotId, reason: template.engine === "orshot" ? "orshot_template" : "template_requires_provider", isFallback: false };
  }
  if (template.providerOnly) {
    const provider = pickFallback(template);
    if (!provider) return { kind: "fail", code: "NO_FALLBACK_TEMPLATE", message: "Mẫu cần provider nhưng chưa gắn mẫu provider" };
    return { kind: "route", engine: provider.engine, snapshotId: provider.snapshotId, reason: "template_requires_provider", isFallback: false };
  }

  const fallbackTo = (reason: Extract<RouteReason, "canary_holdout" | "local_unhealthy" | "overflow" | "fallback_after_error">): RouteDecision => {
    const provider = pickFallback(template);
    if (!provider) return { kind: "fail", code: "NO_FALLBACK_TEMPLATE", message: "Engine nội bộ không dùng được và mẫu chưa có mẫu provider dự phòng" };
    const budget = checkBudget(input.spend, input.fallbackCostUsd, config);
    if (!budget.ok) {
      return {
        kind: "blocked",
        reason: "budget_exhausted",
        wouldRoute: { engine: provider.engine, snapshotId: provider.snapshotId, reason },
        detail: `Trần chi phí dự phòng ${budget.reason === "monthly" ? "tháng" : "ngày"} đã hết (còn ${(budget.reason === "monthly" ? budget.remainingMonthlyUsd : budget.remainingDailyUsd)?.toFixed(2)} USD, cần ~${input.fallbackCostUsd.toFixed(2)})`,
      };
    }
    return { kind: "route", engine: provider.engine, snapshotId: provider.snapshotId, reason, isFallback: true };
  };

  // 4. after a technical failure of the internal engine (checked before the rollout rules: it applies to a job already routed to `lyonix`)
  if (input.afterError) {
    if (input.afterError.isInputError) return { kind: "fail", code: "INPUT_ERROR", message: `Lỗi dữ liệu đầu vào (${input.afterError.code}): provider cũng sẽ lỗi, không dự phòng` };
    if (input.afterError.alreadyFellBack) return { kind: "fail", code: "ALREADY_FELL_BACK", message: "Đã dự phòng một lần, không dự phòng tiếp" };
    return fallbackTo("fallback_after_error");
  }

  // 3. internal template
  if (!isInRollout(template, input.jobKey)) return fallbackTo("canary_holdout");
  if (!input.local.healthy) return fallbackTo("local_unhealthy");
  if (config.overflowEnabled && input.local.estimatedWaitMs > config.overflowSlaMs) return fallbackTo("overflow");
  return { kind: "route", engine: "lyonix", snapshotId: template.snapshotId, reason: "default", isFallback: false };
}
