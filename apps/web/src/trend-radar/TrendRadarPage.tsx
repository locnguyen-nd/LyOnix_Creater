import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { ExternalLink, Link2, Play, RotateCcw } from "lucide-react";
import { TREND_BANDS, TREND_CATEGORIES, TREND_PROVIDER_IDS, TREND_STATUSES } from "@lyonix/domain/trend-radar";
import type { TrendAssigneeResponse, TrendClusterResponse, TrendOverviewResponse, TrendRunResponse } from "@lyonix/contracts";
import { ApiError } from "../api";
import { Banner, EmptyState, KpiCard, PageHeader, SkeletonCards, StatusPill } from "../components/chrome";
import { useToast } from "../components/feedback";
import { SegmentedTabs } from "../components/motion";
import { Button, Select, TextInput } from "../components/ui";
import { getTrendOverview, importTrendUrl, listTrendAssignees, listTrendClusters, listTrendRuns, runTrendRadarNow, updateTrendCluster } from "../trend-radar-api";
import { CreateVideoDialog } from "./CreateVideoDialog";
import { TimeAgo, TrendCard } from "./TrendCard";
import { TrendConfigPanel } from "./TrendConfigPanel";
import { TrendDetailDialog } from "./TrendDetailDialog";
import { TrendRunsPanel } from "./TrendRunsPanel";
import { EMPTY_FILTERS, PROVIDER_SHORT, filtersQuery, runTone, sourceTone, type TrendListFilters } from "./trend-ui";

const PAGE_SIZE = 24;
const IDLE_POLL_MS = 60_000;
const RUNNING_POLL_MS = 4_000;
const SINCE_OPTIONS = ["6", "24", "48", "168", ""] as const;
type Tab = "topics" | "config" | "history";

const isActive = (run: TrendRunResponse | null | undefined) => run?.status === "pending" || run?.status === "running";

/**
 * VE2E-158 Trend Radar dashboard: overview + source status (incl. "Chưa xác nhận quyền sử dụng" and quota), "Chạy ngay", TikTok URL import,
 * filtered topic cards with the explained score, settings and run history. `?cluster=<id>` (the notification link) opens that topic.
 */
