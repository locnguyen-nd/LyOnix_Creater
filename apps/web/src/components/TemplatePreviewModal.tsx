import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, ChevronRight, Eye, ImageOff, Info, X } from "lucide-react";
import type { CreatomatePreviewConfigResponse } from "@lyonix/contracts";
import { RecipePreview } from "./RecipePreview";
import { fetchCreatomatePreviewConfig } from "../studio/timeline-api";
import { isCreatomatePreviewSupported, mountCreatomatePreview, type CreatomatePreviewHandle } from "../studio/creatomate-preview";
import { engineNameKey } from "../studio/render-engine";
import { canShowMotionPreview, stepIndex, templatePreviewSource, type PreviewableTemplate } from "../studio/template-preview";

export type TemplatePreviewModalProps = {
  templates: readonly PreviewableTemplate[];
  index: number;
  onIndexChange: (index: number) => void;
  /** The template currently applied (to the job / timeline), if any. */
  selectedId: string | null;
  /** "Chọn template này" - the ONLY way a preview applies a template. */
  onSelect: (template: PreviewableTemplate) => void;
  onClose: () => void;
  /** The select action is running (e.g. pinning the snapshot). */
  selecting?: boolean;
  /** Preview SDK config; `undefined` = fetched on demand for a Creatomate template. */
  motionConfig?: CreatomatePreviewConfigResponse | null;
};

let configRequest: Promise<CreatomatePreviewConfigResponse | null> | null = null;
const loadMotionConfig = () => (configRequest ??= fetchCreatomatePreviewConfig().catch(() => null));

type Tab = "picture" | "motion";
type LoadState = "loading" | "ready" | "error";

/**
 * V04-XX: 9:16 preview of one template of a list, BEFORE choosing it. Looking at a template (opening, browsing with ← / →, the
 * motion tab) never selects, pins or renders it and never costs a credit - only "Chọn template này" calls `onSelect`.
 */
