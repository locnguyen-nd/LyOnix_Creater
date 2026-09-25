import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { Banner, EmptyState, KpiCard, LegendDot, PageHeader, StatusPill, TrendChart } from "../components/chrome";
import { DataTable } from "../components/DataTable";
import { Button, Select } from "../components/ui";
import { api, ApiError, csrfHeaders } from "../api";
import { PERIODS, formatCount, formatDelta, type ChannelInsights, type PeriodKey, type PublicChannel } from "../channel-api";
import type { ApiJob } from "../jobs-api";
import type { ApiProvider } from "../jobs-api";
import { useMe } from "../session";

const KPI_IDS = ["followers", "likes", "views", "comments", "shares", "video_count"] as const;
const RUNNING_STATUSES = new Set(["accepted", "validating", "transcribing", "scripting", "producing", "editing", "rendering_vrew", "verifying"]);
const BLOCKED_STATUSES = new Set(["blocked_provider", "needs_attention", "failed"]);
const DONE_STATUSES = new Set(["completed", "handoff_workspace_ready"]);
const REVIEW_STATUSES = new Set(["awaiting_staff_ack"]);

function sum(values: Array<number | null>): { total: number; withData: number } {
  let total = 0;
  let withData = 0;
  for (const v of values) {
    if (v !== null) { total += v; withData += 1; }
  }
  return { total, withData };
}

