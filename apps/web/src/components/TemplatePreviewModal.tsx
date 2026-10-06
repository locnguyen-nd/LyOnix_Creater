import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Film, ImageOff, Info, LayoutTemplate, Newspaper, Siren, Trophy, X, type LucideIcon } from "lucide-react";
import type { CreatomatePreviewConfigResponse, RenderEngine } from "@lyonix/contracts";
import { RecipePreview } from "./RecipePreview";
import { ProviderBadge } from "./ProviderBadge";
import { fetchCreatomatePreviewConfig } from "../studio/timeline-api";
import { isCreatomatePreviewSupported, mountCreatomatePreview, type CreatomatePreviewHandle } from "../studio/creatomate-preview";
import { canShowMotionPreview, stepIndex, templatePreviewSource, type PreviewableTemplate } from "../studio/template-preview";
import { previewSourceKind, templateCategory, templateLanguages, templateReadiness, templateRecipeId, templateStyleTags, type TemplateCategory } from "../studio/template-catalog";

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
  /** Label of the apply button when it is not "Chọn template này" (Studio gallery: "Dùng template"). */
  selectLabel?: string;
};

let configRequest: Promise<CreatomatePreviewConfigResponse | null> | null = null;
const loadMotionConfig = () => (configRequest ??= fetchCreatomatePreviewConfig().catch(() => null));

type Tab = "picture" | "motion";
type LoadState = "loading" | "ready" | "error";

/** Default tab: a LyOnix template opens on its motion simulation (drawn locally); a provider template on its picture (no third-party iframe until asked). */
const defaultTab = (engine: RenderEngine | undefined): Tab => (engine === "lyonix" ? "motion" : "picture");

/** Small engine badge used by the cards and the preview (LyOnix Render / Creatomate / Orshot). */
export function EngineBadge({ engine, viaFallback = false }: { engine: RenderEngine; viaFallback?: boolean }) {
  // V04-02: the shared provider identity (mark + name).
  return <ProviderBadge engine={engine} viaFallback={viaFallback} />;
}

/**
 * V04-01 (on V04-XX): 9:16 preview of one template of a list, BEFORE choosing it. Looking at a template (opening, browsing with
 * ← / →, the motion tab) never selects, pins or renders it and never costs a credit - only "Chọn template này" calls `onSelect`, and
 * only when the template is ready to render. The panel keeps the render engine and the preview source apart.
 */
