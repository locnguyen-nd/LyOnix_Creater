/**
 * Studio workspace for an Orshot render account (the Creatomate workspace is untouched).
 * Three tabs: Orshot Embed editor (iframe + trusted postMessage), template picker with slot compatibility,
 * and render options / cost estimate / progress. Orshot renders a pinned template's FIXED slots, so there is no
 * N-scene dynamic composition here; cost is an estimate (Orshot exposes no balance API).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CreatomateTemplateSummaryResponse, OrshotCostEstimateResponse, OrshotRenderOptions, RenderJobResponse, TemplateSnapshotResponse } from "@lyonix/contracts";
import { ApiError } from "../api";
import type { ApiProvider } from "../jobs-api";
import { useMe } from "../session";
import { Banner, StatusPill } from "../components/chrome";
import { RenderProgress } from "../components/RenderProgress";
import { TemplatePreviewButton, TemplatePreviewModal, TemplateThumb } from "../components/TemplatePreviewModal";
import { Button, Select } from "../components/ui";
import { fetchOrshotEstimate, listCreatomateTemplates, pinTemplateSnapshot, reconcileRenderJob } from "./timeline-api";
import {
  ORSHOT_FORMATS,
  ORSHOT_FPS,
  ORSHOT_SIZES,
  buildOrshotEmbedUrl,
  elapsedLabel,
  formatUsd,
  hasBlockingSlotMismatch,
  orshotEmbedIdOf,
  parseOrshotEmbedMessage,
  slotCompatibility,
  type TimelineSlotSupply,
} from "./orshot-embed";

type PanelTab = "embed" | "templates" | "render";
const PER_USER_KEY = "lyonix.orshot.perUserWorkspace";
const readPerUser = () => { try { return localStorage.getItem(PER_USER_KEY) === "1"; } catch { return false; } };
const writePerUser = (value: boolean) => { try { localStorage.setItem(PER_USER_KEY, value ? "1" : "0"); } catch { /* storage unavailable: per-viewer convenience only */ } };

export type OrshotStudioPanelProps = {
  account: ApiProvider;
  projectId: string;
  /** Saved timeline version the estimate/render run against (null until the first save). */
  timelineVersionId: string | null;
  timelineApproved: boolean;
  dirty: boolean;
  template: TemplateSnapshotResponse | null;
  supply: TimelineSlotSupply;
  options: OrshotRenderOptions;
  onOptionsChange: (options: OrshotRenderOptions) => void;
  renderJob: RenderJobResponse | null;
  onRenderJobChange: (job: RenderJobResponse) => void;
  submitting: boolean;
  onSubmit: () => void;
  onPinned: (snapshot: TemplateSnapshotResponse) => void;
  onBackToClassic: () => void;
};

const isActive = (job: RenderJobResponse | null) => Boolean(job) && !["completed", "failed", "cancelled"].includes(job!.status);

