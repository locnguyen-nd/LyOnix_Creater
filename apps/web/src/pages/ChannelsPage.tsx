import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Play } from "lucide-react";
import { Banner, ChannelAvatar, EmptyState, KpiCard, MiniSpark, PageHeader, StatusPill } from "../components/chrome";
import { ChannelGrowthChart } from "../components/ChannelGrowthChart";
import { VideoPlayerDialog, VideoThumbnail } from "../components/VideoMedia";
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
  const [playing, setPlaying] = useState<ChannelVideoResponse | null>(null);
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
      <div className="mb-4">
        <ChannelGrowthChart metric={insights.metrics.find((row) => row.id === metric)} label={t(`home.metric.${metric}`)} color={METRIC_COLORS[metric] ?? "#2563eb"} />
      </div>
      <Banner variant="info">{channel.authType === "oauth2" ? t("channels.metricsHint") : t("channels.secretHint")}</Banner>

      <div className="mt-4">
        <p className="mb-3 text-[13px] font-bold">{t("channels.videoLibraryTitle")}</p>
        {videos.length === 0 ? (
          <EmptyState title={t("channels.videoLibraryEmpty")} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {videos.map((video) => (
              <article key={video.renderJobId} className="overflow-hidden rounded-xl border border-lyx-border bg-lyx-bg shadow-sm">
                <div className="relative">
                  <VideoThumbnail snapshotUrl={video.thumbnailUrl} resultUrl={video.resultUrl} className="aspect-[3/2] w-full" />
                  <button type="button" onClick={() => setPlaying(video)} aria-label={`${t("videoGallery.play")}: ${video.title}`} className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/85 text-white"><Play size={18} fill="currentColor" /></button>
                </div>
                <div className="space-y-1.5 p-2.5">
                  <p className="truncate text-[13px] font-semibold">{video.title}</p>
                  {video.caption !== video.title ? <p className="truncate text-[11px] text-lyx-fg-muted">{video.caption}</p> : null}
                  {video.createdByName ? <p className="text-[11px] text-lyx-fg-muted">{t("jobs.creator")}: {video.createdByName}</p> : null}
                  <div className="flex items-center justify-between gap-2 text-[11px] text-lyx-fg-muted"><span>{formatVideoDuration(video.renderDurationMs)}</span><button type="button" onClick={() => navigate(`/jobs/${video.jobId}/studio?renderJobId=${video.renderJobId}`)} className="underline">{t("videoProduction.openStudio")}</button></div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      {playing ? <VideoPlayerDialog title={playing.title} caption={playing.caption} url={playing.resultUrl} onClose={() => setPlaying(null)} /> : null}
    </>
  );
}
