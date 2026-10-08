import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Play, Trash2 } from "lucide-react";
import { Banner, ChannelAvatar, EmptyState, PageHeader, StatusPill } from "../components/chrome";
import { VideoPlayerDialog, VideoThumbnail } from "../components/VideoMedia";
import { SegmentedTabs } from "../components/motion";
import { Button, Select, TextInput } from "../components/ui";
import { api, ApiError, csrfHeaders } from "../api";
import type { PublicChannel } from "../channel-api";
import { isJobDone, routeForJob, type ApiJob } from "../jobs-api";

const tabs = ["all", "running", "review", "blocked", "done", "error"] as const;
const RUNNING_STATUSES = new Set(["accepted", "validating", "transcribing", "scripting", "producing", "editing", "rendering_vrew", "verifying"]);
const BLOCKED_STATUSES = new Set(["blocked_provider", "needs_attention", "failed"]);
const PAGE_SIZE = 12;
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

function JobVideoCard({ job, channel, open, play, remove }: {
  job: ApiJob;
  channel?: PublicChannel | undefined;
  open: () => void;
  play: () => void;
  remove?: () => void;
}) {
  const { t } = useTranslation();
  const playable = isJobDone(job) && Boolean(job.render?.resultUrl);
  return (
    <article className="lyx-card-hover group min-w-0 overflow-hidden rounded-xl border border-lyx-border bg-lyx-bg shadow-sm">
      <div className="relative">
        <button type="button" onClick={open} aria-label={`${t("videoGallery.openDetails")}: ${job.topic}`} className="lyx-no-press block w-full text-left">
          <VideoThumbnail snapshotUrl={job.render?.snapshotUrl} resultUrl={playable ? job.render?.resultUrl : null} className="aspect-[3/2] w-full" />
        </button>
        <span className="absolute left-2 top-2"><StatusPill tone={tone(job)}>{pipelineLabel(job, t)}</StatusPill></span>
        {playable ? <button type="button" onClick={play} aria-label={`${t("videoGallery.play")}: ${job.topic}`} className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/85 text-white shadow-md hover:bg-black"><Play size={18} fill="currentColor" /></button> : null}
      </div>
      <div className="space-y-1.5 p-2.5">
        <button type="button" onClick={open} className="block w-full truncate text-left text-[13px] font-semibold leading-5 hover:underline">{job.topic}</button>
        {job.script.caption ? <p className="truncate text-[11px] leading-4 text-lyx-fg-muted">{job.script.caption}</p> : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-lyx-fg-muted">
          {channel ? <span>{channel.name}</span> : null}
          {job.createdByName ? <span>· {t("jobs.creator")}: {job.createdByName}</span> : null}
        </div>
        <div className="flex items-center justify-between border-t border-lyx-border pt-2 text-[11px] text-lyx-fg-muted">
          <span>{isJobDone(job) ? `${formatDuration(job.render?.renderDurationMs)} · ${formatCost(job)}` : new Date(job.updatedAt).toLocaleDateString()}</span>
          {remove ? <button type="button" onClick={remove} title={t("jobs.delete")} aria-label={`${t("jobs.delete")}: ${job.topic}`} className="rounded p-1 hover:bg-lyx-muted hover:text-lyx-danger"><Trash2 size={14} /></button> : null}
        </div>
      </div>
    </article>
  );
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
  const [playing, setPlaying] = useState<ApiJob | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [shownByChannel, setShownByChannel] = useState<Record<string, number>>({});

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
    () => channels.map((channel) => ({ channel, jobs: rows.filter((job) => job.channelId === channel.id) })),
    [channels, rows],
  );

  const removeJob = (job: ApiJob) => {
    void (async () => {
      try {
        setError(null);
        await api(`/jobs/${job.id}`, { method: "DELETE", headers: await csrfHeaders() });
        setJobs((current) => current.filter((item) => item.id !== job.id));
        setNotice(t("jobs.delete"));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t("common.error"));
      }
    })();
  };

  return (
    <>
      <PageHeader
        title={t("jobs.title")}
        actions={
          <>
            <SegmentedTabs
              tone="solid"
              value={view}
              onChange={setView}
              options={[
                { id: "list", label: t("jobsByChannel.viewList") },
                { id: "byChannel", label: t("jobsByChannel.viewByChannel") },
              ]}
            />
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
          <SegmentedTabs
            tone="solid"
            className="mb-4"
            value={tab}
            onChange={setTab}
            options={tabs.map((item) => ({ id: item, label: t(item === "all" ? "jobs.all" : `jobs.${item}`) }))}
          />
          {rows.length === 0 ? <EmptyState title={t("common.empty")} /> : (
            <div className="lyx-list grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6">
              {rows.slice(0, shown).map((job) => <JobVideoCard key={job.id} job={job} channel={channels.find((item) => item.id === job.channelId)} open={() => navigate(routeForJob(job))} play={() => setPlaying(job)} remove={() => removeJob(job)} />)}
            </div>
          )}
          {shown < rows.length ? <div className="mt-5 text-center"><Button variant="secondary" onClick={() => setShown((count) => count + PAGE_SIZE)}>{t("videoProductions.showMore", { count: rows.length - shown })}</Button></div> : null}
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
              <div className="lyx-list grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6">
                {channelJobs.length === 0 ? (
                  <p className="text-[12px] text-lyx-fg-muted">{t("jobsByChannel.emptyChannel")}</p>
                ) : null}
                {channelJobs.slice(0, shownByChannel[channel.id] ?? PAGE_SIZE).map((job) => <JobVideoCard key={job.id} job={job} open={() => navigate(routeForJob(job))} play={() => setPlaying(job)} />)}
                <button
                  type="button"
                  onClick={() => navigate(`/jobs/new?channelId=${channel.id}`)}
                  className="flex min-h-36 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-lyx-strong text-[12px] text-lyx-fg-muted hover:bg-lyx-muted"
                >
                  <span className="text-[18px]">+</span>
                  {t("jobsByChannel.createNew")}
                </button>
              </div>
              {(shownByChannel[channel.id] ?? PAGE_SIZE) < channelJobs.length ? <div className="mt-3 text-center"><Button variant="secondary" onClick={() => setShownByChannel((current) => ({ ...current, [channel.id]: (current[channel.id] ?? PAGE_SIZE) + PAGE_SIZE }))}>{t("videoProductions.showMore", { count: channelJobs.length - (shownByChannel[channel.id] ?? PAGE_SIZE) })}</Button></div> : null}
            </div>
          ))}
        </div>
      )}
      {playing?.render?.resultUrl ? <VideoPlayerDialog title={playing.topic} caption={playing.script.caption} url={playing.render.resultUrl} onClose={() => setPlaying(null)} /> : null}
    </>
  );
}