export function TemplatePreviewModal({ templates, index, onIndexChange, selectedId, onSelect, onClose, selecting = false, motionConfig }: TemplatePreviewModalProps) {
  const { t } = useTranslation();
  const template = templates[index];
  const [tab, setTab] = useState<Tab>("picture");
  const [imageState, setImageState] = useState<LoadState>("loading");
  const [motionState, setMotionState] = useState<LoadState>("loading");
  const [config, setConfig] = useState<CreatomatePreviewConfigResponse | null>(motionConfig ?? null);
  const motionRef = useRef<HTMLDivElement | null>(null);
  const many = templates.length > 1;

  useEffect(() => {
    setTab("picture");
    setImageState("loading");
  }, [template?.externalTemplateId]);

  useEffect(() => {
    if (motionConfig !== undefined || template?.engine !== "creatomate") return;
    let cancelled = false;
    void loadMotionConfig().then((value) => { if (!cancelled) setConfig(value); });
    return () => { cancelled = true; };
  }, [motionConfig, template?.engine]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !selecting) onClose();
      else if (event.key === "ArrowLeft" && many) onIndexChange(stepIndex(index, templates.length, -1));
      else if (event.key === "ArrowRight" && many) onIndexChange(stepIndex(index, templates.length, 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, many, onClose, onIndexChange, selecting, templates.length]);

  // Motion tab: the Preview SDK plays the template in the browser - no render job, no credit. Mounted only while the tab is open.
  useEffect(() => {
    if (tab !== "motion" || !template || !config?.publicToken || !motionRef.current) return;
    let handle: CreatomatePreviewHandle | null = null;
    let cancelled = false;
    setMotionState("loading");
    void mountCreatomatePreview(motionRef.current, config.publicToken)
      .then(async (mounted) => {
        handle = mounted;
        if (cancelled) { mounted.dispose(); return; }
        await mounted.loadTemplate(template.externalTemplateId);
        if (!cancelled) setMotionState("ready");
      })
      .catch(() => { if (!cancelled) setMotionState("error"); });
    return () => {
      cancelled = true;
      handle?.dispose();
    };
  }, [tab, template, config?.publicToken]);

  if (!template) return null;
  const source = templatePreviewSource(template);
  const isSelected = selectedId === template.externalTemplateId;
  const motionAvailable = canShowMotionPreview(template, config, isCreatomatePreviewSupported());

  return (
    <div className="lyx-anim-backdrop fixed inset-0 z-50 flex items-center justify-center bg-[var(--lyx-overlay)] p-4 backdrop-blur-[2px]" role="presentation" onClick={() => { if (!selecting) onClose(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("templates.previewTitle")}
        data-testid="template-preview"
        className="lyx-anim-dialog flex max-h-[92vh] w-[760px] max-w-full flex-col overflow-hidden rounded-[12px] border border-lyx-border bg-lyx-elevated shadow-2xl md:flex-row"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 9:16 frame */}
        <div className="relative flex items-center justify-center bg-black/90 p-4 md:p-6">
          <div className="relative overflow-hidden rounded-[8px] bg-lyx-muted shadow-lg" style={{ aspectRatio: "9 / 16", height: "min(68vh, 620px)" }}>
            {tab === "motion" ? (
              <>
                <div ref={motionRef} className="h-full w-full" />
                {motionState !== "ready" ? (
                  <div className={`absolute inset-0 flex items-center justify-center p-4 text-center text-[12px] ${motionState === "loading" ? "lyx-skeleton text-lyx-fg-muted" : "bg-lyx-muted text-lyx-danger"}`}>
                    {motionState === "loading" ? t("templates.previewLoading") : t("templates.previewMotionError")}
                  </div>
                ) : null}
              </>
            ) : source.kind === "recipe" ? (
              <>
                <RecipePreview recipe={source.recipe} />
                <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">{t("templates.previewSimulatedBadge")}</span>
              </>
            ) : source.kind === "image" && imageState !== "error" ? (
              <>
                {imageState === "loading" ? <div className="lyx-skeleton absolute inset-0" aria-label={t("templates.previewLoading")} /> : null}
                <img
                  key={source.url}
                  src={source.url}
                  alt={template.name}
                  className={`h-full w-full object-cover transition-opacity duration-300 ${imageState === "ready" ? "opacity-100" : "opacity-0"}`}
                  onLoad={() => setImageState("ready")}
                  onError={() => setImageState("error")}
                />
              </>
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-[12px] text-lyx-fg-muted" data-testid="template-preview-fallback">
                <ImageOff size={28} aria-hidden="true" />
                <span className="font-medium text-lyx-fg">{template.name}</span>
                <span>{source.kind === "image" ? t("templates.previewImageError") : t("templates.previewNoImage")}</span>
              </div>
            )}
          </div>
          {many ? (
            <>
              <button type="button" aria-label={t("templates.previewPrev")} onClick={() => onIndexChange(stepIndex(index, templates.length, -1))} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/15 p-1.5 text-white transition hover:bg-white/30">
                <ChevronLeft size={20} />
              </button>
              <button type="button" aria-label={t("templates.previewNext")} onClick={() => onIndexChange(stepIndex(index, templates.length, 1))} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/15 p-1.5 text-white transition hover:bg-white/30">
                <ChevronRight size={20} />
              </button>
              <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-[10.5px] text-white">{t("templates.previewCount", { current: index + 1, total: templates.length })}</span>
            </>
          ) : null}
        </div>

        {/* details + actions */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="mb-1 inline-block rounded-[4px] border border-lyx-border bg-lyx-muted px-1.5 py-0.5 text-[10px] text-lyx-fg-muted">{t(engineNameKey(template.engine))}</span>
              <h2 className="text-[16px] font-semibold leading-6">{template.name}</h2>
              {template.tags.length ? <p className="mt-0.5 text-[11.5px] text-lyx-fg-muted">{template.tags.join(" · ")}</p> : null}
            </div>
            <button type="button" aria-label={t("templates.previewClose")} disabled={selecting} onClick={onClose} className="rounded-full p-1 text-lyx-fg-subtle hover:bg-lyx-muted hover:text-lyx-fg">
              <X size={16} />
            </button>
          </div>

          {motionAvailable ? (
            <div className="inline-flex w-fit gap-0.5 rounded-[8px] bg-lyx-muted p-1" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "picture"} onClick={() => setTab("picture")} className={`rounded-[6px] px-3 py-1 text-[12px] font-semibold ${tab === "picture" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>{t("templates.previewTabPicture")}</button>
              <button type="button" role="tab" aria-selected={tab === "motion"} onClick={() => setTab("motion")} className={`rounded-[6px] px-3 py-1 text-[12px] font-semibold ${tab === "motion" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>{t("templates.previewTabMotion")}</button>
            </div>
          ) : null}

          <p className="flex items-start gap-2 text-[12px] leading-5 text-lyx-fg-muted">
            <Info size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
            <span>{source.kind === "recipe" ? t("templates.previewSimulated") : tab === "motion" ? t("templates.previewMotionHint") : t("templates.previewNoCost")}</span>
          </p>

          <div className="mt-auto flex flex-col gap-2 pt-2">
            {isSelected ? (
              <button type="button" disabled className="lyx-btn lyx-btn-secondary w-full" data-testid="template-preview-selected">
                <Check size={15} aria-hidden="true" /> {t("templates.previewSelected")}
              </button>
            ) : (
              <button type="button" className="lyx-btn lyx-btn-primary w-full" disabled={selecting} onClick={() => onSelect(template)} data-testid="template-preview-select">
                <Check size={15} aria-hidden="true" /> {selecting ? t("templates.previewSelecting") : t("templates.previewSelect")}
              </button>
            )}
            <button type="button" className="lyx-btn lyx-btn-ghost w-full" disabled={selecting} onClick={onClose}>{t("templates.previewClose")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small "Xem trước" icon button for a template card. */
export function TemplatePreviewButton({ onClick, label, className = "" }: { onClick: () => void; label: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className={`inline-flex items-center gap-1 rounded-[6px] border border-lyx-border bg-lyx-bg px-2 py-1 text-[11px] font-medium text-lyx-fg-muted transition hover:border-lyx-strong hover:text-lyx-fg ${className}`} data-testid="template-preview-open">
      <Eye size={13} aria-hidden="true" /> {label}
    </button>
  );
}

/** Card thumbnail: the provider image, or the recipe simulation for a LyOnix template, or a plain label. */
export function TemplateThumb({ template, fallbackLabel }: { template: PreviewableTemplate; fallbackLabel: string }) {
  const source = templatePreviewSource(template);
  if (source.kind === "recipe") return <RecipePreview recipe={source.recipe} />;
  if (source.kind === "image") return <img src={source.url} alt={template.name} loading="lazy" className="h-full w-full object-cover" />;
  return <span>{fallbackLabel}</span>;
}