export function OrshotStudioPanel(props: OrshotStudioPanelProps) {
  const { account, projectId, timelineVersionId, timelineApproved, dirty, template, supply, options, onOptionsChange, renderJob, onRenderJobChange, submitting, onSubmit, onPinned, onBackToClassic } = props;
  const { t, i18n } = useTranslation();
  const me = useMe();
  const embedId = orshotEmbedIdOf(account.model);
  const [tab, setTab] = useState<PanelTab>(embedId ? "embed" : "templates");
  const [perUser, setPerUser] = useState(readPerUser);
  const [templates, setTemplates] = useState<CreatomateTemplateSummaryResponse[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [pinningId, setPinningId] = useState<string | null>(null);
  // V04-XX: 9:16 preview of the Orshot templates; it never pins - only "Dùng" / "Chọn template này" does.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const previewTemplates = useMemo(() => (templates ?? []).map((tpl) => ({ ...tpl, engine: "orshot" as const })), [templates]);
  const [embedNotice, setEmbedNotice] = useState<string | null>(null);
  const [eventsOff, setEventsOff] = useState(false);
  const [estimate, setEstimate] = useState<OrshotCostEstimateResponse | null>(null);
  const [estimateState, setEstimateState] = useState<"idle" | "loading" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    setTemplatesError(null);
    try { setTemplates(await listCreatomateTemplates(account.id)); }
    catch (err) { setTemplatesError(err instanceof ApiError ? err.message : t("common.error")); }
    finally { setLoadingTemplates(false); }
  }, [account.id, t]);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  // Trusted events only: https://orshot.com AND this iframe's own window (see parseOrshotEmbedMessage).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const parsed = parseOrshotEmbedMessage(event, frameRef.current?.contentWindow ?? null);
      if (!parsed) return;
      if (parsed.kind === "ready") { setEventsOff(parsed.eventsEnabled === false); return; }
      if (parsed.kind === "template-created" || parsed.kind === "template-updated") {
        setEmbedNotice(t("studioPro.orshotTemplateChanged"));
        // Orshot's template list endpoint is rate-limited (30/min): coalesce bursts of events into one refresh.
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => { void loadTemplates(); }, 2500);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [loadTemplates, t]);

  // Estimate follows the SAVED timeline version (narration lengths), so it only runs once autosave has caught up.
  useEffect(() => {
    if (!timelineVersionId || dirty) return;
    let cancelled = false;
    setEstimateState("loading");
    void fetchOrshotEstimate(projectId, timelineVersionId)
      .then((value) => { if (!cancelled) { setEstimate(value); setEstimateState("idle"); } })
      .catch(() => { if (!cancelled) setEstimateState("failed"); });
    return () => { cancelled = true; };
  }, [projectId, timelineVersionId, dirty]);

  useEffect(() => {
    if (!isActive(renderJob)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [renderJob]);

  const pin = async (externalTemplateId: string): Promise<boolean> => {
    setPinningId(externalTemplateId);
    setError(null);
    try { onPinned(await pinTemplateSnapshot(account.id, externalTemplateId)); return true; }
    catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); return false; }
    finally { setPinningId(null); }
  };

  const reconcile = async () => {
    if (!renderJob) return;
    try { onRenderJobChange(await reconcileRenderJob(renderJob.id)); }
    catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
  };

  const rows = useMemo(() => (template ? slotCompatibility(template.modifications, supply) : []), [template, supply]);
  const blocking = hasBlockingSlotMismatch(rows);
  const embedUrl = embedId ? buildOrshotEmbedUrl(embedId, { templateId: template?.externalTemplateId ?? null, lang: i18n.language, userId: perUser ? me.id : null }) : null;
  const canRender = timelineApproved && !dirty && Boolean(template) && !blocking && !submitting && !isActive(renderJob) && !estimate?.exceedsPlanLimit;
  const disabledReason = !timelineApproved ? t("studioPro.orshotRenderNeedsApproval") : dirty ? t("studioPro.submitRenderDirtyHint") : !template ? t("studioPro.orshotRenderNeedsTemplate") : blocking ? t("studioPro.orshotRenderBlocked") : estimate?.exceedsPlanLimit ? t("studioPro.orshotCostOver", { max: estimate.maxVideoSeconds }) : undefined;
  const setOption = (patch: Partial<OrshotRenderOptions>) => onOptionsChange({ ...options, ...patch });
  const clearOption = (key: "format" | "fps" | "size") => { const { [key]: _removed, ...rest } = options; onOptionsChange(rest); };

  const tabs: Array<[PanelTab, string]> = [["embed", t("studioPro.orshotTabEmbed")], ["templates", t("studioPro.orshotTabTemplates")], ["render", t("studioPro.orshotTabRender")]];

  return (
    <section className="mx-5 mb-5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg" data-testid="orshot-studio-panel">
      <div className="flex flex-wrap items-center gap-4 border-b border-lyx-border px-3 pt-2">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)} className={`pb-2 text-[12.5px] ${tab === key ? "border-b-2 border-lyx-fg font-medium" : "text-lyx-fg-muted"}`}>{label}</button>
        ))}
        <span className="ml-auto pb-2"><Button variant="ghost" className="h-8" onClick={onBackToClassic}>{t("studioPro.orshotBackClassic")}</Button></span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? <Banner variant="danger">{error}</Banner> : null}

        {tab === "embed" ? (
          <div className="flex flex-col gap-2">
            {!embedUrl ? (
              <Banner variant="warn">{t("studioPro.orshotNoEmbed")}</Banner>
            ) : (
              <>
                {eventsOff ? <Banner variant="warn">{t("studioPro.orshotEmbedNeedsEvents")}</Banner> : null}
                {embedNotice ? <Banner>{embedNotice}</Banner> : null}
                <label className="flex items-center gap-2 text-[12px]">
                  <input type="checkbox" checked={perUser} onChange={(event) => { setPerUser(event.target.checked); writePerUser(event.target.checked); }} />
                  <span>{t("studioPro.orshotPerUser")}</span>
                  <span className="text-lyx-fg-muted">{t("studioPro.orshotPerUserHint")}</span>
                </label>
                <iframe
                  key={embedUrl}
                  ref={frameRef}
                  title={t("studioPro.orshotEmbedTitle")}
                  src={embedUrl}
                  allow="clipboard-write"
                  referrerPolicy="strict-origin"
                  className="h-[70vh] min-h-[480px] w-full rounded-[6px] border border-lyx-border bg-white"
                />
              </>
            )}
          </div>
        ) : null}

        {tab === "templates" ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-[12.5px] font-medium">{t("studioPro.orshotTemplatesTitle")}</p>
              <Button variant="secondary" className="h-8" disabled={loadingTemplates} onClick={() => void loadTemplates()}>{loadingTemplates ? t("studioPro.orshotLoading") : t("studioPro.orshotRefresh")}</Button>
            </div>
            {templatesError ? <Banner variant="danger">{templatesError}</Banner> : null}
            {templates && templates.length === 0 ? <p className="text-[12px] text-lyx-fg-muted">{t("studioPro.orshotNoTemplates")}</p> : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {(templates ?? []).map((item, index) => {
                const pinned = template?.externalTemplateId === item.externalTemplateId;
                return (
                  <article key={item.externalTemplateId} className={`rounded-[6px] border p-1.5 text-[11px] ${pinned ? "border-lyx-fg" : "border-lyx-border"}`}>
                    <button type="button" onClick={() => setPreviewIndex(index)} title={t("templates.previewOpen")} className="mb-1 flex h-28 w-full items-center justify-center overflow-hidden rounded-[4px] bg-lyx-muted text-[10px] text-lyx-fg-subtle">
                      <TemplateThumb template={previewTemplates[index]!} fallbackLabel={t("templates.preview")} />
                    </button>
                    <p className="mb-1 line-clamp-2 font-medium">{item.name}</p>
                    <TemplatePreviewButton onClick={() => setPreviewIndex(index)} label={t("templates.previewOpen")} className="mb-1 w-full justify-center" />
                    {pinned ? <StatusPill tone="ok">{t("studioPro.orshotPinned")}</StatusPill> : (
                      <Button variant="secondary" className="h-7 w-full" disabled={pinningId !== null} onClick={() => void pin(item.externalTemplateId)}>
                        {pinningId === item.externalTemplateId ? t("studioPro.orshotPinning") : t("studioPro.orshotUse")}
                      </Button>
                    )}
                  </article>
                );
              })}
              {previewIndex !== null && previewTemplates[previewIndex] ? (
                <TemplatePreviewModal
                  templates={previewTemplates}
                  index={previewIndex}
                  onIndexChange={setPreviewIndex}
                  selectedId={template?.externalTemplateId ?? null}
                  selecting={pinningId !== null}
                  onSelect={(tpl) => void pin(tpl.externalTemplateId).then((ok) => { if (ok) setPreviewIndex(null); })}
                  onClose={() => setPreviewIndex(null)}
                />
              ) : null}
            </div>

            <div className="rounded-[6px] border border-lyx-border p-2">
              <p className="mb-1 text-[12.5px] font-medium">{t("studioPro.orshotCompatTitle")}</p>
              {!template ? <p className="text-[12px] text-lyx-fg-muted">{t("studioPro.orshotCompatNoTemplate")}</p> : (
                <table className="w-full text-[12px]">
                  <thead><tr className="text-left text-lyx-fg-muted"><th className="py-1">{t("studioPro.orshotCompatKind")}</th><th>{t("studioPro.orshotCompatTemplate")}</th><th>{t("studioPro.orshotCompatTimeline")}</th><th /></tr></thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.kind} className="border-t border-lyx-border">
                        <td className="py-1">{t(`studioPro.orshotKind_${row.kind}`)}</td>
                        <td>{row.templateSlots}</td>
                        <td>{row.timelineItems}</td>
                        <td><StatusPill tone={row.status === "ok" ? "ok" : row.status === "missing" ? "danger" : "warn"}>{t(`studioPro.orshotCompat_${row.status}`)}</StatusPill></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {blocking ? <p className="mt-1 text-[12px] text-lyx-danger">{t("studioPro.orshotRenderBlocked")}</p> : null}
              <p className="mt-1 text-[11px] text-lyx-fg-muted">{t("studioPro.orshotTemplateOnlyHint")}</p>
            </div>
          </div>
        ) : null}

        {tab === "render" ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="flex flex-col gap-1 text-[12px]">{t("studioPro.orshotFormat")}
                <Select value={options.format ?? ""} onChange={(event) => event.target.value ? setOption({ format: event.target.value as NonNullable<OrshotRenderOptions["format"]> }) : clearOption("format")}>
                  <option value="">mp4</option>
                  {ORSHOT_FORMATS.filter((format) => format !== "mp4").map((format) => <option key={format} value={format}>{format}</option>)}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[12px]">{t("studioPro.orshotFps")}
                <Select value={options.fps ?? ""} onChange={(event) => event.target.value ? setOption({ fps: Number(event.target.value) as NonNullable<OrshotRenderOptions["fps"]> }) : clearOption("fps")}>
                  <option value="">{t("studioPro.orshotTemplateDefault")}</option>
                  {ORSHOT_FPS.map((fps) => <option key={fps} value={fps}>{fps}</option>)}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[12px]">{t("studioPro.orshotSize")}
                <Select value={options.size ?? ""} onChange={(event) => (event.target.value ? setOption({ size: event.target.value }) : clearOption("size"))}>
                  <option value="">{t("studioPro.orshotSizeTemplate")}</option>
                  {ORSHOT_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </Select>
              </label>
              <label className="flex items-end gap-2 pb-2 text-[12px]">
                <input type="checkbox" checked={options.fitDurationToNarration !== false} onChange={(event) => setOption({ fitDurationToNarration: event.target.checked })} />
                <span>{t("studioPro.orshotFit")}</span>
              </label>
            </div>
            <p className="text-[11px] text-lyx-fg-muted">{t("studioPro.orshotFitHint")}</p>

            <div className="rounded-[6px] border border-lyx-border p-2 text-[12px]" aria-live="polite">
              <p className="mb-1 text-[12.5px] font-medium">{t("studioPro.orshotCostTitle")}</p>
              {estimateState === "loading" && !estimate ? <p className="text-lyx-fg-muted">{t("studioPro.orshotLoading")}</p> : null}
              {estimateState === "failed" ? <p className="text-lyx-danger">{t("studioPro.orshotCostFailed")}</p> : null}
              {!timelineVersionId ? <p className="text-lyx-fg-muted">{t("studioPro.orshotCostNoTimeline")}</p> : null}
              {estimate && timelineVersionId ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  <div><dt className="text-lyx-fg-muted">{t("studioPro.orshotCostSeconds")}</dt><dd>{estimate.durationSec}s</dd></div>
                  <div><dt className="text-lyx-fg-muted">{t("studioPro.orshotCostCredits")}</dt><dd>{estimate.credits}</dd></div>
                  <div><dt className="text-lyx-fg-muted">{t("studioPro.orshotCostUsd")}</dt><dd>≈ {formatUsd(estimate.amountUsd)}</dd></div>
                  <div><dt className="text-lyx-fg-muted">{t("studioPro.orshotCostVoices")}</dt><dd>{estimate.scenesWithVoice}/{estimate.scenesTotal}</dd></div>
                </dl>
              ) : null}
              {estimate && estimate.durationSec === 0 ? <p className="mt-1 text-lyx-warn">{t("studioPro.orshotCostNoVoice")}</p> : null}
              {estimate?.exceedsPlanLimit ? <p className="mt-1 text-lyx-danger">{t("studioPro.orshotCostOver", { max: estimate.maxVideoSeconds })}</p> : null}
              <p className="mt-1 text-[11px] text-lyx-fg-muted">{t("studioPro.orshotCostNote")}</p>
            </div>

            <div className="flex items-center gap-3">
              <Button disabled={!canRender} title={disabledReason} onClick={onSubmit}>{t("studioPro.orshotRender")}</Button>
              {!canRender && disabledReason ? <span className="text-[11.5px] text-lyx-fg-muted">{disabledReason}</span> : null}
            </div>

            {renderJob ? (
              <div className="flex flex-col gap-2">
                <RenderProgress job={renderJob} />
                {isActive(renderJob) ? (
                  <div className="flex items-center gap-3 text-[12px]">
                    <span>{t("studioPro.orshotElapsed", { time: elapsedLabel(renderJob.createdAt, now) })}</span>
                    <span className="text-lyx-fg-muted">{t("studioPro.orshotNoPercent")}</span>
                    <Button variant="secondary" className="h-7" onClick={() => void reconcile()}>{t("studioPro.orshotReconcile")}</Button>
                  </div>
                ) : null}
                {renderJob.costAmount ? <p className="text-[12px]">{t("studioPro.orshotActualCost", { amount: formatUsd(renderJob.costAmount) })}</p> : null}
                {renderJob.status === "completed" && renderJob.resultUrl ? (
                  <div>
                    <video key={renderJob.resultUrl} className="mb-2 max-h-[360px] w-full rounded-[6px] bg-black" src={renderJob.resultUrl} controls />
                    <div className="flex gap-3 text-[11.5px]">
                      <a className="underline" href={renderJob.resultUrl} target="_blank" rel="noreferrer">{t("studioPro.openResult")}</a>
                      <a className="underline" href={renderJob.resultUrl} download>{t("studioPro.downloadResult")}</a>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