export function HomePage() {
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const [channels, setChannels] = useState<PublicChannel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const [metric, setMetric] = useState<(typeof KPI_IDS)[number]>("followers");
  const [insights, setInsights] = useState<ChannelInsights | null>(null);
  const [allInsights, setAllInsights] = useState<Record<string, ChannelInsights>>({});
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const selected = channels.find((item) => item.id === channelId) ?? channels[0];

  const loadChannels = async () => {
    const rows = await api<PublicChannel[]>("/channels");
    setChannels(rows);
    setChannelId((current) => (rows.some((row) => row.id === current) ? current : rows[0]?.id ?? ""));
    setLoaded(true);
  };

  const loadInsights = async (id: string, nextPeriod: PeriodKey) => {
    setInsights(await api<ChannelInsights>(`/channels/${id}/insights?period=${nextPeriod}`));
  };

  const loadAll = async (rows: PublicChannel[], nextPeriod: PeriodKey) => {
    const connected = rows.filter((row) => row.connected);
    const entries = await Promise.all(
      connected.map(async (row) => {
        try {
          return [row.id, await api<ChannelInsights>(`/channels/${row.id}/insights?period=${nextPeriod}`)] as const;
        } catch {
          return null;
        }
      }),
    );
    setAllInsights(Object.fromEntries(entries.filter((item): item is readonly [string, ChannelInsights] => item !== null)));
  };

  useEffect(() => {
    void loadChannels().catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
    void api<ApiJob[]>("/jobs").then(setJobs).catch(() => undefined);
    if (me.role === "admin") void api<ApiProvider[]>("/provider-accounts").then(setProviders).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selected?.id) return;
    void loadInsights(selected.id, period).catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
  }, [selected?.id, period]);

  useEffect(() => {
    if (!loaded) return;
    void loadAll(channels, period);
  }, [loaded, channels, period]);

  const kpis = useMemo(
    () => KPI_IDS.map((id) => insights?.metrics.find((item) => item.id === id)).filter(Boolean),
    [insights],
  );
  const chart = insights?.metrics.find((item) => item.id === metric);
  const revenue = insights?.metrics.find((item) => item.id === "revenue_from_views");

  const allInsightsList = Object.values(allInsights);
  const aggregates = useMemo(() => {
    const map: Partial<Record<(typeof KPI_IDS)[number], { total: number; withData: number }>> = {};
    for (const id of KPI_IDS) {
      map[id] = sum(allInsightsList.map((item) => item.metrics.find((m) => m.id === id)?.current ?? null));
    }
    return map;
  }, [allInsightsList]);

  const leaderboard = useMemo(() => {
    return channels
      .map((channel) => {
        const ins = allInsights[channel.id];
        const followers = ins?.metrics.find((m) => m.id === "followers");
        const views = ins?.metrics.find((m) => m.id === "views");
        const likes = ins?.metrics.find((m) => m.id === "likes");
        const comments = ins?.metrics.find((m) => m.id === "comments");
        const shares = ins?.metrics.find((m) => m.id === "shares");
        const engagementCount = (likes?.current ?? 0) + (comments?.current ?? 0) + (shares?.current ?? 0);
        const engagementRate = views?.current ? (engagementCount / views.current) * 100 : null;
        return { channel, followers, views, engagementRate, spark: (views?.series ?? followers?.series ?? []).map((p) => p.v) };
      })
      .sort((a, b) => (b.followers?.current ?? -1) - (a.followers?.current ?? -1));
  }, [channels, allInsights]);

  const jobBuckets = useMemo(() => ({
    intake: jobs.filter((j) => !RUNNING_STATUSES.has(j.status) && !BLOCKED_STATUSES.has(j.status) && !DONE_STATUSES.has(j.status) && !REVIEW_STATUSES.has(j.status)).length,
    producing: jobs.filter((j) => RUNNING_STATUSES.has(j.status)).length,
    review: jobs.filter((j) => REVIEW_STATUSES.has(j.status)).length,
    done: jobs.filter((j) => DONE_STATUSES.has(j.status)).length,
    blocked: jobs.filter((j) => BLOCKED_STATUSES.has(j.status)).length,
  }), [jobs]);
  const maxBucket = Math.max(1, jobBuckets.intake, jobBuckets.producing, jobBuckets.review, jobBuckets.done);
  const attention = useMemo(
    () => jobs.filter((j) => BLOCKED_STATUSES.has(j.status) || REVIEW_STATUSES.has(j.status)).slice(0, 6),
    [jobs],
  );

  const providerSummary = useMemo(() => {
    const verified = providers.filter((p) => p.status === "verified").length;
    return { verified, total: providers.length, failed: providers.filter((p) => p.status === "failed").length };
  }, [providers]);

  if (!loaded && !error) return <Banner variant="info">{t("common.loading")}</Banner>;
  if (channels.length === 0) {
    return (
      <>
        <PageHeader title={t("home.title")} />
        <EmptyState
          title={me.role === "admin" ? t("home.connect") : t("home.emptyStaff")}
          action={me.role === "admin" ? <Button onClick={() => navigate("/channels")}>{t("home.connect")}</Button> : undefined}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("home.title")}
        breadcrumb={t("home.subtitle", { count: channels.length, connected: channels.filter((c) => c.connected).length })}
        actions={
          selected ? (
            <Button
              disabled={busy || !selected.connected}
              onClick={() => void (async () => {
                try {
                  setBusy(true);
                  setError(null);
                  await api(`/channels/${selected.id}/sync`, { method: "POST", headers: await csrfHeaders() });
                  await loadChannels();
                  await loadInsights(selected.id, period);
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : t("common.error"));
                } finally {
                  setBusy(false);
                }
              })()}
            >
              {busy ? t("common.loading") : t("home.sync")}
            </Button>
          ) : null
        }
      />
      {error ? <Banner variant="danger">{error}</Banner> : null}

      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} aria-label={t("home.period")}>
          {PERIODS.map((item) => (
            <option key={item} value={item}>{t(`home.${item === "1d" ? "d1" : item === "7d" ? "d7" : item === "30d" ? "d30" : "d90"}`)}</option>
          ))}
        </Select>
      </div>

      <h2 className="mb-2 text-[13px] font-semibold text-lyx-fg-muted">{t("home.systemTotal")}</h2>
      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {KPI_IDS.map((id) => {
          const agg = aggregates[id];
          if (!agg) return null;
          return (
            <KpiCard
              key={id}
              label={t(`home.metric.${id}`)}
              value={agg.withData ? formatCount(agg.total) : t("home.unavailable")}
              delta={agg.withData ? t("home.dataFrom", { count: agg.withData, total: channels.filter((c) => c.connected).length }) : undefined}
            />
          );
        })}
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        <Select value={selected?.id ?? ""} onChange={(e) => setChannelId(e.target.value)} aria-label={t("home.channel")}>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>{channel.name}</option>
          ))}
        </Select>
        <Select value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}>
          {KPI_IDS.map((id) => (
            <option key={id} value={id}>{t(`home.metric.${id}`)}</option>
          ))}
        </Select>
      </div>
      {insights?.granted.length ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="text-[12px] text-lyx-fg-muted">{t("home.granted")}</span>
          {insights.granted.map((item) => (
            <StatusPill key={item.scope} tone="ok">{item.scope}</StatusPill>
          ))}
        </div>
      ) : null}
      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-3">
        {kpis.map((item) => {
          if (!item) return null;
          const delta = formatDelta(item.delta, item.pct);
          const unavailable = item.availability !== "available" || item.current === null;
          return (
            <KpiCard
              key={item.id}
              label={t(`home.metric.${item.id}`)}
              active={metric === item.id}
              onClick={() => setMetric(item.id as typeof metric)}
              value={unavailable ? t("home.unavailable") : formatCount(item.current)}
              delta={unavailable ? (item.reasonCode ?? undefined) : item.missingBaseline ? t("home.missingBaseline") : `${delta} · ${t("home.vsPeriod")}`}
              positive={unavailable || item.missingBaseline ? undefined : (item.delta ?? 0) >= 0}
              spark={item.series.map((p) => p.v)}
            />
          );
        })}
        <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-3" data-availability={revenue?.availability}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-lyx-fg-subtle">{t("home.revenue")}</p>
          <p className="mt-2 text-[20px] font-bold" data-testid="unavailable">{t("home.unavailable")}</p>
          <p className="mt-2 text-[12px] text-lyx-fg-muted">{revenue?.reasonCode ?? "TIKTOK_SCOPE_NOT_GRANTED"}</p>
        </div>
      </div>
      <div className="mb-6 rounded-[6px] border border-lyx-border bg-lyx-bg p-4 text-lyx-fg">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[13px] font-bold">{t("home.chart")}</span>
            <LegendDot color="var(--lyx-fg)">{selected?.name} · {t(`home.metric.${metric}`)}</LegendDot>
          </div>
        </div>
        <TrendChart points={chart?.series ?? []} label={t("home.chart")} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] font-semibold">{t("home.pipeline")}</span>
            <StatusPill tone="neutral">{jobs.length}</StatusPill>
          </div>
          <div className="flex flex-col gap-3">
            {([
              ["intake", jobBuckets.intake, "bg-lyx-fg"],
              ["producing", jobBuckets.producing, "bg-lyx-fg"],
              ["review", jobBuckets.review, "bg-lyx-warn"],
              ["done", jobBuckets.done, "bg-lyx-ok"],
            ] as const).map(([key, value, barClass]) => (
              <div key={key}>
                <div className="mb-1 flex justify-between text-[12px]"><span>{t(`home.bucket.${key}`)}</span><span className="font-semibold">{value}</span></div>
                <div className="h-2 rounded-[4px] bg-lyx-muted"><div className={`h-2 rounded-[4px] ${barClass}`} style={{ width: `${(value / maxBucket) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
        {me.role === "admin" ? (
          <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-semibold">{t("home.providerHealth")}</span>
              <StatusPill tone={providerSummary.failed > 0 ? "warn" : "ok"}>{t("home.providerReady", { verified: providerSummary.verified, total: providerSummary.total })}</StatusPill>
            </div>
            {providers.length === 0 ? (
              <EmptyState title={t("common.empty")} />
            ) : (
              <div className="flex flex-col gap-2">
                {providers.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-[12.5px]">
                    <span>{p.name} <span className="text-lyx-fg-muted">· {p.provider}</span></span>
                    <StatusPill tone={p.status === "verified" ? "ok" : p.status === "failed" ? "danger" : "neutral"}>{t(`providers.${p.status}`)}</StatusPill>
                  </div>
                ))}
              </div>
            )}
            <Link className="mt-3 inline-block text-[12px] font-semibold underline" to="/settings">{t("home.manageProviders")}</Link>
          </div>
        ) : null}
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-semibold">{t("home.leaderboard")}</span>
            <Link className="text-[12px] font-semibold text-lyx-fg-muted" to="/channels">{t("home.viewAll")} →</Link>
          </div>
          <DataTable
            rows={leaderboard}
            rowKey={(row) => row.channel.id}
            onRowClick={(row) => navigate(`/channels/${row.channel.id}`)}
            empty={<EmptyState title={t("common.empty")} />}
            columns={[
              { key: "name", header: t("channels.name"), render: (row) => row.channel.name },
              { key: "followers", header: t("home.metric.followers"), render: (row) => row.followers?.current !== null && row.followers?.current !== undefined ? formatCount(row.followers.current) : "—" },
              { key: "views", header: t("home.metric.views"), render: (row) => row.views?.current !== null && row.views?.current !== undefined ? formatCount(row.views.current) : "—" },
              { key: "engagement", header: t("home.engagementRate"), render: (row) => row.engagementRate !== null ? `${row.engagementRate.toFixed(1)}%` : "—" },
            ]}
          />
        </div>
        <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] font-semibold">{t("home.attention")}</span>
            <StatusPill tone={attention.length > 0 ? "warn" : "ok"}>{attention.length}</StatusPill>
          </div>
          {attention.length === 0 ? (
            <EmptyState title={t("common.empty")} />
          ) : (
            <div className="flex flex-col gap-2">
              {attention.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  className="flex items-start justify-between gap-2 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-2.5 text-left hover:border-lyx-fg"
                  onClick={() => navigate(`/jobs/${job.id}/script`)}
                >
                  <div>
                    <p className="text-[12.5px] font-semibold">{job.code} · {job.topic}</p>
                    <p className="text-[11px] text-lyx-fg-muted">{job.status}</p>
                  </div>
                  <StatusPill tone={BLOCKED_STATUSES.has(job.status) ? "danger" : "warn"}>{job.status}</StatusPill>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 text-[12px] text-lyx-fg-muted">
        <Link className="underline" to="/jobs">{t("nav.jobs")}</Link>
      </p>
      <Banner variant="info">{t("jobs.quotaBanner")}</Banner>
    </>
  );
}
