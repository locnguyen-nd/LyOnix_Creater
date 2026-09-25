import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { Button, Field, Select, TextArea, TextInput } from "../components/ui";
import { JobStepper } from "../components/JobStepper";
import { api, ApiError, csrfHeaders } from "../api";
import type { ApiJob, ApiProvider } from "../jobs-api";
import type { JobStepKey } from "../studio/types";

const stepForStatus = (status: string, currentStep: string): JobStepKey => {
  if (currentStep === "intake" || currentStep === "check" || currentStep === "script" || currentStep === "review" || currentStep === "produce" || currentStep === "edit" || currentStep === "vrew" || currentStep === "done") {
    if (status === "handoff_workspace_ready" || status === "completed") return "done";
    if (status === "producing") return "produce";
    if (status === "awaiting_staff_ack") return "review";
    if (status === "scripting" || status === "accepted") return "script";
    return currentStep;
  }
  if (status === "handoff_workspace_ready" || status === "completed") return "done";
  if (status === "producing") return "produce";
  if (status === "awaiting_staff_ack") return "review";
  return "script";
};

const switchableFail = (text: string | null | undefined) =>
  Boolean(text && /RATE_LIMITED|QUOTA_EXHAUSTED|AUTH_INVALID|no credits remaining|hết credit|hết hạn mức|Đổi tài khoản/i.test(text));

