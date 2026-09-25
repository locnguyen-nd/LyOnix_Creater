import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { Button } from "../components/ui";
import { JobStepper } from "../components/JobStepper";
import { api, ApiError } from "../api";
import type { ApiJob } from "../jobs-api";

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
            <Button onClick={() => navigate(`/jobs/${job.id}/script`)}>{t("jobs.openScript")}</Button>
          </>
        }
      />
      {job.lastNotice ? <Banner variant="info">{job.lastNotice}</Banner> : null}
      {job.promptSpec ? <Banner variant="info">{t("jobs.prompt")}: {job.promptSpec}</Banner> : null}
      <JobStepper current={job.status === "handoff_workspace_ready" || job.status === "completed" ? "done" : job.status === "producing" ? "produce" : job.status === "awaiting_staff_ack" ? "review" : "script"} />
      <StatusPill tone={job.status === "awaiting_staff_ack" ? "warn" : job.status === "handoff_workspace_ready" || job.status === "producing" ? "ok" : "neutral"}>{job.status}</StatusPill>
      {job.handoff ? <p className="mt-3 text-[12px]">{t("script.handoffReady")}: {job.handoff.relativePath}</p> : null}
      <p className="mt-4 text-[12px] text-lyx-fg-muted">{t("jobs.updated")}: {job.updatedAt}</p>
      <p className="mt-4"><Link className="underline" to={`/jobs/${job.id}/script`}>{t("script.title")}</Link></p>
    </>
  );
}
