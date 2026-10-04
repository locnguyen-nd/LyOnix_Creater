import type { RenderEngineAdminOverviewResponse, RenderEngineAdminTemplateResponse, UpdateRenderEngineTemplateRequest } from "@lyonix/contracts";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError, csrfHeaders } from "../api";
import { budgetUsage, formatSeconds, formatShare, formatUsd, isDraftDirty, qcFailureList, qcFailureRate, ROLLOUT_STEPS, rolloutDraftProblem, type RolloutDraft } from "../studio/render-engine-admin";
import { routeReasonKey } from "../studio/render-engine";
import { Banner, StatusPill } from "./chrome";
import { Button, Select } from "./ui";

const WINDOWS = [1, 7, 30] as const;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-3">
      <div className="text-[11.5px] text-lyx-fg-muted">{label}</div>
      <div className="text-[18px] font-semibold">{value}</div>
      {sub ? <div className="text-[11.5px] text-lyx-fg-muted">{sub}</div> : null}
    </div>
  );
}

function TemplateRow({ template, onSaved }: { template: RenderEngineAdminTemplateResponse; onSaved: (saved: RenderEngineAdminTemplateResponse) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RolloutDraft>({ rolloutPercent: template.rolloutPercent, fallbackSnapshotIds: template.fallbackSnapshotIds });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const problem = rolloutDraftProblem(draft);
  const dirty = isDraftDirty(template, draft);
  const steps = ROLLOUT_STEPS.includes(draft.rolloutPercent as (typeof ROLLOUT_STEPS)[number]) ? ROLLOUT_STEPS : [...ROLLOUT_STEPS, draft.rolloutPercent].sort((a, b) => a - b);

  const toggleFallback = (id: string) =>
    setDraft((current) => ({ ...current, fallbackSnapshotIds: current.fallbackSnapshotIds.includes(id) ? current.fallbackSnapshotIds.filter((x) => x !== id) : [...current.fallbackSnapshotIds, id] }));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const body: UpdateRenderEngineTemplateRequest = { rolloutPercent: draft.rolloutPercent, fallbackSnapshotIds: draft.fallbackSnapshotIds };
      const saved = await api<RenderEngineAdminTemplateResponse>(`/admin/render-engine/templates/${template.snapshotId}`, { method: "PATCH", headers: await csrfHeaders(), body: JSON.stringify(body) });
      onSaved({ ...template, rolloutPercent: saved.rolloutPercent, fallbackSnapshotIds: saved.fallbackSnapshotIds });
      setMessage({ kind: "ok", text: t("renderEngineAdmin.saved") });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : t("common.error") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{template.name}</div>
          <div className="truncate text-[11.5px] text-lyx-fg-muted">{template.externalTemplateId}</div>
        </div>
        <StatusPill tone={template.rolloutPercent > 0 ? "ok" : "neutral"}>{template.rolloutPercent}%</StatusPill>
      </div>
      <label className="mb-1 block text-[12px] font-medium" htmlFor={`rollout-${template.snapshotId}`}>{t("renderEngineAdmin.rollout")}</label>
      <Select id={`rollout-${template.snapshotId}`} value={String(draft.rolloutPercent)} disabled={busy} onChange={(e) => setDraft({ ...draft, rolloutPercent: Number(e.target.value) })}>
        {steps.map((step) => <option key={step} value={step}>{step}%</option>)}
      </Select>
      <p className="mt-1 mb-3 text-[11.5px] text-lyx-fg-muted">{t("renderEngineAdmin.rolloutHint")}</p>
      <div className="mb-1 text-[12px] font-medium">{t("renderEngineAdmin.fallbacks")}</div>
      {template.fallbackCandidates.length === 0 ? (
        <p className="mb-2 text-[12px] text-lyx-fg-muted">{t("renderEngineAdmin.noFallback")}</p>
      ) : (
        <div className="mb-2 flex max-h-40 flex-col gap-1 overflow-auto">
          {template.fallbackCandidates.map((candidate) => (
            <label key={candidate.snapshotId} className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={draft.fallbackSnapshotIds.includes(candidate.snapshotId)} disabled={busy} onChange={() => toggleFallback(candidate.snapshotId)} />
              <span className="truncate">{candidate.name}</span>
              <span className="text-[11px] text-lyx-fg-muted">{t(`renderEngine.name.${candidate.engine}`, candidate.engine)}</span>
            </label>
          ))}
        </div>
      )}
      {problem === "needsFallback" ? <Banner variant="warn">{t("renderEngineAdmin.needsFallback")}</Banner> : null}
      {message ? <Banner variant={message.kind === "ok" ? "info" : "danger"}>{message.text}</Banner> : null}
      <Button disabled={busy || !dirty || problem !== null} onClick={() => void save()}>{busy ? t("common.loading") : t("common.save")}</Button>
    </div>
  );
}

