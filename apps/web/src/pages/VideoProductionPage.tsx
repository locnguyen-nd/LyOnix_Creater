import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { QueueBadge } from "../components/QueueStatus";
import { RunResultPlayer } from "../components/RunResultPlayer";
import { Button } from "../components/ui";
import { ApiError } from "../api";
import type { VideoProductionResponse, WorkflowRunStatus, WorkflowStepEventResponse } from "@lyonix/contracts";
import { SourceBadge } from "../studio/SourceBadge";
import { STAGE_COLORS, STAGE_KEYS, currentStage, formatElapsed, stageOfStep, summarizeStages, type StageKey } from "../video-production-stages";
import { getVideoProduction, getWorkerHealth, listVideoProductionEvents, retryVideoProduction } from "../video-productions-api";
import { overlayFallbackWarnings, personFocusWarnings } from "../person-focus";

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>(["completed", "failed", "cancelled"]);
// Matches video-productions.service.ts's own retriableStatuses — "cancelled" is deliberately
// not offered a one-click retry here.
const RETRIABLE_STATUSES = new Set<WorkflowRunStatus>(["failed", "blocked_provider", "needs_input"]);
const POLL_MS = 2500;

/** `{ language_mismatch: 3, too_short: 1 }` -> `language_mismatch x3, too_short x1`. */
const formatRejectReasons = (rejected: Record<string, number>) =>
  Object.entries(rejected).map(([reason, count]) => `${reason} x${count}`).join(", ") || "-";

function statusTone(status: WorkflowRunStatus) {
  if (status === "completed") return "ok" as const;
  if (status === "failed" || status === "cancelled") return "danger" as const;
  if (status === "blocked_provider" || status === "needs_input") return "warn" as const;
  return "neutral" as const;
}

const dotClass = (status: string) =>
  status === "done" ? "bg-lyx-ok" : status === "failed" ? "bg-lyx-danger" : status === "running" ? "border-2 border-lyx-fg bg-lyx-bg" : "bg-lyx-neutral-bg";

