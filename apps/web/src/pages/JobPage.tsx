import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { Button } from "../components/ui";
import { JobStepper } from "../components/JobStepper";
import { api, ApiError } from "../api";
import { isJobDone, routeForJob, type ApiJob } from "../jobs-api";

function formatDuration(ms: number | null | undefined) {
  if (!ms) return "—";
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
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

export function JobPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<ApiJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    void api<ApiJob>(`/jobs/${id}`).then(setJob).catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
  }, [id]);
  if (error) return <Banner variant="danger">{error}</Banner>;
  if (!job) return <Banner variant="info">{t("common.loading")}</Banner>;
  return (
    <>
      <PageHeader
        title={job.code}
        breadcrumb={`${job.topic} · ${job.model}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate(`/jobs/${job.id}/studio`)}>{t("jobs.openStudio")}</Button>
            {/* VE2E-18: always resumes at the job's real current step, not always the script page (CR-JOBS-PIPELINE-STATUS-2026-09-26). */}
            <Button onClick={() => navigate(routeForJob(job))}>{t("jobs.resume")}</Button>
          </>
        }
      />
      {job.lastNotice ? <Banner variant="info">{job.lastNotice}</Banner> : null}
      {job.promptSpec ? <Banner variant="info">{t("jobs.prompt")}: {job.promptSpec}</Banner> : null}
      <JobStepper current={job.status === "handoff_workspace_ready" || job.status === "completed" ? "done" : job.status === "producing" ? "produce" : job.status === "awaiting_staff_ack" ? "review" : "script"} />
      <StatusPill tone={isJobDone(job) ? "ok" : job.render?.status === "failed" ? "danger" : job.status === "awaiting_staff_ack" ? "warn" : "neutral"}>
        {pipelineLabel(job, t)}
      </StatusPill>
      {isJobDone(job) ? (
        <p className="mt-3 text-[12px] text-lyx-fg-muted">
          {t("jobs.duration")}: {formatDuration(job.render?.renderDurationMs)}
          {job.render?.costAmount ? ` · ${t("jobs.cost")}: ${job.render.costAmount}${job.render.costCurrency ? ` ${job.render.costCurrency}` : ""}` : null}
        </p>
      ) : null}
      {job.handoff ? <p className="mt-3 text-[12px]">{t("script.handoffReady")}: {job.handoff.relativePath}</p> : null}
      <p className="mt-4 text-[12px] text-lyx-fg-muted">{t("jobs.updated")}: {job.updatedAt}</p>
      <p className="mt-4"><Link className="underline" to={`/jobs/${job.id}/script`}>{t("script.title")}</Link></p>
    </>
  );
}