export function ScriptPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [job, setJob] = useState<ApiJob | null>(null);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [nextAccountId, setNextAccountId] = useState("");
  const [direction, setDirection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { if (id) setJob(await api<ApiJob>(`/jobs/${id}`)); };
  useEffect(() => { void load().catch((err) => setError(err instanceof ApiError ? err.message : t("common.error"))); }, [id]);
  useEffect(() => {
    void api<ApiProvider[]>("/provider-accounts").then((rows) => {
      setProviders(rows);
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (job?.contentProviderAccountId) setNextAccountId((current) => current || job.contentProviderAccountId);
  }, [job?.contentProviderAccountId]);
  if (!job && error) return <Banner variant="danger">{error}</Banner>;
  if (!job) return <Banner variant="info">{t("common.loading")}</Banner>;
  const script = job.script;
  const contentAccounts = providers.filter((item) => item.role === "content" && (item.isFake || item.status === "verified"));
  const blocked = switchableFail(error) || switchableFail(job.lastNotice);
  const saveField = (patch: Partial<typeof script>) => {
    const next = { ...script, ...patch };
    setJob({ ...job, script: next });
  };
  return (
    <>
      <PageHeader
        title={t("script.title")}
        breadcrumb={`${job.code} · ${job.model} · ${job.schemaVersion ?? "script-draft.v1"}`}
        actions={
          <Button disabled={busy} onClick={() => void (async () => {
            try {
              setBusy(true);
              setError(null);
              const next = await api<ApiJob>(`/jobs/${job.id}/script/approve`, { method: "POST", headers: await csrfHeaders() });
              setJob(next);
              setNotice(next.lastNotice ?? t("script.approved", { version: next.script.approvedVersion ?? next.script.version }));
            } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
            finally { setBusy(false); }
          })()}>{t("script.approve")}</Button>
        }
      />
      <JobStepper current={stepForStatus(job.status, job.currentStep)} />
      <StatusPill tone={job.status === "awaiting_staff_ack" ? "warn" : job.status === "producing" ? "ok" : "neutral"}>{job.status}</StatusPill>
      {error || (job.lastNotice && job.lastNotice.includes("thất bại")) ? (
        <Banner variant="danger">{error ?? job.lastNotice}</Banner>
      ) : notice || job.lastNotice ? <Banner variant="info">{notice ?? job.lastNotice}</Banner> : null}
      {blocked ? <Banner variant="warn">{t("jobs.quotaBanner")}</Banner> : null}
      <Field label={t("jobs.contentAccount")} hint={t("jobs.switchHint")}>
        <div className="flex flex-wrap items-end gap-2">
          <Select className="min-w-56 flex-1" value={nextAccountId} onChange={(e) => setNextAccountId(e.target.value)}>
            {contentAccounts.map((item) => (
              <option key={item.id} value={item.id}>{item.name} · {item.provider} · {item.model}</option>
            ))}
          </Select>
          <Button variant="secondary" disabled={busy || !nextAccountId || nextAccountId === job.contentProviderAccountId} onClick={() => void (async () => {
            try {
              setBusy(true); setError(null);
              const next = await api<ApiJob>(`/jobs/${job.id}/content-account`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ contentProviderAccountId: nextAccountId }) });
              setJob(next);
              setNotice(next.lastNotice ?? t("jobs.switchAccount"));
            } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
            finally { setBusy(false); }
          })()}>{t("jobs.switchAccount")}</Button>
        </div>
      </Field>
      <Field label={t("jobs.direction")} hint={t("jobs.directionHint")}>
        <TextArea value={direction} onChange={(e) => setDirection(e.target.value)} placeholder={t("jobs.directionHint")} />
      </Field>
      <div className="mb-4 mt-3 flex gap-2">
        <Button disabled={busy} onClick={() => void (async () => {
          try {
            setBusy(true); setError(null);
            const next = await api<ApiJob>(`/jobs/${job.id}/script/generate`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ direction }) });
            setJob(next);
            setNotice(next.lastNotice ?? t("script.generated"));
          } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
          finally { setBusy(false); }
        })}>{busy ? t("common.loading") : script.body ? t("script.revise") : t("script.generate")}</Button>
        <Button variant="secondary" disabled={busy} onClick={() => void (async () => {
          try {
            setBusy(true);
            setError(null);
            const next = await api<ApiJob>(`/jobs/${job.id}/script`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ script }) });
            setJob(next);
            setNotice(next.lastNotice ?? t("common.save"));
          } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
          finally { setBusy(false); }
        })}>{t("common.save")}</Button>
      </div>
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <ul className="border border-lyx-border">
          {script.scenes.map((scene) => (
            <li key={scene.sceneId} className="border-b border-lyx-border px-3 py-2 text-[12px]">
              <p className="font-medium">{scene.sceneId}</p>
              <p className="text-lyx-fg-muted">{scene.screenText || scene.narration}</p>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-3">
          <Field label="title"><TextInput value={script.title} onChange={(e) => saveField({ title: e.target.value })} /></Field>
          <Field label="hook"><TextInput value={script.hook} onChange={(e) => saveField({ hook: e.target.value })} /></Field>
          <Field label="body"><TextArea value={script.body} onChange={(e) => saveField({ body: e.target.value })} /></Field>
          <Field label="CTA"><TextInput value={script.cta} onChange={(e) => saveField({ cta: e.target.value })} /></Field>
          <Field label="caption"><TextInput value={script.caption} onChange={(e) => saveField({ caption: e.target.value })} /></Field>
          {script.scenes.map((scene, index) => (
            <Field key={scene.sceneId} label={`${scene.sceneId} · narration`}>
              <TextArea value={scene.narration} onChange={(e) => {
                const scenes = script.scenes.map((item, i) => i === index ? { ...item, narration: e.target.value } : item);
                saveField({ scenes });
              }} />
            </Field>
          ))}
          <p className="text-[12px] text-lyx-fg-muted">
            {job.locale} · v{script.version} · approved {script.approvedVersion ?? "—"} · cfg {job.providerConfigVersion ?? 1} · {job.promptTemplateVersion ?? "script-prompt.v1"}
          </p>
          {job.captionPlan ? (
            <div>
              <p className="mb-2 text-[12px] font-medium">{t("script.scenes")}</p>
              <ul className="border border-lyx-border">
                {job.captionPlan.scenes.map((scene) => (
                  <li key={scene.sceneId} className="border-b border-lyx-border px-3 py-2 text-[12px]">
                    <p className="font-medium">{scene.sceneId} · {scene.durationHintMs}ms</p>
                    <p>{scene.spokenText}</p>
                    <p className="text-lyx-fg-muted">{scene.segments.map((seg) => seg.text).join(" / ")}</p>
                    <p className="text-lyx-fg-muted">{scene.visualIntent}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {job.handoff ? (
            <Banner variant="info">
              {t("script.handoffReady")}: {job.handoff.relativePath} · {job.handoff.status} · {job.handoff.sceneCount} {t("script.sceneUnit")}
            </Banner>
          ) : null}
          <div>
            <p className="mb-2 text-[12px] font-medium">{t("jobs.events")}</p>
            <ul className="border border-lyx-border">
              {(job.events ?? []).slice(0, 8).map((event) => (
                <li key={event.id} className="border-b border-lyx-border px-3 py-2 text-[12px]">
                  <p>{event.message}</p>
                  <p className="text-lyx-fg-muted">{event.at}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
