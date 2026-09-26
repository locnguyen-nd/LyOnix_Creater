import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { Button } from "../components/ui";
import { ApiError } from "../api";
import type { VideoProductionResponse, WorkflowRunStatus, WorkflowStepEventResponse } from "@lyonix/contracts";
import { getVideoProduction, listVideoProductionEvents } from "../video-productions-api";

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>(["completed", "failed", "cancelled"]);
const POLL_MS = 2500;

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
  }, [id]);

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
          <Button variant="secondary" disabled={!canOpenStudio} onClick={() => navigate(`/video-productions/${run.id}/studio`)}>
            {t("videoProduction.openStudio")}
          </Button>
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
