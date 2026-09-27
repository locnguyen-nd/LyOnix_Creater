import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Banner, ChannelAvatar, EmptyState, KpiCard, LegendDot, MiniSpark, PageHeader, StatusPill, TrendChart } from "../components/chrome";
import { DataTable } from "../components/DataTable";
import { Modal } from "../components/Modal";
import { Button, Field, PasswordInput, Select, TextInput } from "../components/ui";
import { API_ORIGIN, api, ApiError, csrfHeaders } from "../api";
import { PERIODS, METRIC_COLORS, channelHandleLabel, formatCount, formatDelta, type ChannelInsights, type PeriodKey, type PublicChannel } from "../channel-api";
import { useMe } from "../session";
import type { ChannelVideoResponse } from "@lyonix/contracts";

function formatVideoDuration(ms: number | null) {
  if (!ms) return "—";
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

const LIST_PERIOD: PeriodKey = "7d";

export function ChannelsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<PublicChannel[]>([]);
  const [insightsByChannel, setInsightsByChannel] = useState<Record<string, ChannelInsights>>({});
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<"token" | "api_key">("token");
  const [secret, setSecret] = useState("");
  const oauthError = params.get("error") === "oauth_unconfigured" ? t("channels.oauthUnconfigured") : params.get("error") ? t("channels.oauthError") : null;
  const [error, setError] = useState<string | null>(oauthError);
  const [notice, setNotice] = useState<string | null>(params.get("connected") ? t("channels.connectedOk") : null);
  const [setup, setSetup] = useState<{ configured: boolean; redirectUri: string | null } | null>(null);
  const [filter, setFilter] = useState<"all" | "connected" | "disconnected">("all");
  const refresh = async () => {
    const list = await api<PublicChannel[]>("/channels");
    setRows(list);
    const connected = list.filter((row) => row.connected);
    const entries = await Promise.all(
      connected.map(async (row) => {
        try {
          return [row.id, await api<ChannelInsights>(`/channels/${row.id}/insights?period=${LIST_PERIOD}`)] as const;
        } catch {
          return null;
        }
      }),
    );
    setInsightsByChannel(Object.fromEntries(entries.filter((item): item is readonly [string, ChannelInsights] => item !== null)));
  };
  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
    if (me.role === "admin") void api<{ configured: boolean; redirectUri: string | null }>("/channel-oauth/tiktok/setup").then(setSetup).catch(() => undefined);
    if (params.has("connected") || params.has("error")) setParams({}, { replace: true });
  }, []);

  const filteredRows = useMemo(
    () => rows.filter((row) => filter === "all" || (filter === "connected") === row.connected),
    [rows, filter],
  );
  const totals = useMemo(() => {
    const values = Object.values(insightsByChannel);
    const pick = (id: string) => values.reduce((acc, item) => acc + (item.metrics.find((m) => m.id === id)?.current ?? 0), 0);
    return { followers: pick("followers"), views: pick("views") };
  }, [insightsByChannel]);

  return (
    <>
      <PageHeader
        title={t("channels.title")}
        breadcrumb={t("channels.subtitle")}
        actions={me.role === "admin" ? <Button onClick={() => setOpen(true)}>{t("channels.connect")}</Button> : null}
      />
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {notice ? <Banner variant="info">{notice}</Banner> : null}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t("channels.total")} value={rows.length} />
        <KpiCard label={t("channels.connected")} value={rows.filter((r) => r.connected).length} />
        <KpiCard label={t("home.metric.followers")} value={formatCount(totals.followers) ?? "0"} />
        <KpiCard label={t("home.metric.views")} value={formatCount(totals.views) ?? "0"} />
      </div>

      <div className="mb-3 flex gap-2">
        <Button variant={filter === "all" ? "primary" : "secondary"} onClick={() => setFilter("all")}>{t("jobs.all")}</Button>
        <Button variant={filter === "connected" ? "primary" : "secondary"} onClick={() => setFilter("connected")}>{t("channels.connected")}</Button>
        <Button variant={filter === "disconnected" ? "primary" : "secondary"} onClick={() => setFilter("disconnected")}>{t("channels.disconnected")}</Button>
      </div>

      <DataTable
        rows={filteredRows}
        rowKey={(row) => row.id}
        onRowClick={(row) => navigate(`/channels/${row.id}`)}
        empty={<EmptyState title={t("common.empty")} />}
        columns={[
          { key: "avatar", header: "", render: (row) => <ChannelAvatar name={row.name} src={row.avatarUrl} /> },
          { key: "name", header: t("channels.name"), render: (row) => {
            const handle = channelHandleLabel(row.handle);
            return (
              <div>
                <div className="font-medium">{row.name}</div>
                {handle ? <div className="text-[11px] text-lyx-fg-muted">{handle}</div> : null}
              </div>
            );
          } },
          { key: "conn", header: t("channels.connected"), render: (row) => <StatusPill tone={row.connected ? "ok" : "danger"}>{row.connected ? t("channels.connected") : t("channels.disconnected")}</StatusPill> },
          {
            key: "followers",
            header: t("home.metric.followers"),
            render: (row) => {
              const m = insightsByChannel[row.id]?.metrics.find((item) => item.id === "followers");
              if (!m || m.current === null) return "—";
              return (
                <div>
                  <div className="font-semibold">{formatCount(m.current)}</div>
                  {m.delta !== null ? <div className={`text-[11px] ${m.delta >= 0 ? "text-lyx-ok" : "text-lyx-danger"}`}>{formatDelta(m.delta, m.pct)}</div> : null}
                </div>
              );
            },
          },
          {
            key: "views",
            header: t("home.metric.views"),
            render: (row) => {
              const m = insightsByChannel[row.id]?.metrics.find((item) => item.id === "views");
              return m?.current !== null && m?.current !== undefined ? formatCount(m.current) : "—";
            },
          },
          {
            key: "spark",
            header: t("home.chart"),
            render: (row) => {
              const m = insightsByChannel[row.id]?.metrics.find((item) => item.id === "followers");
              return <MiniSpark values={(m?.series ?? []).map((p) => p.v)} tone={(m?.delta ?? 0) >= 0 ? "ok" : "danger"} />;
            },
          },
          { key: "auth", header: t("channels.auth"), render: (row) => <StatusPill tone="neutral">{row.authType}</StatusPill> },
          { key: "sync", header: t("channels.lastSync"), render: (row) => row.lastSyncAt ?? "—" },
        ]}
      />
      {open ? (
        <Modal title={t("channels.connect")} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-lyx-fg-muted">{t("channels.oauthHint")}</p>
            {setup?.redirectUri ? <p className="break-all rounded-[4px] border border-lyx-border bg-lyx-muted p-2 font-mono text-[12px]">{setup.redirectUri}</p> : null}
            <p className="text-[12px] text-lyx-fg-muted">{t("channels.oauthRedirectLabel")}</p>
            <Button onClick={() => { window.location.assign(`${API_ORIGIN}/api/v1/channel-oauth/tiktok/start`); }}>{t("channels.connectOAuth")}</Button>
            <Field label={t("channels.name")}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label={t("channels.auth")}>
              <Select value={authType} onChange={(e) => setAuthType(e.target.value as "token" | "api_key")}>
                <option value="token">Token</option>
                <option value="api_key">Key</option>
              </Select>
            </Field>
            <Field label={t("providers.secret")} hint={t("channels.tokenHint")}>
              <PasswordInput value={secret} onChange={(e) => setSecret(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button onClick={() => void (async () => {
                try {
                  setError(null);
                  await api("/channel-connections", { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ name, authType, secret }) });
                  await refresh(); setSecret(""); setOpen(false); setNotice(t("channels.connectedOk"));
                } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
              })()}>{t("common.save")}</Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

export function ChannelDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const [metric, setMetric] = useState<"followers" | "likes" | "views" | "comments" | "shares" | "video_count">("followers");
  const [insights, setInsights] = useState<ChannelInsights | null>(null);
  const [videos, setVideos] = useState<ChannelVideoResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sync" | "disable" | null>(null);
  const load = async () => {
    if (!id) return;
    setInsights(await api<ChannelInsights>(`/channels/${id}/insights?period=${period}`));
  };
  useEffect(() => { void load().catch((err) => setError(err instanceof ApiError ? err.message : t("common.error"))); }, [id, period]);
  // VE2E-19: per-channel finished-video library — independent of the insights period filter above.
  useEffect(() => {
    if (!id) return;
    void api<ChannelVideoResponse[]>(`/channels/${id}/videos`).then(setVideos).catch(() => undefined);
  }, [id]);
  if (!insights && error) return <Banner variant="danger">{error}</Banner>;
  if (!insights) return <Banner variant="info">{t("common.loading")}</Banner>;
  const channel = insights.channel;
  const handleLabel = channelHandleLabel(channel.handle);
  const chartSeries = ["followers", "likes", "views", "comments", "shares", "video_count"]
    .map((id) => {
      const item = insights.metrics.find((row) => row.id === id);
      if (!item?.series.length) return null;
      return {
        id,
        label: t(`home.metric.${id}`),
        color: METRIC_COLORS[id] ?? "var(--lyx-fg)",
        points: item.series,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  return (
    <>
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {notice ? <Banner variant="info">{notice}</Banner> : null}
      <PageHeader
        title={channel.name}
        {...(handleLabel ? { breadcrumb: handleLabel } : {})}
        actions={
          <>
            <Select value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} aria-label={t("home.period")}>
              {PERIODS.map((item) => (
                <option key={item} value={item}>{t(`home.${item === "1d" ? "d1" : item === "7d" ? "d7" : item === "30d" ? "d30" : "d90"}`)}</option>
              ))}
            </Select>
            <Button
              disabled={busy !== null || !channel.connected}
              onClick={() => void (async () => {
                try {
                  setBusy("sync");
                  setError(null);
                  await api(`/channels/${channel.id}/sync`, { method: "POST", headers: await csrfHeaders() });
                  await load();
                  setNotice(t("channels.syncOk"));
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : t("common.error"));
                } finally {
                  setBusy(null);
                }
              })()}
            >
              {busy === "sync" ? t("common.loading") : t("channels.sync")}
            </Button>
            {me.role === "admin" ? (
              <>
                <Button variant="secondary" onClick={() => { window.location.assign(`${API_ORIGIN}/api/v1/channel-oauth/tiktok/start`); }}>{t("channels.reconnect")}</Button>
                <Button
                  variant="danger"
                  disabled={busy !== null || !channel.connected}
                  onClick={() => void (async () => {
                    try {
                      setBusy("disable");
                      setError(null);
                      await api(`/channels/${channel.id}/disable`, { method: "POST", headers: await csrfHeaders() });
                      await load();
                      setNotice(t("channels.disableOk"));
                    } catch (err) {
                      setError(err instanceof ApiError ? err.message : t("common.error"));
                    } finally {
                      setBusy(null);
                    }
                  })()}
                >
                  {busy === "disable" ? t("common.loading") : t("channels.disable")}
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <div className="mb-4 flex items-center gap-3">
        <ChannelAvatar name={channel.name} src={channel.avatarUrl} size={56} />
        <div>
          <StatusPill tone={channel.connected ? "ok" : "danger"}>{channel.connected ? t("channels.connected") : t("channels.disconnected")}</StatusPill>
          {handleLabel ? <p className="mt-1 text-[12px] text-lyx-fg-muted">{handleLabel}</p> : null}
        </div>
      </div>
      {insights.granted.length ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="text-[12px] text-lyx-fg-muted">{t("home.granted")}</span>
          {insights.granted.map((item) => (
            <StatusPill key={item.scope} tone="ok">{item.scope}</StatusPill>
          ))}
        </div>
      ) : null}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        {["followers", "likes", "views", "comments", "shares", "video_count"].map((id) => {
          const item = insights.metrics.find((row) => row.id === id);
          const delta = formatDelta(item?.delta ?? null, item?.pct ?? null);
          const unavailable = !item || item.availability !== "available" || item.current === null;
          return (
            <KpiCard
              key={id}
              label={t(`home.metric.${id}`)}
              active={metric === id}
              onClick={() => setMetric(id as typeof metric)}
              value={unavailable ? t("home.unavailable") : formatCount(item.current)}
              delta={unavailable ? undefined : item.missingBaseline ? t("home.missingBaseline") : delta}
              positive={unavailable || item?.missingBaseline ? undefined : (item.delta ?? 0) >= 0}
              spark={item?.series.map((p) => p.v)}
            />
          );
        })}
      </div>
      <div className="mb-4 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[13px] font-bold">{t("home.chart")}</span>
          {chartSeries.map((line) => (
            <LegendDot key={line.id} color={line.color}>{line.label}</LegendDot>
          ))}
        </div>
        <TrendChart series={chartSeries} emphasisId={metric} label={t("home.chart")} />
      </div>
      <Banner variant="info">{channel.authType === "oauth2" ? t("channels.metricsHint") : t("channels.secretHint")}</Banner>

      <div className="mt-4">
        <p className="mb-3 text-[13px] font-bold">{t("channels.videoLibraryTitle")}</p>
        {videos.length === 0 ? (
          <EmptyState title={t("channels.videoLibraryEmpty")} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {videos.map((video) => (
              // VE2E-13: resultUrl plays only inside Studio, never as direct autoplay/open
              // from a list like this one — route into the same job's Studio, deep-linked to
              // this render (StudioProPage already reads `?renderJobId=` on mount, VE2E-18).
              <button
                key={video.renderJobId}
                type="button"
                onClick={() => navigate(`/jobs/${video.jobId}/studio?renderJobId=${video.renderJobId}`)}
                className="overflow-hidden rounded-[6px] border border-lyx-border text-left"
              >
                <div className="relative flex items-center justify-center bg-lyx-muted" style={{ aspectRatio: "9 / 16" }}>
                  {video.thumbnailUrl ? (
                    <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[10px] text-lyx-fg-subtle">9:16</span>
                  )}
                  <span className="absolute bottom-1.5 right-1.5 rounded-[4px] bg-lyx-bg/80 px-1.5 py-0.5 text-[10px] font-medium">
                    {formatVideoDuration(video.renderDurationMs)}
                  </span>
                </div>
                <div className="p-2">
                  <div className="line-clamp-2 text-[12px]">{video.caption}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