export function RenderEnginePanel() {
  const { t } = useTranslation();
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(7);
  const [data, setData] = useState<RenderEngineAdminOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api<RenderEngineAdminOverviewResponse>(`/admin/render-engine?days=${days}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("renderEngineAdmin.loadError"));
    }
  }, [days, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const metrics = data?.metrics;
  const failRate = metrics ? qcFailureRate(metrics) : null;
  const usage = metrics ? budgetUsage(metrics) : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold">{t("renderEngineAdmin.title")}</h2>
          <p className="text-[12px] text-lyx-fg-muted">{t("renderEngineAdmin.hint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select aria-label={t("renderEngineAdmin.window")} value={String(days)} onChange={(e) => setDays(Number(e.target.value) as (typeof WINDOWS)[number])}>
            {WINDOWS.map((n) => <option key={n} value={n}>{t("renderEngineAdmin.days", { n })}</option>)}
          </Select>
          <Button variant="secondary" onClick={() => void load()}>{t("renderEngineAdmin.refresh")}</Button>
        </div>
      </div>
      {error ? <Banner variant="danger">{error}</Banner> : null}

      {metrics ? (
        <section className="flex flex-col gap-3">
          <h3 className="text-[14px] font-semibold">{t("renderEngineAdmin.metrics")}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t("renderEngineAdmin.internalJobs")} value={String(metrics.internal.jobs)} sub={`${metrics.internal.completed} ${t("renderEngineAdmin.completed")} · ${metrics.internal.failed} ${t("renderEngineAdmin.failed")}`} />
            <Stat label={t("renderEngineAdmin.qcFailRate")} value={formatShare(failRate)} sub={`${metrics.internal.qcFailed}`} />
            <Stat label={t("renderEngineAdmin.renderTime")} value={`${t("renderEngineAdmin.p50")} ${formatSeconds(metrics.internal.renderMs.p50)}`} sub={`${t("renderEngineAdmin.p95")} ${formatSeconds(metrics.internal.renderMs.p95)} · ${t("renderEngineAdmin.samples", { n: metrics.internal.renderMs.samples })}`} />
            <Stat label={t("renderEngineAdmin.fallbackTotal")} value={String(metrics.fallbacks.total)} sub={`${t("renderEngineAdmin.fallbackShare")}: ${formatShare(metrics.fallbacks.shareOfInternalAttempts)}`} />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-3">
              <div className="mb-2 text-[12px] font-medium">{t("renderEngineAdmin.qcByCode")}</div>
              {qcFailureList(metrics).length === 0 ? <p className="text-[12px] text-lyx-fg-muted">{t("renderEngineAdmin.none")}</p> : (
                <ul className="flex flex-col gap-1 text-[12.5px]">
                  {qcFailureList(metrics).map((item) => <li key={item.code} className="flex justify-between"><span>{item.code}</span><span className="font-semibold">{item.count}</span></li>)}
                </ul>
              )}
              {Object.keys(metrics.fallbacks.byReason).length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1 border-t border-lyx-border pt-2 text-[12.5px]">
                  {Object.entries(metrics.fallbacks.byReason).map(([reason, count]) => <li key={reason} className="flex justify-between gap-3"><span>{t(routeReasonKey(reason as never), reason)}</span><span className="font-semibold">{count}</span></li>)}
                </ul>
              ) : null}
            </div>
            <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-3">
              <div className="mb-2 text-[12px] font-medium">{t("renderEngineAdmin.budget")}</div>
              <div className="mb-1 flex justify-between text-[12.5px]">
                <span>{t("renderEngineAdmin.budgetToday")}</span>
                <span className="font-semibold">{formatUsd(metrics.budget.fallbackTodayUsd)} <span className="font-normal text-lyx-fg-muted">({t("renderEngineAdmin.ceiling", { usd: formatUsd(metrics.budget.dailyCeilingUsd) })})</span></span>
              </div>
              <div className="mb-3 h-1.5 overflow-hidden rounded bg-lyx-muted" role="progressbar" aria-valuenow={Math.round(usage * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className={`h-full ${usage >= 0.8 ? "bg-lyx-danger" : "bg-lyx-ok"}`} style={{ width: `${Math.round(usage * 100)}%` }} />
              </div>
              <div className="flex justify-between text-[12.5px]">
                <span>{t("renderEngineAdmin.budgetMonth")}</span>
                <span className="font-semibold">{formatUsd(metrics.budget.fallbackMonthUsd)}{metrics.budget.monthlyCeilingUsd !== null ? <span className="font-normal text-lyx-fg-muted"> ({t("renderEngineAdmin.ceiling", { usd: formatUsd(metrics.budget.monthlyCeilingUsd) })})</span> : null}</span>
              </div>
            </div>
          </div>

          <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-3">
            <div className="mb-2 text-[12px] font-medium">{t("renderEngineAdmin.costByDay")}</div>
            {metrics.costByDay.length === 0 ? <p className="text-[12px] text-lyx-fg-muted">{t("renderEngineAdmin.none")}</p> : (
              <table className="w-full text-left text-[12.5px]">
                <thead className="text-lyx-fg-muted">
                  <tr><th className="py-1 font-medium">{t("renderEngineAdmin.date")}</th>{(["lyonix", "creatomate", "orshot"] as const).map((engine) => <th key={engine} className="py-1 font-medium">{t(`renderEngine.name.${engine}`)}</th>)}<th className="py-1 font-medium">{t("renderEngineAdmin.total")}</th></tr>
                </thead>
                <tbody>
                  {metrics.costByDay.map((day) => (
                    <tr key={day.date} className="border-t border-lyx-border">
                      <td className="py-1">{day.date}</td><td>{formatUsd(day.lyonix)}</td><td>{formatUsd(day.creatomate)}</td><td>{formatUsd(day.orshot)}</td><td className="font-semibold">{formatUsd(day.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11.5px] text-lyx-fg-muted">{t("renderEngineAdmin.estimateNote")}</p>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h3 className="text-[14px] font-semibold">{t("renderEngineAdmin.templates")}</h3>
        {data && data.templates.length === 0 ? <p className="text-[12px] text-lyx-fg-muted">{t("renderEngineAdmin.noTemplates")}</p> : null}
        <div className="grid gap-4 lg:grid-cols-2">
          {data?.templates.map((template) => (
            <TemplateRow
              key={template.snapshotId}
              template={template}
              onSaved={(saved) => setData((current) => (current ? { ...current, templates: current.templates.map((row) => (row.snapshotId === saved.snapshotId ? saved : row)) } : current))}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
