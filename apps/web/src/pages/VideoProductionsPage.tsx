import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../components/feedback";
import { useNavigate } from "react-router-dom";
import { Ban, Clock3, Play, RotateCw, Trash2, Wallet } from "lucide-react";
import { Banner, EmptyState, PageHeader, SkeletonCards, SkeletonRows, StatusPill } from "../components/chrome";
import { SegmentedTabs } from "../components/motion";
import { QueueBadge, QueueSummaryBar } from "../components/QueueStatus";
import { Button } from "../components/ui";
import { VideoPlayerDialog, VideoThumbnail } from "../components/VideoMedia";
import { AutoRunTimeline } from "../components/AutoRunTimeline";
import { ApiError } from "../api";
import type { VideoProductionListItemResponse, WorkflowRunStatus, WorkflowStepEventResponse } from "@lyonix/contracts";
import { cancelQueuedVideoProduction, deleteVideoProduction, listVideoProductionEvents, listVideoProductions, retryVideoProduction } from "../video-productions-api";
import { isTerminalRun } from "../video-production-stages";
import { isWaitingInQueue } from "../queue-display";

const filters = ["all", "completed", "active", "attention"] as const;
type Filter = (typeof filters)[number];
const PAGE_SIZE = 12;
const TIMELINE_WINDOW_MIN = 30;
const TIMELINE_MAX_ROWS = 10;
const LIVE_POLL_MS = 5000;
type View = "timeline" | "gallery";
const VIEW_KEY = "lyonix.autoView";
const readView = (): View => {
  try { return window.localStorage.getItem(VIEW_KEY) === "gallery" ? "gallery" : "timeline"; } catch { return "timeline"; }
};

function statusTone(status: WorkflowRunStatus) {
  if (status === "completed") return "ok" as const;
  if (status === "failed" || status === "cancelled") return "danger" as const;
  if (status === "blocked_provider" || status === "needs_input") return "warn" as const;
  return "neutral" as const;
}

