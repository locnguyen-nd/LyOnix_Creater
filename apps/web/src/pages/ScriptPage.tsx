import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../components/feedback";
import { useNavigate, useParams } from "react-router-dom";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { Button, Field, Select, TextArea, TextInput } from "../components/ui";
import { JobStepper } from "../components/JobStepper";
import { api, ApiError, csrfHeaders } from "../api";
import type { ApiJob, ApiProvider } from "../jobs-api";
import type { JobStepKey } from "../studio/types";
import { isInAppNavigation, isScriptDirty } from "../script/unsaved";

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

type Tab = "content" | "scenes" | "activity";

export function ScriptPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [job, setJob] = useState<ApiJob | null>(null);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [nextAccountId, setNextAccountId] = useState("");
  const [direction, setDirection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("content");
  // VE2E-124: the last script the server has (existing versioning), to tell unsaved on-screen edits apart.
  const [savedScript, setSavedScript] = useState<ApiJob["script"] | null>(null);
  const applyServerJob = (next: ApiJob) => {
    setJob(next);
    setSavedScript(next.script);
  };
  const load = async () => { if (id) applyServerJob(await api<ApiJob>(`/jobs/${id}`)); };
  const dirty = Boolean(job && savedScript && isScriptDirty(job.script, savedScript));
  // Unsaved edits: warn before a reload/close and before an in-app link takes the user away (no second draft system).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !isInAppNavigation(event, anchor, window.location)) return;
      // The in-app dialog is asynchronous: hold the navigation, then follow the link only when the user confirms.
      event.preventDefault();
      event.stopPropagation();
      void confirm({ title: t("script.unsavedLeaveConfirm"), message: t("script.unsavedLeaveConfirm"), tone: "warn" }).then((ok) => {
        if (ok) navigate(`${anchor.pathname}${anchor.search}${anchor.hash}`);
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, t, confirm, navigate]);
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
  /** Existing versioning: POST /jobs/:id/script creates a new ScriptVersion from what is on screen. */
  const saveScriptNow = async () => applyServerJob(await api<ApiJob>(`/jobs/${job.id}/script`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ script }) }));
  const scrollToScene = (sceneId: string) => {
    setTab("content");
    requestAnimationFrame(() => document.getElementById(`scene-${sceneId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  const eventCount = job.events?.length ?? 0;
  const tabs: Array<{ key: Tab; label: string; count?: number | undefined }> = [
    { key: "content", label: t("script.tabContent") },
    { key: "scenes", label: t("script.tabScenes"), count: job.captionPlan?.scenes.length },
    { key: "activity", label: t("script.tabActivity"), count: eventCount || undefined },
  ];

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
              // VE2E-124: approve what is on screen - unsaved edits become a new version first (never approve the stale one).
              if (dirty) await saveScriptNow();
              const next = await api<ApiJob>(`/jobs/${job.id}/script/approve`, { method: "POST", headers: await csrfHeaders() });
              applyServerJob(next);
              setNotice(next.lastNotice ?? t("script.approved", { version: next.script.approvedVersion ?? next.script.version }));
              if (next.status === "handoff_workspace_ready") navigate(`/jobs/${next.id}/studio`);
            } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
            finally { setBusy(false); }
          })()}>{t("script.approve")}</Button>
        }
      />
      <JobStepper current={stepForStatus(job.status, job.currentStep)} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusPill tone={job.status === "awaiting_staff_ack" ? "warn" : job.status === "producing" ? "ok" : "neutral"}>{job.status}</StatusPill>
        <span className="text-[11px] text-lyx-fg-muted">
          {job.locale} · v{script.version} · {t("script.approvedLabel")} {script.approvedVersion ?? "—"} · cfg {job.providerConfigVersion ?? 1}
        </span>
      </div>
      {error || (job.lastNotice && job.lastNotice.includes("thất bại")) ? (
        <Banner variant="danger">{error ?? job.lastNotice}</Banner>
      ) : notice || job.lastNotice ? <Banner variant="info">{notice ?? job.lastNotice}</Banner> : null}
      {blocked ? <Banner variant="warn">{t("jobs.quotaBanner")}</Banner> : null}
      {job.handoff ? (
        <div className="mb-4 flex items-center gap-3 rounded-[var(--lyx-radius)] border border-lyx-ok/30 bg-lyx-ok-bg px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-lyx-ok text-[13px] font-bold text-white">✓</span>
          <div className="flex-1 text-[12.5px] text-lyx-fg">
            <p className="font-semibold">{t("script.handoffReady")}</p>
            <p className="text-lyx-fg-muted">{job.handoff.relativePath} · {job.handoff.status} · {job.handoff.sceneCount} {t("script.sceneUnit")}</p>
          </div>
          <Button onClick={() => navigate(`/jobs/${job.id}/studio`)}>{t("jobs.openStudio")}</Button>
        </div>
      ) : null}

      <div className="mb-4 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4">
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("jobs.contentAccount")} hint={t("jobs.switchHint")}>
            <Select className="min-w-56" value={nextAccountId} onChange={(e) => setNextAccountId(e.target.value)}>
              {contentAccounts.map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.provider} · {item.model}</option>
              ))}
            </Select>
          </Field>
          <Button variant="secondary" disabled={busy || !nextAccountId || nextAccountId === job.contentProviderAccountId} onClick={() => void (async () => {
            try {
              setBusy(true); setError(null);
              const next = await api<ApiJob>(`/jobs/${job.id}/content-account`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ contentProviderAccountId: nextAccountId }) });
              // Switching the account does not touch the script: keep the on-screen (possibly unsaved) edits.
              setJob({ ...next, script });
              setSavedScript(next.script);
              setNotice(next.lastNotice ?? t("jobs.switchAccount"));
            } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
            finally { setBusy(false); }
          })()}>{t("jobs.switchAccount")}</Button>
        </div>
        <div className="mt-3 border-t border-lyx-border pt-3">
          <Field label={t("jobs.direction")} hint={t("jobs.directionHint")}>
            <TextArea value={direction} onChange={(e) => setDirection(e.target.value)} placeholder={t("jobs.directionHint")} />
          </Field>
          <div className="mt-3 flex gap-2">
            {/* VE2E-124: these two handlers were never invoked before (`void (async () => {...})` without the call) - fixed. */}
            <Button disabled={busy} onClick={() => void (async () => {
              try {
                setBusy(true); setError(null);
                // Revise from what is on screen: unsaved edits become a new version first.
                if (dirty) await saveScriptNow();
                const next = await api<ApiJob>(`/jobs/${job.id}/script/generate`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ direction }) });
                applyServerJob(next);
                setNotice(next.lastNotice ?? t("script.generated"));
              } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
              finally { setBusy(false); }
            })()}>{busy ? t("common.loading") : script.body ? t("script.revise") : t("script.generate")}</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void (async () => {
              try {
                setBusy(true);
                setError(null);
                await saveScriptNow();
                setNotice(t("common.save"));
              } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
              finally { setBusy(false); }
            })()}>{t("common.save")}</Button>
            {dirty ? <span role="status" className="self-center text-[11.5px] text-amber-500">{t("script.unsavedChanges")}</span> : null}
          </div>
        </div>
      </div>

      <div className="mb-4 flex gap-5 border-b border-lyx-border">
        {tabs.map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2.5 text-[13px] font-medium ${tab === key ? "border-lyx-fg text-lyx-fg" : "border-transparent text-lyx-fg-muted hover:text-lyx-fg"}`}
          >
            {label}
            {count ? <span className="rounded-full bg-lyx-neutral-bg px-1.5 text-[10.5px] font-semibold text-lyx-fg-muted">{count}</span> : null}
          </button>
        ))}
      </div>

      {tab === "content" ? (
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          <div className="rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg">
            <p className="border-b border-lyx-border px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("script.sceneNav")}</p>
            <ul>
              {script.scenes.map((scene) => (
                <li key={scene.sceneId} className="border-b border-lyx-border px-3 py-2 text-[12px] last:border-b-0">
                  <button type="button" className="text-left" onClick={() => scrollToScene(scene.sceneId)}>
                    <p className="font-medium">{scene.sceneId}</p>
                    <p className="line-clamp-2 text-lyx-fg-muted">{scene.screenText || scene.narration}</p>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-3 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4">
            <Field label={t("script.fieldTitle")}><TextInput value={script.title} onChange={(e) => saveField({ title: e.target.value })} /></Field>
            <Field label={t("script.fieldHook")}><TextInput value={script.hook} onChange={(e) => saveField({ hook: e.target.value })} /></Field>
            <Field label={t("script.fieldBody")}><TextArea value={script.body} onChange={(e) => saveField({ body: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("script.fieldCta")}><TextInput value={script.cta} onChange={(e) => saveField({ cta: e.target.value })} /></Field>
              <Field label={t("script.fieldCaption")}><TextInput value={script.caption} onChange={(e) => saveField({ caption: e.target.value })} /></Field>
            </div>
            <div className="mt-2 border-t border-lyx-border pt-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("script.narrationPerScene")}</p>
              <div className="flex flex-col gap-3">
                {script.scenes.map((scene, index) => (
                  <div key={scene.sceneId} id={`scene-${scene.sceneId}`} className="scroll-mt-4">
                    <Field label={`${scene.sceneId} · ${t("script.narration")}`}>
                      <TextArea value={scene.narration} onChange={(e) => {
                        const scenes = script.scenes.map((item, i) => i === index ? { ...item, narration: e.target.value } : item);
                        saveField({ scenes });
                      }} />
                    </Field>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "scenes" ? (
        <div className="overflow-hidden rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg">
          {job.captionPlan && job.captionPlan.scenes.length > 0 ? (
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-lyx-border bg-lyx-muted text-left text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">
                  <th className="px-3 py-2">{t("script.colScene")}</th>
                  <th className="px-3 py-2">{t("script.colDuration")}</th>
                  <th className="px-3 py-2">{t("script.colSpokenText")}</th>
                  <th className="px-3 py-2">{t("script.colVisualIntent")}</th>
                </tr>
              </thead>
              <tbody>
                {job.captionPlan.scenes.map((scene, index) => (
                  <tr key={scene.sceneId} className={`border-b border-lyx-border last:border-b-0 ${index % 2 === 1 ? "bg-lyx-muted/40" : ""}`}>
                    <td className="px-3 py-2 font-medium">{scene.sceneId}</td>
                    <td className="px-3 py-2 text-lyx-fg-muted">{scene.durationHintMs}ms</td>
                    <td className="px-3 py-2">{scene.spokenText}</td>
                    <td className="px-3 py-2 text-lyx-fg-muted">{scene.visualIntent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="p-4 text-[12.5px] text-lyx-fg-muted">{t("script.noCaptionPlan")}</p>
          )}
        </div>
      ) : null}

      {tab === "activity" ? (
        <div className="rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4">
          {(job.events ?? []).length === 0 ? (
            <p className="text-[12.5px] text-lyx-fg-muted">{t("common.empty")}</p>
          ) : (
            <ul className="flex flex-col">
              {(job.events ?? []).map((event, index) => (
                <li key={event.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-lyx-fg-subtle" />
                    {index < (job.events?.length ?? 0) - 1 ? <span className="w-px flex-1 bg-lyx-border" /> : null}
                  </div>
                  <div className="pb-4 text-[12.5px]">
                    <p>{event.message}</p>
                    <p className="text-[11px] text-lyx-fg-muted">{event.at}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </>
  );
}