export function VideoProductionPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<VideoProductionResponse | null>(null);
  const [events, setEvents] = useState<WorkflowStepEventResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Bumped after a successful retry to re-run the polling effect below - the poll loop stops
  // its interval once it observes a TERMINAL_STATUSES status, so restarting it after the run
  // goes back to "draft" needs a fresh effect run, not just a state update inside the old one.
  const [refreshKey, setRefreshKey] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Render reliability: a run waiting in the queue says WHY when no workflow worker is running (instead of a silent wait).
  const [workerProblem, setWorkerProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const poll = () => {
      void Promise.all([getVideoProduction(id), listVideoProductionEvents(id)])
        .then(([nextRun, nextEvents]) => {
          if (cancelled) return;
          setRun(nextRun);
          setEvents(nextEvents);
          setNowMs(Date.now());
          if (nextRun.status === "draft") {
            void getWorkerHealth().then((health) => { if (!cancelled) setWorkerProblem(health.workflow.up ? null : health.problems[0] ?? null); }).catch(() => undefined);
          } else setWorkerProblem(null);
          if (TERMINAL_STATUSES.has(nextRun.status) && pollTimer.current) {
            clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
    };
    poll();
    pollTimer.current = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, refreshKey]);

  const retry = async () => {
    if (!run) return;
    setRetrying(true);
    setError(null);
    try {
      await retryVideoProduction(run.id);
      setRun((prev) => (prev ? { ...prev, status: "draft", lastError: null } : prev));
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setRetrying(false);
    }
  };

  if (error) return <Banner variant="danger">{error}</Banner>;
  if (!run) return <Banner variant="info">{t("common.loading")}</Banner>;

  // VE2E-151: the person-focus warnings of the quality gate (script drifts off the person / too little media naming the person).
  const personWarnings = personFocusWarnings(run.qualityGate);
  const overlayWarnings = overlayFallbackWarnings(run.qualityGate);
  const canOpenStudio = Boolean(run.scriptDraftVersionId);
  const isDone = run.status === "completed" && Boolean(run.resultUrl);
  const stages = summarizeStages(events, run, nowMs);
  const current = currentStage(stages);
  const finished = TERMINAL_STATUSES.has(run.status);
  const elapsedMs = (finished ? Date.parse(run.updatedAt) : nowMs) - Date.parse(run.createdAt);
  const doneCount = stages.filter((stage) => stage.status === "done").length;
  const stageEvents = (key: StageKey) => events.filter((event) => stageOfStep(event.stepKey) === key);

  return (
    <>
      <PageHeader
        title={t("videoProduction.title")}
        breadcrumb={run.id}
        actions={
          <>
            {RETRIABLE_STATUSES.has(run.status) ? (
              <Button variant="secondary" disabled={retrying} onClick={() => void retry()}>
                {retrying ? t("videoProduction.retrying") : t("videoProduction.retry")}
              </Button>
            ) : null}
            <Button variant="secondary" disabled={!canOpenStudio} onClick={() => navigate(`/video-productions/${run.id}/studio`)}>
              {t("videoProduction.openStudio")}
            </Button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <StatusPill tone={statusTone(run.status)}>{t(`videoProduction.status.${run.status}`)}</StatusPill>
        <QueueBadge status={run.status} queue={run.queue} />
        <span className="text-[11.5px] text-lyx-fg-muted">{t("videoProduction.attempts", { count: run.attempts })}</span>
        <span className="text-[11.5px] text-lyx-fg-muted">{t("videoProduction.elapsed", { time: formatElapsed(elapsedMs) })}</span>
        <span className="text-[11.5px] text-lyx-fg-muted">{t("videoProduction.stageProgress", { done: doneCount, total: STAGE_KEYS.length })}</span>
      </div>

      <div className="mb-5 flex gap-1" aria-hidden>
        {stages.map((stage) => (
          <i
            key={stage.key}
            className={`h-2 flex-1 rounded-full ${stage.status === "running" ? "animate-pulse" : ""}`}
            style={{ background: stage.status === "pending" ? "var(--lyx-neutral-bg)" : stage.status === "failed" ? "var(--lyx-danger)" : STAGE_COLORS[stage.key] }}
          />
        ))}
      </div>

      {run.status === "draft" && workerProblem ? <Banner variant="warn">{workerProblem}</Banner> : null}
      {run.status === "draft" && run.lastError?.retryAt && Date.parse(run.lastError.retryAt) > nowMs ? (
        <Banner variant="info">{t("videoProduction.retryScheduled", { time: new Date(run.lastError.retryAt).toLocaleTimeString(), reason: run.lastError.message })}</Banner>
      ) : run.lastError ? <Banner variant="danger">{run.lastError.message}</Banner> : null}
      {personWarnings.length > 0 ? (
        <Banner variant="warn">
          <span className="block font-semibold" data-testid="person-focus-warning">{t("videoProduction.personFocusTitle")}</span>
          {personWarnings.map((warning) => <span key={warning.code} className="block">{warning.detail}</span>)}
        </Banner>
      ) : null}
      {overlayWarnings.length > 0 ? (
        <Banner variant="info">
          <span className="block font-semibold" data-testid="overlay-fallback-warning">{t("videoProduction.overlayFallbackTitle")}</span>
          {overlayWarnings.map((warning) => <span key={warning.code} className="block">{warning.detail}</span>)}
        </Banner>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 rounded-xl border border-lyx-border bg-lyx-bg p-4">
          <p className="mb-4 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("videoProduction.historyTitle")}</p>
          {events.length === 0 ? <p className="text-[12.5px] text-lyx-fg-muted">{t("common.loading")}</p> : null}
          <ol>
            {stages.map((stage, index) => {
              const list = stageEvents(stage.key);
              const notable = list.filter((event) => event.status === "failed" || event.status === "running");
              const last = index === stages.length - 1;
              return (
                <li key={stage.key} className="flex gap-3" data-testid={`stage-${stage.key}`} aria-current={stage.key === current.key && stage.status === "running" ? "step" : undefined}>
                  <div className="flex flex-col items-center">
                    <span className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full ${dotClass(stage.status)}`} />
                    {!last ? <span className="w-px grow bg-lyx-border" /> : null}
                  </div>
                  <div className={`min-w-0 grow ${last ? "" : "pb-5"}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className={`text-[13.5px] font-semibold ${stage.status === "pending" ? "text-lyx-fg-muted" : ""}`}>{t(`videoProduction.stage.${stage.key}`)}</span>
                      <span className="shrink-0 text-[11.5px] text-lyx-fg-muted">
                        {stage.status === "pending"
                          ? t("videoProduction.stagePending")
                          : `${stage.stepsTotal > 1 ? `${stage.stepsDone}/${stage.stepsTotal} · ` : ""}${formatElapsed((stage.endMs ?? nowMs) - (stage.startMs ?? nowMs))}`}
                      </span>
                    </div>
                    {notable.length > 0 ? (
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {notable.map((event) => (
                          <li key={`${event.stepKey}-${event.attempt}`} className="flex items-center justify-between gap-3 text-[12px]">
                            <span>{event.stepKey}{event.attempt > 1 ? ` (×${event.attempt})` : ""}</span>
                            <span className={event.status === "failed" ? "text-lyx-danger" : "text-lyx-fg-muted"}>{event.error?.message ?? event.status}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {stage.key === "media" && run.mediaSourcing && run.mediaSourcing.length > 0 ? (
                      <div className="mt-3 overflow-hidden rounded-lg border border-lyx-border" data-testid="media-sourcing">
                        <p className="border-b border-lyx-border bg-lyx-bg-muted px-3 py-1.5 text-[11px] font-semibold text-lyx-fg-muted">{t("studioPro.sourcingTitle")}</p>
                        <ul>
                          {run.mediaSourcing.map((segment, segIndex) => (
                            <li key={segment.segmentId} className="border-b border-lyx-border px-3 py-2 text-[12.5px] last:border-b-0">
                              {segIndex + 1}. {segment.segmentId}
                              <SourceBadge diagnostic={segment} />
                              {segment.apifyQuality && segment.apifyQuality.considered > 0 ? (
                                <span className="mt-0.5 block text-[10px] text-lyx-fg-muted" data-testid="apify-quality">
                                  {t("studioPro.apifyQualityLine", { passed: segment.apifyQuality.passed, considered: segment.apifyQuality.considered, reasons: formatRejectReasons(segment.apifyQuality.rejected) })}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <div className="rounded-xl border border-lyx-border bg-lyx-bg p-4">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("videoProduction.reviewTitle")}</p>
            {isDone && run.resultUrl ? (
              <RunResultPlayer resultUrl={run.resultUrl} />
            ) : (
              <div className="flex h-[240px] w-full items-center justify-center rounded-[6px] bg-lyx-bg-muted px-4 text-center text-[12px] text-lyx-fg-muted">{t("videoProduction.resultPending")}</div>
            )}
          </div>

          {run.apifyUsage || run.visionUsage ? (
            <div className="rounded-xl border border-lyx-border bg-lyx-bg p-4">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("videoProduction.costTitle")}</p>
              {run.apifyUsage ? (
                <p className="text-[12px] text-lyx-fg-muted" data-testid="apify-usage">
                  <span className="font-semibold text-lyx-fg">{t("studioPro.apifyUsageTitle")}: </span>
                  {t("studioPro.apifyUsageLine", { runs: run.apifyUsage.runs, seconds: Math.round(run.apifyUsage.seconds), usd: run.apifyUsage.usd === null ? t("studioPro.apifyUsageUsdUnknown") : `$${run.apifyUsage.usd.toFixed(4)}` })}
                  {run.apifyUsage.searchesReused > 0 || run.apifyUsage.libraryReuses > 0 ? ` · ${t("studioPro.apifyUsageReuse", { searches: run.apifyUsage.searchesReused, library: run.apifyUsage.libraryReuses })}` : ""}
                </p>
              ) : null}
              {run.visionUsage ? (
                <p className="mt-2 text-[12px] text-lyx-fg-muted" data-testid="vision-usage">
                  <span className="font-semibold text-lyx-fg">{t("studioPro.visionUsageTitle")}: </span>
                  {t("studioPro.visionUsageLine", { calls: run.visionUsage.calls, max: run.visionUsage.maxCalls })}
                  {run.visionUsage.skippedSegments > 0 ? ` · ${t("studioPro.visionUsageSkipped", { count: run.visionUsage.skippedSegments })}` : ""}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