function formatDuration(ms: number | null) {
  if (!ms) return null;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

const needsAttention = (status: WorkflowRunStatus) => ["failed", "cancelled", "blocked_provider", "needs_input"].includes(status);
// "cancelled" is deliberately excluded — matches the server's own retriableStatuses in
// video-productions.service.ts: a user-stopped run isn't offered a one-click retry here.
const isRetriable = (status: WorkflowRunStatus) => ["failed", "blocked_provider", "needs_input"].includes(status);

export function VideoProductionsPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [rows, setRows] = useState<VideoProductionListItemResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [playing, setPlaying] = useState<VideoProductionListItemResponse | null>(null);
  const [view, setViewState] = useState<View>(readView);
  const [events, setEvents] = useState<Record<string, WorkflowStepEventResponse[] | undefined>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  const setView = (next: View) => {
    setViewState(next);
    try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* per-viewer convenience only */ }
  };

  const reload = useCallback(() => listVideoProductions()
    .then((next) => setRows(next))
    .catch((err) => setError(err instanceof ApiError ? err.message : t("common.error"))), [t]);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  // Live refresh: poll the existing list endpoint while any run is still in flight, so a job created
  // elsewhere (or finishing) shows up without a manual reload.
  const hasActive = rows.some((row) => !isTerminalRun(row.status) && !needsAttention(row.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => { void reload(); setNowMs(Date.now()); }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, reload]);

  const timelineRows = useMemo(() => {
    const from = nowMs - TIMELINE_WINDOW_MIN * 60_000;
    return rows
      .filter((row) => !isTerminalRun(row.status) || Date.parse(row.updatedAt) >= from)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(-TIMELINE_MAX_ROWS);
  }, [rows, nowMs]);

  // Step events (existing per-run endpoint) feed the bars. Finished runs are fetched once; running ones on every poll.
  const timelineKey = timelineRows.map((row) => `${row.id}:${row.status}:${row.updatedAt}`).join("|") + (hasActive ? `@${nowMs}` : "");
  useEffect(() => {
    if (view !== "timeline") return;
    let cancelled = false;
    for (const row of timelineRows) {
      void listVideoProductionEvents(row.id)
        .then((list) => { if (!cancelled) setEvents((current) => ({ ...current, [row.id]: list })); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, timelineKey]);

  // VE2E-62: the live polling above also keeps the queue position fresh (rows carry `queue`).

  const [cancelling, setCancelling] = useState<string | null>(null);
  // Only a run still waiting in the queue can be cancelled; the API refuses (409) once a worker claimed it, in which case the list is refreshed.
  const cancelQueued = async (row: VideoProductionListItemResponse) => {
    const title = row.title || t(`videoProductions.source.${row.sourceType || "unknown"}`);
    if (!(await confirm({ title, message: t("videoProductions.queueCancelConfirm", { title }), tone: "warn" }))) return;
    setCancelling(row.id);
    setError(null);
    try {
      await cancelQueuedVideoProduction(row.id);
      setRows((current) => current.map((item) => (item.id === row.id ? { ...item, status: "cancelled", queue: { ...item.queue, queuePosition: null } } : item)));
    } catch (err) {
      setError(err instanceof ApiError && err.code === "INVALID_STATE" ? t("videoProductions.queueCancelFailed") : err instanceof ApiError ? err.message : t("common.error"));
      void listVideoProductions().then(setRows).catch(() => undefined);
    } finally {
      setCancelling(null);
    }
  };

  const visible = useMemo(() => rows.filter((row) =>
    filter === "all" || (filter === "completed" && row.status === "completed") ||
    (filter === "attention" && needsAttention(row.status)) ||
    (filter === "active" && row.status !== "completed" && !needsAttention(row.status)),
  ), [rows, filter]);
  const counts: Record<Filter, number> = {
    all: rows.length,
    completed: rows.filter((row) => row.status === "completed").length,
    active: rows.filter((row) => row.status !== "completed" && !needsAttention(row.status)).length,
    attention: rows.filter((row) => needsAttention(row.status)).length,
  };

  const remove = async (row: VideoProductionListItemResponse) => {
    const title = row.title || t(`videoProductions.source.${row.sourceType || "unknown"}`);
    if (!(await confirm({ title, message: t("videoProductions.deleteConfirm", { title }) }))) return;
    setDeleting(row.id);
    setError(null);
    try {
      await deleteVideoProduction(row.id);
      setRows((current) => current.filter((item) => item.id !== row.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setDeleting(null);
    }
  };

  // No confirm dialog — unlike delete, retrying is non-destructive and reversible (the run just
  // goes back into the worker queue). This page doesn't poll, so optimistically reflect the new
  // "draft" status locally; the worker will move it forward on its own.
  const retry = async (row: VideoProductionListItemResponse) => {
    setRetrying(row.id);
    setError(null);
    try {
      await retryVideoProduction(row.id);
      setRows((current) => current.map((item) => (item.id === row.id ? { ...item, status: "draft", lastError: null } : item)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <>
      <PageHeader
        title={t("videoProductions.title")}
        breadcrumb={t("videoProductions.subtitle")}
        actions={<Button onClick={() => navigate("/jobs/new?entry=auto")}>{t("videoProductions.createNew")}</Button>}
      />
      {error ? <Banner variant="danger">{error}</Banner> : null}
      <QueueSummaryBar />
      <div className="lyx-list mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {filters.map((item) => (
          <button key={item} type="button" onClick={() => { setFilter(item); setShown(PAGE_SIZE); }} aria-pressed={filter === item}
            className={`lyx-card-hover rounded-xl border p-3 text-left ${filter === item ? "!border-lyx-fg bg-lyx-muted" : "border-lyx-border bg-lyx-bg hover:bg-lyx-muted"}`}>
            <span className="block text-[11px] text-lyx-fg-muted">{t(`videoProductions.filter.${item}`)}</span>
            <strong className="mt-1 block text-2xl tabular-nums">{counts[item]}</strong>
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-lyx-fg-muted">{hasActive ? t("videoProductions.timeline.live") : t("videoProductions.timeline.idle")}</p>
        <SegmentedTabs
          tone="solid"
          ariaLabel={t("videoProductions.view.label")}
          value={view}
          onChange={setView}
          options={(["timeline", "gallery"] as const).map((item) => ({ id: item, label: t(`videoProductions.view.${item}`) }))}
        />
      </div>
      {loading && view === "gallery" ? <SkeletonCards label={t("common.loading")} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6" count={6} /> : null}
      {loading && view === "timeline" ? <SkeletonRows label={t("common.loading")} count={5} rowClassName="h-9" /> : null}
      {!loading && view === "timeline" ? (
        timelineRows.length === 0
          ? <EmptyState title={t("videoProductions.timeline.empty")} />
          : <AutoRunTimeline rows={timelineRows} events={events} nowMs={nowMs} windowMinutes={TIMELINE_WINDOW_MIN} onOpen={(id) => navigate(`/video-productions/${id}`)} />
      ) : null}
      {!loading && view === "gallery" && visible.length === 0 ? <EmptyState title={t("videoProductions.empty")} /> : null}
      {!loading && view === "gallery" && visible.length > 0 ? (
        <div className="lyx-list grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6">
          {visible.slice(0, shown).map((row) => {
            const title = row.title || t(`videoProductions.source.${row.sourceType || "unknown"}`);
            const playable = row.status === "completed" && Boolean(row.resultUrl);
            return (
              <article key={row.id} className="lyx-card-hover min-w-0 overflow-hidden rounded-xl border border-lyx-border bg-lyx-bg shadow-sm">
                <div className="relative">
                  <button type="button" onClick={() => navigate(`/video-productions/${row.id}`)} aria-label={`${t("videoGallery.openDetails")}: ${title}`} className="lyx-no-press block w-full text-left">
                    <VideoThumbnail snapshotUrl={row.snapshotUrl} resultUrl={playable ? row.resultUrl : null} className="aspect-[3/2] w-full" />
                  </button>
                  <span className="absolute left-2 top-2"><StatusPill tone={statusTone(row.status)}>{t(`videoProduction.status.${row.status}`)}</StatusPill></span>
                  {playable ? <button type="button" onClick={() => setPlaying(row)} aria-label={`${t("videoGallery.play")}: ${title}`} className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/85 text-white shadow-md hover:bg-black"><Play size={18} fill="currentColor" /></button> : null}
                </div>
                <div className="space-y-1.5 p-2.5">
                  <button type="button" onClick={() => navigate(`/video-productions/${row.id}`)} className="block w-full truncate text-left text-[13px] font-semibold leading-5 hover:underline">{title}</button>
                  {row.caption ? <p className="truncate text-[11px] leading-4 text-lyx-fg-muted">{row.caption}</p> : null}
                  {row.createdByName ? <p className="text-[11px] text-lyx-fg-muted">{t("jobs.creator")}: {row.createdByName}</p> : null}
                  <QueueBadge status={row.status} queue={row.queue} />
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-lyx-border pt-2 text-[11px] text-lyx-fg-muted">
                    {formatDuration(row.renderDurationMs) ? <span className="inline-flex items-center gap-1"><Clock3 size={12} />{formatDuration(row.renderDurationMs)}</span> : null}
                    {row.costAmount ? <span className="inline-flex items-center gap-1"><Wallet size={12} />{row.costAmount} {row.costCurrency}</span> : null}
                    <span>{new Date(row.createdAt).toLocaleDateString()}</span>
                    {isWaitingInQueue(row.status, row.queue) ? (
                      <button type="button" onClick={() => void cancelQueued(row)} disabled={cancelling === row.id} title={t("videoProductions.queueCancel")} aria-label={`${t("videoProductions.queueCancel")}: ${title}`} className="ml-auto rounded p-1 hover:bg-lyx-muted hover:text-lyx-danger disabled:opacity-35"><Ban size={14} /></button>
                    ) : null}
                    {isRetriable(row.status) ? (
                      <button type="button" onClick={() => void retry(row)} disabled={retrying === row.id} title={t("videoProductions.retry")} aria-label={`${t("videoProductions.retry")}: ${title}`} className="ml-auto rounded p-1 hover:bg-lyx-muted hover:text-lyx-fg disabled:opacity-35"><RotateCw size={14} className={retrying === row.id ? "animate-spin" : undefined} /></button>
                    ) : null}
                    <button type="button" onClick={() => void remove(row)} disabled={deleting === row.id || !needsAttention(row.status) && row.status !== "completed"} title={row.status === "completed" || needsAttention(row.status) ? t("videoProductions.delete") : t("videoProductions.deleteRunning")} aria-label={`${t("videoProductions.delete")}: ${title}`} className={`rounded p-1 hover:bg-lyx-muted hover:text-lyx-danger disabled:opacity-35 ${isRetriable(row.status) || isWaitingInQueue(row.status, row.queue) ? "" : "ml-auto"}`}><Trash2 size={14} /></button>
                  </div>
                  {row.lastError?.message && needsAttention(row.status) ? <p className="line-clamp-2 text-[11px] text-lyx-warn">{row.lastError.message}</p> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
      {!loading && view === "gallery" && shown < visible.length ? <div className="mt-5 text-center"><button type="button" onClick={() => setShown((count) => count + PAGE_SIZE)} className="rounded-lg border border-lyx-border bg-lyx-bg px-5 py-2 text-sm font-medium hover:bg-lyx-muted">{t("videoProductions.showMore", { count: visible.length - shown })}</button></div> : null}
      {playing?.resultUrl ? <VideoPlayerDialog title={playing.title || t("videoProductions.title")} caption={playing.caption} url={playing.resultUrl} onClose={() => setPlaying(null)} /> : null}
    </>
  );
}
