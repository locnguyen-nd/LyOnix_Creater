import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { Button } from "../components/ui";
import { ApiError } from "../api";
import type { VideoProductionResponse, WorkflowRunStatus, WorkflowStepEventResponse } from "@lyonix/contracts";
import { SourceBadge } from "../studio/SourceBadge";
import { getVideoProduction, listVideoProductionEvents, retryVideoProduction } from "../video-productions-api";

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

export function VideoProductionPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<VideoProductionResponse | null>(null);
  const [events, setEvents] = useState<WorkflowStepEventResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Bumped after a successful retry to re-run the polling effect below - the poll loop stops
  // its interval once it observes a TERMINAL_STATUSES status, so restarting it after the run
  // goes back to "draft" needs a fresh effect run, not just a state update inside the old one.
  const [refreshKey, setRefreshKey] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const poll = () => {
      void Promise.all([getVideoProduction(id), listVideoProductionEvents(id)])
        .then(([nextRun, nextEvents]) => {
          if (cancelled) return;
          setRun(nextRun);
          setEvents(nextEvents);
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

  const canOpenStudio = Boolean(run.scriptDraftVersionId);
  const isDone = run.status === "completed" && Boolean(run.resultUrl);

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
      <div className="mb-4 flex items-center gap-3">
        <StatusPill tone={statusTone(run.status)}>{t(`videoProduction.status.${run.status}`)}</StatusPill>
        <span className="text-[11.5px] text-lyx-fg-muted">{t("videoProduction.attempts", { count: run.attempts })}</span>
      </div>

      {run.lastError ? <Banner variant="danger">{run.lastError.message}</Banner> : null}

      {isDone && run.resultUrl ? (
        <div className="mb-5 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("videoProduction.reviewTitle")}</p>
          <video className="mb-3 max-h-[420px] rounded-[6px]" src={run.resultUrl} controls />
          <div className="flex gap-3">
            <a className="underline text-[12.5px]" href={run.resultUrl} target="_blank" rel="noreferrer">{t("videoProduction.openResult")}</a>
            <a className="underline text-[12.5px]" href={run.resultUrl} download>{t("videoProduction.download")}</a>
          </div>
        </div>
      ) : null}

      {run.mediaSourcing && run.mediaSourcing.length > 0 ? (
        <div className="mb-5 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4" data-testid="media-sourcing">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("studioPro.sourcingTitle")}</p>
          <ul className="flex flex-col gap-1.5">
            {run.mediaSourcing.map((segment, index) => (
              <li key={segment.segmentId} className="text-[12.5px]">
                {index + 1}. {segment.segmentId}
                <SourceBadge diagnostic={segment} />
                {segment.apifyQuality && segment.apifyQuality.considered > 0 ? (
                  <span className="mt-0.5 block text-[10px] text-lyx-fg-muted" data-testid="apify-quality">
                    {t("studioPro.apifyQualityLine", { passed: segment.apifyQuality.passed, considered: segment.apifyQuality.considered, reasons: formatRejectReasons(segment.apifyQuality.rejected) })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {run.apifyUsage ? (
            <p className="mt-3 text-[11.5px] text-lyx-fg-muted" data-testid="apify-usage">
              <span className="font-semibold">{t("studioPro.apifyUsageTitle")}: </span>
              {t("studioPro.apifyUsageLine", { runs: run.apifyUsage.runs, seconds: Math.round(run.apifyUsage.seconds), usd: run.apifyUsage.usd === null ? t("studioPro.apifyUsageUsdUnknown") : `$${run.apifyUsage.usd.toFixed(4)}` })}
              {run.apifyUsage.searchesReused > 0 || run.apifyUsage.libraryReuses > 0 ? ` · ${t("studioPro.apifyUsageReuse", { searches: run.apifyUsage.searchesReused, library: run.apifyUsage.libraryReuses })}` : ""}
            </p>
          ) : null}
          {run.visionUsage ? (
            <p className="mt-1 text-[11.5px] text-lyx-fg-muted" data-testid="vision-usage">
              <span className="font-semibold">{t("studioPro.visionUsageTitle")}: </span>
              {t("studioPro.visionUsageLine", { calls: run.visionUsage.calls, max: run.visionUsage.maxCalls })}
              {run.visionUsage.skippedSegments > 0 ? ` · ${t("studioPro.visionUsageSkipped", { count: run.visionUsage.skippedSegments })}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("videoProduction.historyTitle")}</p>
        <ul className="flex flex-col gap-1.5">
          {events.length === 0 ? <li className="text-[12.5px] text-lyx-fg-muted">{t("common.loading")}</li> : null}
          {events.map((event) => (
            <li key={`${event.stepKey}-${event.attempt}`} className="flex items-center justify-between text-[12.5px]">
              <span className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    event.status === "succeeded" ? "bg-lyx-ok" : event.status === "failed" ? "bg-lyx-danger" : event.status === "running" ? "bg-lyx-warn" : "bg-lyx-neutral-bg"
                  }`}
                />
                {event.stepKey}
                {event.attempt > 1 ? ` (×${event.attempt})` : ""}
              </span>
              <span className="text-lyx-fg-muted">{event.error?.message ?? event.status}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
