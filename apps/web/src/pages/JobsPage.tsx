import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Banner, ChannelAvatar, EmptyState, PageHeader, StatusPill } from "../components/chrome";
import { DataTable } from "../components/DataTable";
import { Button, Select, TextInput } from "../components/ui";
import { api, ApiError, csrfHeaders } from "../api";
import type { PublicChannel } from "../channel-api";
import { isJobDone, routeForJob, type ApiJob } from "../jobs-api";

const tabs = ["all", "running", "review", "blocked", "done", "error"] as const;
const RUNNING_STATUSES = new Set(["accepted", "validating", "transcribing", "scripting", "producing", "editing", "rendering_vrew", "verifying"]);
const BLOCKED_STATUSES = new Set(["blocked_provider", "needs_attention", "failed"]);
// VE2E-18: "in progress" now spans Studio's own steps too (CR-JOBS-PIPELINE-STATUS-2026-09-26) -
// a bridged job sitting in media/voice/timeline/render is still running, not merely "scripting".
const RUNNING_PIPELINE_STEPS = new Set(["media", "voice", "timeline", "render"]);

/** VE2E-18: "done" is a real rendered video (`pipelineStep === "done"`), never just an approved script. */
function tone(job: ApiJob) {
  if (isJobDone(job)) return "ok" as const;
  if (job.status === "failed" || job.status === "cancelled") return "danger" as const;
  if (job.render?.status === "failed") return "danger" as const;
  if (job.status === "awaiting_staff_ack") return "warn" as const;
  return "neutral" as const;
}

function pipelineLabel(job: ApiJob, t: (key: string) => string) {
  switch (job.pipelineStep) {
    case "media": return t("jobs.pipelineStepMedia");
    case "voice": return t("jobs.pipelineStepVoice");
    case "timeline": return t("jobs.pipelineStepTimeline");
    case "render": return t("jobs.pipelineStepRender");
    case "done": return t("jobs.pipelineStepDone");
    case "script": return t("jobs.steps.script");
    case "produce": return t("jobs.steps.produce");
    case "review": return t("jobs.steps.review");
    default: return job.status;
  }
}