export function TrendRadarPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("topics");
  const [overview, setOverview] = useState<TrendOverviewResponse | null>(null);
  const [clusters, setClusters] = useState<TrendClusterResponse[] | null>(null);
  const [total, setTotal] = useState(0);
  const [runs, setRuns] = useState<TrendRunResponse[] | null>(null);
  const [assignees, setAssignees] = useState<TrendAssigneeResponse[]>([]);
  const [filters, setFilters] = useState<TrendListFilters>(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createFor, setCreateFor] = useState<string | null>(null);
  const openId = params.get("cluster");
  const wasRunning = useRef(false);

  const fail = useCallback((err: unknown) => setError(err instanceof ApiError ? err.message : t("common.error")), [t]);

  const loadOverview = useCallback(() => getTrendOverview().then(setOverview).catch(fail), [fail]);
  const loadRuns = useCallback(() => listTrendRuns(20).then(setRuns).catch(fail), [fail]);
  const loadClusters = useCallback((append = false, offset = 0) =>
    listTrendClusters(filtersQuery(filters, { limit: PAGE_SIZE, offset }))
      .then((page) => {
        setTotal(page.total);
        setClusters((current) => (append && current ? [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))] : page.items));
      })
      .catch(fail), [filters, fail]);

  useEffect(() => { void loadOverview(); void loadRuns(); listTrendAssignees().then(setAssignees).catch(() => undefined); }, [loadOverview, loadRuns]);
  useEffect(() => { setClusters(null); void loadClusters(); }, [loadClusters]);

  // Live status: fast polling while a run is in flight, slow otherwise; the list and history refresh once the run ends.
  const running = isActive(overview?.lastRun);
  useEffect(() => {
    if (wasRunning.current && !running) { void loadClusters(); void loadRuns(); }
    wasRunning.current = running;
    const timer = setInterval(() => { void loadOverview(); if (running) void loadRuns(); }, running ? RUNNING_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [running, loadOverview, loadRuns, loadClusters]);

  const runNow = async () => {
    setStarting(true);
    setError(null);
    try {
      const result = await runTrendRadarNow();
      const key = result.reason === "started" ? "runStarted" : result.reason === "already_running" ? "runAlready" : result.reason === "just_ran" ? "runJustRan" : "runNoSource";
      (result.started ? toast.success : toast.info)(t(`trendRadar.${key}`));
      await Promise.all([loadOverview(), loadRuns()]);
    } catch (err) {
      fail(err);
    } finally {
      setStarting(false);
    }
  };

  const importOne = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!importUrl.trim()) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importTrendUrl(importUrl.trim());
      (result.created ? toast.success : toast.info)(result.warning ?? t(result.created ? "trendRadar.importCreated" : "trendRadar.importExisting"));
      setImportUrl("");
      replaceCluster(result.cluster, true);
      setParams((prev) => { const next = new URLSearchParams(prev); next.set("cluster", result.cluster.id); return next; });
      void loadOverview();
    } catch (err) {
      fail(err);
    } finally {
      setImporting(false);
    }
  };

  const replaceCluster = (next: TrendClusterResponse, prepend = false) =>
    setClusters((current) => {
      if (!current) return current;
      if (current.some((item) => item.id === next.id)) return current.map((item) => (item.id === next.id ? next : item));
      return prepend ? [next, ...current] : current;
    });

  const patchCluster = async (id: string, patch: { status?: string; saved?: boolean }) => {
    setBusyId(id);
    try {
      replaceCluster(await updateTrendCluster(id, patch));
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  };

  const setFilter = (patch: Partial<TrendListFilters>) => setFilters((prev) => ({ ...prev, ...patch }));
  const closeDetail = () => setParams((prev) => { const next = new URLSearchParams(prev); next.delete("cluster"); return next; });
  const openDetail = (id: string) => setParams((prev) => { const next = new URLSearchParams(prev); next.set("cluster", id); return next; });

  const lastRun = overview?.lastRun ?? null;
  return (
    <>
      <PageHeader
        title={t("trendRadar.title")}
        breadcrumb={t("trendRadar.subtitle")}
        actions={<Button loading={starting || running} onClick={() => void runNow()} data-testid="trend-run-now"><Play size={14} aria-hidden />{running ? t("trendRadar.running") : t("trendRadar.runNow")}</Button>}
      />
      {error ? <Banner variant="danger">{error}</Banner> : null}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("trendRadar.kpi.newToday")} value={overview?.newToday ?? "–"} />
        <KpiCard label={t("trendRadar.kpi.hot")} value={overview?.hot ?? "–"} active={filters.band === "hot"} onClick={() => { setTab("topics"); setFilter({ band: filters.band === "hot" ? "" : "hot" }); }} />
        <KpiCard label={t("trendRadar.kpi.rising")} value={overview?.rising ?? "–"} active={filters.band === "rising"} onClick={() => { setTab("topics"); setFilter({ band: filters.band === "rising" ? "" : "rising" }); }} />
        <KpiCard label={t("trendRadar.kpi.activeSources")} value={overview ? `${overview.activeSources}/${overview.sources.length}` : "–"} />
        <KpiCard label={t("trendRadar.kpi.lastRun")} value={<span className="text-[14px]">{lastRun ? <TimeAgo iso={lastRun.finishedAt ?? lastRun.startedAt ?? lastRun.createdAt} /> : t("trendRadar.kpi.never")}</span>} tag={lastRun ? <StatusPill tone={runTone(lastRun.status)}>{t(`trendRadar.history.status.${lastRun.status}`)}</StatusPill> : null} />
        <KpiCard label={t("trendRadar.kpi.nextRun")} value={<span className="text-[14px]">{!overview ? "–" : !overview.scheduleEnabled ? t("trendRadar.kpi.scheduleOff") : overview.nextRunAt ? new Date(overview.nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–"}</span>} />
      </div>

      {overview ? (
        <section className="mb-4 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-3.5" data-testid="trend-sources">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-lyx-fg-subtle">{t("trendRadar.sources.title")}</h2>
          <ul className="flex flex-col gap-1.5 text-[12.5px]">
            {overview.sources.map((source) => (
              <li key={source.provider} className="flex flex-wrap items-center gap-2">
                <span className="w-32 font-medium">{source.label}</span>
                <StatusPill tone={sourceTone(source.state)}>{t(`trendRadar.sources.state.${source.state}`)}</StatusPill>
                {source.message ? <span className="text-lyx-fg-muted">{source.message}</span> : null}
                {source.termsUrl ? <a href={source.termsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">{t("trendRadar.sources.terms")}<ExternalLink size={12} aria-hidden /></a> : null}
                {source.lastRunAt ? <span className="text-lyx-fg-subtle"><TimeAgo iso={source.lastRunAt} /></span> : null}
              </li>
            ))}
          </ul>
          {overview.problems.length ? (
            <div className="mt-3">
              <Banner variant="warn">
                <strong>{t("trendRadar.problems")}</strong>
                <ul className="mt-1">{overview.problems.map((problem, index) => <li key={`${problem.provider}-${index}`}>{PROVIDER_SHORT[problem.provider]} - {problem.code}: {problem.message}</li>)}</ul>
              </Banner>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="mb-4">
        <SegmentedTabs tone="solid" value={tab} onChange={(next) => { setTab(next); if (next === "history") void loadRuns(); }} options={(["topics", "config", "history"] as const).map((id) => ({ id, label: t(`trendRadar.tabs.${id}`) }))} />
      </div>

      {tab === "config" ? <TrendConfigPanel onSaved={() => void loadOverview()} /> : null}
      {tab === "history" ? <TrendRunsPanel runs={runs} /> : null}
      {tab === "topics" ? (
        <>
          <form onSubmit={(event) => void importOne(event)} className="mb-3 flex flex-wrap items-center gap-2" aria-label={t("trendRadar.importTitle")}>
            <Link2 size={15} className="text-lyx-fg-muted" aria-hidden />
            <TextInput className="min-w-0 flex-1 sm:max-w-md" inputMode="url" placeholder={t("trendRadar.importPlaceholder")} aria-label={t("trendRadar.importTitle")} value={importUrl} onChange={(event) => setImportUrl(event.target.value)} />
            <Button type="submit" variant="secondary" loading={importing} disabled={!importUrl.trim()}>{t("trendRadar.importButton")}</Button>
          </form>

          <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="trend-filters">
            <form className="min-w-0 flex-1 basis-56" onSubmit={(event) => { event.preventDefault(); setFilter({ q: search }); }}>
              <TextInput className="w-full" placeholder={t("trendRadar.filters.search")} aria-label={t("trendRadar.filters.search")} value={search} onChange={(event) => setSearch(event.target.value)} onBlur={() => { if (search !== filters.q) setFilter({ q: search }); }} />
            </form>
            <Select aria-label={t("trendRadar.filters.provider")} value={filters.provider} onChange={(event) => setFilter({ provider: event.target.value })}>
              <option value="">{t("trendRadar.filters.provider")}: {t("trendRadar.filters.any")}</option>
              {TREND_PROVIDER_IDS.map((provider) => <option key={provider} value={provider}>{PROVIDER_SHORT[provider]}</option>)}
            </Select>
            <Select aria-label={t("trendRadar.filters.since")} value={filters.sinceHours} onChange={(event) => setFilter({ sinceHours: event.target.value })}>
              {SINCE_OPTIONS.map((hours) => <option key={hours} value={hours}>{t("trendRadar.filters.since")}: {hours === "" ? t("trendRadar.filters.any") : Number(hours) >= 48 ? t("trendRadar.filters.days", { count: Number(hours) / 24 }) : t("trendRadar.filters.hours", { count: Number(hours) })}</option>)}
            </Select>
            <Select aria-label={t("trendRadar.filters.category")} value={filters.category} onChange={(event) => setFilter({ category: event.target.value })}>
              <option value="">{t("trendRadar.filters.category")}: {t("trendRadar.filters.any")}</option>
              {TREND_CATEGORIES.map((category) => <option key={category} value={category}>{t(`trendRadar.category.${category}`)}</option>)}
            </Select>
            <Select aria-label={t("trendRadar.filters.band")} value={filters.band} onChange={(event) => setFilter({ band: event.target.value })}>
              <option value="">{t("trendRadar.filters.band")}: {t("trendRadar.filters.any")}</option>
              {TREND_BANDS.map((band) => <option key={band} value={band}>{t(`trendRadar.band.${band}`)}</option>)}
            </Select>
            <Select aria-label={t("trendRadar.filters.status")} value={filters.status} onChange={(event) => setFilter({ status: event.target.value })}>
              <option value="">{t("trendRadar.filters.status")}: {t("trendRadar.filters.any")}</option>
              {TREND_STATUSES.map((status) => <option key={status} value={status}>{t(`trendRadar.status.${status}`)}</option>)}
            </Select>
            <Select aria-label={t("trendRadar.filters.assignee")} value={filters.assigneeId} onChange={(event) => setFilter({ assigneeId: event.target.value })}>
              <option value="">{t("trendRadar.filters.assignee")}: {t("trendRadar.filters.any")}</option>
              {assignees.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
            </Select>
            <TextInput type="number" min={0} max={100} className="w-28" placeholder={t("trendRadar.filters.minScore")} aria-label={t("trendRadar.filters.minScore")} value={filters.minScore} onChange={(event) => setFilter({ minScore: event.target.value })} />
            <label className="inline-flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={filters.saved} onChange={(event) => setFilter({ saved: event.target.checked })} />{t("trendRadar.filters.saved")}</label>
            <Button variant="ghost" onClick={() => { setFilters(EMPTY_FILTERS); setSearch(""); }}><RotateCcw size={14} aria-hidden />{t("trendRadar.filters.reset")}</Button>
          </div>

          {clusters === null ? <SkeletonCards label={t("common.loading")} media={false} className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3" count={4} /> : clusters.length === 0 ? <EmptyState title={t("trendRadar.empty")} /> : (
            <>
              <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3" data-testid="trend-list">
                {clusters.map((cluster) => (
                  <TrendCard
                    key={cluster.id}
                    cluster={cluster}
                    busy={busyId === cluster.id}
                    onStatus={(status) => void patchCluster(cluster.id, { status })}
                    onSave={(saved) => void patchCluster(cluster.id, { saved })}
                    onCreateVideo={() => setCreateFor(cluster.id)}
                    onOpen={() => openDetail(cluster.id)}
                  />
                ))}
              </div>
              {clusters.length < total ? (
                <div className="mt-4 flex justify-center"><Button variant="secondary" onClick={() => void loadClusters(true, clusters.length)}>{t("trendRadar.loadMore")} ({clusters.length}/{total})</Button></div>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {openId ? <TrendDetailDialog key={openId} clusterId={openId} onClose={closeDetail} onChanged={(next) => replaceCluster(next)} onCreateVideo={(cluster) => { closeDetail(); setCreateFor(cluster.id); }} /> : null}
      {createFor ? <CreateVideoDialog clusterId={createFor} onClose={() => setCreateFor(null)} onAssigned={(next) => replaceCluster(next)} /> : null}
    </>
  );
}