export function TemplatePreviewModal({ templates, index, onIndexChange, selectedId, onSelect, onClose, selecting = false, motionConfig, selectLabel }: TemplatePreviewModalProps) {
  const { t } = useTranslation();
  const template = templates[index];
  const [tab, setTab] = useState<Tab>(defaultTab(template?.engine));
  const [imageState, setImageState] = useState<LoadState>("loading");
  const [motionState, setMotionState] = useState<LoadState>("loading");
  const [config, setConfig] = useState<CreatomatePreviewConfigResponse | null>(motionConfig ?? null);
  const motionRef = useRef<HTMLDivElement | null>(null);
  const many = templates.length > 1;

  useEffect(() => {
    setTab(defaultTab(template?.engine));
    setImageState("loading");
  }, [template?.externalTemplateId, template?.engine]);

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

  // Creatomate motion tab: the Preview SDK plays the template in the browser - no render job, no credit. Mounted only while the tab is open.
  useEffect(() => {
    if (tab !== "motion" || template?.engine !== "creatomate" || !config?.publicToken || !motionRef.current) return;
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
  const readiness = templateReadiness(template);
  const isLyonix = source.kind === "recipe";
  const creatomateMotion = canShowMotionPreview(template, config, isCreatomatePreviewSupported());
  const showTabs = isLyonix || creatomateMotion;
  const category = templateCategory(template);
  const tags = templateStyleTags(template);
  const languages = templateLanguages(template);
  const recipeId = templateRecipeId(template);
  const sourceKind = previewSourceKind(template, tab === "motion" && creatomateMotion ? "motion" : "picture");

  const frame = (() => {
    if (source.kind === "recipe") return <RecipePreview recipe={source.recipe} playing={tab === "motion"} />;
    if (tab === "motion" && creatomateMotion) {
      return (
        <>
          <div ref={motionRef} className="h-full w-full" />
          {motionState !== "ready" ? (
            <div className={`absolute inset-0 flex items-center justify-center p-4 text-center text-[12px] ${motionState === "loading" ? "lyx-skeleton text-lyx-fg-muted" : "bg-lyx-muted text-lyx-danger"}`}>
              {motionState === "loading" ? t("templates.previewLoading") : t("templates.previewMotionError")}
            </div>
          ) : null}
        </>
      );
    }
    if (source.kind === "image" && imageState !== "error") {
      return (
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
      );
    }
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-[12px] text-lyx-fg-muted" data-testid="template-preview-fallback">
        <ImageOff size={28} aria-hidden="true" />
        <span className="font-medium text-lyx-fg">{template.name}</span>
        <span>{source.kind === "image" ? t("templates.previewImageError") : t("templates.previewNoImage")}</span>
      </div>
    );
  })();

  const rows: Array<[string, ReactNode]> = [
    [t("templates.library.info.engine"), <EngineBadge key="engine" engine={template.engine} viaFallback={readiness.ready && readiness.hasFallback} />],
    [t("templates.library.info.category"), category ? t(`templates.library.category.${category}`) : t("templates.library.categoryNone")],
    ...(tags.length ? [[t("templates.library.info.tags"), tags.join(" · ")] as [string, ReactNode]] : []),
    [t("templates.library.info.aspect"), "9:16"],
    ...(languages.length ? [[t("templates.library.info.language"), languages.map((code) => t(`templates.library.language.${code}`, code)).join(", ")] as [string, ReactNode]] : []),
    ...(recipeId ? [[t("templates.library.info.description"), t(`templates.library.catalog.${recipeId}.description`, "")] as [string, ReactNode], [t("templates.library.info.suited"), t(`templates.library.catalog.${recipeId}.suited`, "")] as [string, ReactNode]] : []),
    [t("templates.library.info.source"), <span key="source" data-testid="template-preview-source">{t(`templates.library.source.${sourceKind}`)}</span>],
    ...(template.accountName ? [[t("templates.library.info.account"), template.accountName] as [string, ReactNode]] : []),
    [
      t("templates.library.info.status"),
      <span key="status" className={readiness.ready ? "text-lyx-ok" : "font-medium text-lyx-warn"} data-testid="template-preview-status">
        {readiness.ready ? t("templates.library.statusReady") : t("templates.library.statusNotReady")}
      </span>,
    ],
  ];

  return (
    <div className="lyx-anim-backdrop fixed inset-0 z-50 flex items-center justify-center bg-[var(--lyx-overlay)] p-3 backdrop-blur-[2px] sm:p-4" role="presentation" onClick={() => { if (!selecting) onClose(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("templates.previewTitle")}
        data-testid="template-preview"
        className="lyx-anim-dialog flex max-h-[94vh] w-[860px] max-w-full flex-col overflow-y-auto rounded-[12px] border border-lyx-border bg-lyx-elevated shadow-2xl md:flex-row md:overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        {/* left: 9:16 frame */}
        <div className="relative flex shrink-0 items-center justify-center bg-black/90 px-10 py-4 md:px-12 md:py-6">
          <div className="relative h-[min(52vh,520px)] overflow-hidden rounded-[8px] bg-lyx-muted shadow-lg md:h-[min(70vh,620px)]" style={{ aspectRatio: "9 / 16" }}>
            {frame}
            {isLyonix ? <span className="absolute left-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">{t("templates.previewSimulatedBadge")}</span> : null}
          </div>
          {many ? (
            <>
              <button type="button" aria-label={t("templates.previewPrev")} onClick={() => onIndexChange(stepIndex(index, templates.length, -1))} className="absolute left-1.5 top-1/2 -translate-y-1/2 rounded-full bg-white/15 p-1.5 text-white transition hover:bg-white/30">
                <ChevronLeft size={20} />
              </button>
              <button type="button" aria-label={t("templates.previewNext")} onClick={() => onIndexChange(stepIndex(index, templates.length, 1))} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full bg-white/15 p-1.5 text-white transition hover:bg-white/30">
                <ChevronRight size={20} />
              </button>
              <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-[10.5px] text-white md:bottom-2">{t("templates.previewCount", { current: index + 1, total: templates.length })}</span>
            </>
          ) : null}
        </div>

        {/* right: details + actions */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 md:overflow-y-auto md:p-5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-[16px] font-semibold leading-6">{template.name}</h2>
              {category ? <p className="mt-0.5 text-[12px] text-lyx-fg-muted">{t(`templates.library.category.${category}`)} · 9:16</p> : null}
            </div>
            <button type="button" aria-label={t("templates.previewClose")} disabled={selecting} onClick={onClose} className="rounded-full p-1 text-lyx-fg-subtle hover:bg-lyx-muted hover:text-lyx-fg">
              <X size={16} />
            </button>
          </div>

          {showTabs ? (
            <div className="inline-flex w-fit gap-0.5 rounded-[8px] bg-lyx-muted p-1" role="tablist">
              {(isLyonix ? (["motion", "picture"] as const) : (["picture", "motion"] as const)).map((item) => (
                <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={`rounded-[6px] px-3 py-1 text-[12px] font-semibold ${tab === item ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
                  {item === "picture" ? t("templates.previewTabPicture") : isLyonix ? t("templates.library.tabSimulation") : t("templates.previewTabMotion")}
                </button>
              ))}
            </div>
          ) : null}

          <dl className="grid grid-cols-[minmax(92px,auto)_1fr] gap-x-3 gap-y-1.5 text-[12px]" data-testid="template-preview-info">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-lyx-fg-muted">{label}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>

          <p className="flex items-start gap-2 text-[11.5px] leading-5 text-lyx-fg-muted">
            <Info size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
            <span>{isLyonix ? (tab === "motion" ? t("templates.library.simulationHint") : t("templates.previewSimulated")) : tab === "motion" ? t("templates.previewMotionHint") : t("templates.previewNoCost")}</span>
          </p>

          {!readiness.ready ? (
            <p className="flex items-start gap-2 rounded-[6px] border border-lyx-border bg-lyx-warn-bg px-2.5 py-2 text-[12px] text-lyx-warn" role="note" data-testid="template-preview-blocked">
              <AlertTriangle size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
              <span>{t(`templates.library.blockReason.${readiness.reason}`)}</span>
            </p>
          ) : null}

          <div className="mt-auto flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <button type="button" className="lyx-btn lyx-btn-ghost" disabled={selecting} onClick={onClose}>{t("templates.previewClose")}</button>
            {isSelected ? (
              <button type="button" disabled className="lyx-btn lyx-btn-secondary" data-testid="template-preview-selected">
                <Check size={15} aria-hidden="true" /> {t("templates.previewSelected")}
              </button>
            ) : (
              <button type="button" className="lyx-btn lyx-btn-primary" disabled={selecting || !readiness.ready} onClick={() => onSelect(template)} data-testid="template-preview-select">
                <Check size={15} aria-hidden="true" /> {selecting ? t("templates.previewSelecting") : (selectLabel ?? t("templates.previewSelect"))}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Card thumbnail, in this order: the provider picture, the recipe simulation of a LyOnix template (moving while `playing`), else a
 * styled fallback (V04-02) - also when the provider picture fails to load, so a broken-image icon never shows.
 */
export function TemplateThumb({ template, playing = false }: { template: PreviewableTemplate; playing?: boolean }) {
  const source = templatePreviewSource(template);
  const imageUrl = source.kind === "image" ? source.url : null;
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [imageUrl]);
  if (source.kind === "recipe") return <RecipePreview recipe={source.recipe} playing={playing} />;
  if (imageUrl && !broken) return <img src={imageUrl} alt={template.name} loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setBroken(true)} data-testid="template-thumb-image" />;
  return <TemplateFallbackThumb template={template} />;
}

const FALLBACK_STYLE: Record<TemplateCategory | "none", { gradient: string; Icon: LucideIcon }> = {
  news: { gradient: "from-sky-600 via-blue-800 to-slate-950", Icon: Newspaper },
  sports: { gradient: "from-emerald-500 via-green-700 to-emerald-950", Icon: Trophy },
  faceless: { gradient: "from-indigo-500 via-violet-700 to-slate-950", Icon: Film },
  breaking_news: { gradient: "from-red-500 via-rose-700 to-neutral-950", Icon: Siren },
  none: { gradient: "from-slate-500 via-slate-700 to-slate-950", Icon: LayoutTemplate },
};

/** V04-02: picture of a template without a usable image - gradient and icon of its group, its name, 9:16. Drawn locally, no request. */
export function TemplateFallbackThumb({ template }: { template: Pick<PreviewableTemplate, "engine" | "externalTemplateId" | "name" | "tags"> }) {
  const { t } = useTranslation();
  const category = templateCategory(template);
  const { gradient, Icon } = FALLBACK_STYLE[category ?? "none"];
  return (
    <div className={`flex h-full w-full flex-col justify-between bg-gradient-to-b ${gradient} p-3 text-left text-white`} data-testid="template-fallback-thumb" data-category={category ?? "none"}>
      <span className="flex items-center gap-1.5 pl-6 text-[10px] font-semibold uppercase tracking-wide opacity-90">
        <Icon size={13} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{category ? t(`templates.library.category.${category}`) : t("templates.library.categoryNone")}</span>
      </span>
      <span className="line-clamp-5 text-[14px] font-extrabold uppercase leading-tight [overflow-wrap:anywhere]">{template.name}</span>
      <span className="w-fit rounded-[4px] bg-white/20 px-1.5 py-0.5 text-[10px] font-bold">9:16</span>
    </div>
  );
}