function formatDuration(ms: number | null | undefined) {
  if (!ms) return "—";
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatCost(job: ApiJob) {
  if (!job.render?.costAmount) return "—";
  return job.render.costCurrency ? `${job.render.costAmount} ${job.render.costCurrency}` : job.render.costAmount;
}

export function JobsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [tab, setTab] = useState<(typeof tabs)[number]>("all");
  const [channelId, setChannelId] = useState("all");
  const [view, setView] = useState<"list" | "byChannel">("list");
  const [channels, setChannels] = useState<PublicChannel[]>([]);
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = () => {
    void Promise.all([api<ApiJob[]>("/jobs"), api<PublicChannel[]>("/channels")])
      .then(([nextJobs, nextChannels]) => { setJobs(nextJobs); setChannels(nextChannels); })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
  };
  useEffect(() => { reload(); }, []);
  const rows = useMemo(() => jobs.filter((job) => {
    if (channelId !== "all" && job.channelId !== channelId) return false;
    if (q && !`${job.code} ${job.topic}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (tab === "review") return job.status === "awaiting_staff_ack";
    if (tab === "running") {
      if (job.pipelineStep) return RUNNING_PIPELINE_STEPS.has(job.pipelineStep);
      return job.status === "scripting" || job.status === "accepted" || job.status === "producing";
    }
    if (tab === "done") return isJobDone(job);
    if (tab === "error") return job.status === "failed" || job.render?.status === "failed" || Boolean(job.lastNotice?.includes("thất bại"));
    return true;
  }), [jobs, q, tab, channelId]);

  const byChannel = useMemo(
    () => channels.map((channel) => ({ channel, jobs: jobs.filter((job) => job.channelId === channel.id) })),
    [channels, jobs],
  );

  return (
    <>
      <PageHeader
        title={t("jobs.title")}
        actions={
          <>
            <div className="flex overflow-hidden rounded-[4px] border border-lyx-strong">
              <button
                type="button"
                className={`px-3 text-[12px] h-10 ${view === "list" ? "bg-lyx-fg text-lyx-bg" : "text-lyx-fg-muted"}`}
                onClick={() => setView("list")}
              >
                {t("jobsByChannel.viewList")}
              </button>
              <button
                type="button"
                className={`px-3 text-[12px] h-10 ${view === "byChannel" ? "bg-lyx-fg text-lyx-bg" : "text-lyx-fg-muted"}`}
                onClick={() => setView("byChannel")}
              >
                {t("jobsByChannel.viewByChannel")}
              </button>
            </div>
            <Button onClick={() => navigate("/jobs/new")}>{t("jobs.create")}</Button>
          </>
        }
      />
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {notice ? <Banner variant="info">{notice}</Banner> : null}

      {view === "list" ? (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <TextInput placeholder={t("topbar.search")} value={q} onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}); }} />
            <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              <option value="all">{t("jobs.all")}</option>
              {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
            </Select>
            <Button variant="secondary" onClick={() => { setQ(""); setTab("all"); setChannelId("all"); setParams({}); }}>{t("common.reset")}</Button>
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            {tabs.map((item) => (
              <Button key={item} variant={tab === item ? "primary" : "secondary" } onClick={() => setTab(item)}>{t(item === "all" ? "jobs.all" : `jobs.${item}`)}</Button>
            ))}
          </div>
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            onRowClick={(row) => navigate(routeForJob(row))}
            empty={<EmptyState title={t("common.empty")} />}
            columns={[
              { key: "code", header: t("jobs.code"), render: (row) => row.code },
              { key: "topic", header: t("jobs.topic"), render: (row) => row.topic },
              { key: "channel", header: t("jobs.channel"), render: (row) => channels.find((item) => item.id === row.channelId)?.name ?? row.channelId },
              { key: "status", header: t("jobs.status"), render: (row) => <StatusPill tone={tone(row)}>{pipelineLabel(row, t)}</StatusPill> },
              { key: "duration", header: t("jobs.duration"), render: (row) => (isJobDone(row) ? formatDuration(row.render?.renderDurationMs) : "—") },
              { key: "cost", header: t("jobs.cost"), render: (row) => (isJobDone(row) ? formatCost(row) : "—") },
              { key: "model", header: t("providers.model"), render: (row) => row.model },
              {
                key: "delete",
                header: t("jobs.delete"),
                render: (row) => (
                  <Button variant="secondary" onClick={(event) => {
                    event.stopPropagation();
                    void (async () => {
                      try {
                        setError(null);
                        await api(`/jobs/${row.id}`, { method: "DELETE", headers: await csrfHeaders() });
                        setJobs((current) => current.filter((job) => job.id !== row.id));
                        setNotice(t("jobs.delete"));
                      } catch (err) {
                        setError(err instanceof ApiError ? err.message : t("common.error"));
                      }
                    })();
                  }}>{t("jobs.delete")}</Button>
                ),
              },
            ]}
          />
        </>
      ) : (
        <div className="flex flex-col gap-6">
          <p className="text-[12px] text-lyx-fg-muted">{t("jobsByChannel.subtitle")}</p>
          {byChannel.length === 0 ? <EmptyState title={t("jobsByChannel.noChannels")} /> : null}
          {byChannel.map(({ channel, jobs: channelJobs }) => (
            <div key={channel.id}>
              <div className="mb-2 flex items-center gap-3">
                <ChannelAvatar name={channel.name} src={channel.avatarUrl} size={28} />
                <span className="text-[14px] font-medium">{channel.name}</span>
                <StatusPill tone="neutral">{t("jobsByChannel.jobsCount", { count: channelJobs.length })}</StatusPill>
                <div className="flex-1" />
                <StatusPill tone="ok">{t("jobsByChannel.statusDone")}: {channelJobs.filter((job) => isJobDone(job)).length}</StatusPill>
                <StatusPill tone="warn">{t("jobsByChannel.statusRunning")}: {channelJobs.filter((job) => (job.pipelineStep ? RUNNING_PIPELINE_STEPS.has(job.pipelineStep) : RUNNING_STATUSES.has(job.status))).length}</StatusPill>
                <StatusPill tone="danger">{t("jobsByChannel.statusBlocked")}: {channelJobs.filter((job) => BLOCKED_STATUSES.has(job.status) || job.render?.status === "failed").length}</StatusPill>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-1">
                {channelJobs.length === 0 ? (
                  <p className="text-[12px] text-lyx-fg-muted">{t("jobsByChannel.emptyChannel")}</p>
                ) : null}
                {channelJobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => navigate(routeForJob(job))}
                    className="w-[150px] flex-shrink-0 overflow-hidden rounded-[6px] border border-lyx-border text-left"
                  >
                    <div className="relative flex items-center justify-center bg-lyx-muted" style={{ aspectRatio: "9 / 16" }}>
                      <span className="text-[10px] text-lyx-fg-subtle">9:16</span>
                      <span className="absolute left-1.5 top-1.5">
                        <StatusPill tone={tone(job)}>{pipelineLabel(job, t)}</StatusPill>
                      </span>
                    </div>
                    <div className="p-2">
                      <div className="truncate text-[12px] font-medium">{job.topic}</div>
                      <div className="mt-0.5 truncate text-[11px] text-lyx-fg-muted">{job.code}</div>
                    </div>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => navigate(`/jobs/new?channelId=${channel.id}`)}
                  className="flex w-[150px] flex-shrink-0 flex-col items-center justify-center gap-1 rounded-[6px] border border-dashed border-lyx-strong text-[12px] text-lyx-fg-muted"
                  style={{ height: "calc(150px * 16 / 9 + 34px)" }}
                >
                  <span className="text-[18px]">+</span>
                  {t("jobsByChannel.createNew")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
