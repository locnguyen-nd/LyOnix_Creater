import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Eye, Search } from "lucide-react";
import type { RenderEngine } from "@lyonix/contracts";
import { CATEGORY_FILTERS, categoryCounts, filterByCategory, readinessCount, templateCategory, templateChoice, templateLanguages, templateReadiness, uniqueTemplates, type CategoryFilter, type LibraryTemplate } from "../studio/template-catalog";
import { EngineBadge, TemplatePreviewModal, TemplateThumb } from "./TemplatePreviewModal";
import { CategoryChips } from "./TemplateCard";
import { Button } from "./ui";

const DENSITY_COLUMNS = { 4: "grid-cols-3 sm:grid-cols-4", 5: "grid-cols-3 sm:grid-cols-5", 6: "grid-cols-4 sm:grid-cols-6" } as const;
type Density = keyof typeof DENSITY_COLUMNS;

/** Pure filter used by the browser (and its test): name/tag search + engine + group (+ only the templates that can render now). */
export function filterTemplates(items: readonly LibraryTemplate[], opts: { query: string; engine: RenderEngine | "all"; category: CategoryFilter; readyOnly?: boolean }): LibraryTemplate[] {
  const query = opts.query.trim().toLowerCase();
  const byEngine = opts.engine === "all" ? items : items.filter((item) => item.engine === opts.engine);
  const byQuery = query ? byEngine.filter((item) => item.name.toLowerCase().includes(query) || item.tags.some((tag) => tag.toLowerCase().includes(query))) : byEngine;
  const byReady = opts.readyOnly ? byQuery.filter((item) => templateReadiness(item).ready) : byQuery;
  return filterByCategory(byReady, opts.category);
}

/**
 * Compact two-pane template browser (shared by the Auto drawer and the Studio gallery): search + engine + group filters and a dense
 * grid of small cards on the left, details of the focused template on the right. Focusing a card only looks at it; only the
 * choose button (or a double click) calls `onChoose`. "Xem trước đầy đủ" opens the existing 9:16 preview, which never selects on open.
 * A template that cannot render now (V04-01 readiness: rollout 0 %, no fallback...) is labelled on its card and can never be chosen
 * here - same rule as the preview modal and the API - so it is never stored in an Auto job / draft nor pinned in Studio.
 */
export function TemplateBrowser({ templates, selectedId = null, onChoose, chooseLabel, choosing = false }: {
  templates: readonly LibraryTemplate[];
  /** externalTemplateId of the template in use, if any. */
  selectedId?: string | null;
  onChoose: (template: LibraryTemplate) => void;
  chooseLabel: string;
  choosing?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [engine, setEngine] = useState<RenderEngine | "all">("all");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [readyOnly, setReadyOnly] = useState(false);
  const [density, setDensity] = useState<Density>(5);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const all = useMemo(() => uniqueTemplates(templates), [templates]);
  const engines = useMemo(() => [...new Set(all.map((item) => item.engine))], [all]);
  const counts = useMemo(() => categoryCounts(all), [all]);
  const visible = useMemo(() => filterTemplates(all, { query, engine, category, readyOnly }), [all, query, engine, category, readyOnly]);
  const readyCount = useMemo(() => readinessCount(all), [all]);
  const focused = visible.find((item) => item.key === focusKey) ?? visible.find((item) => item.externalTemplateId === selectedId) ?? visible[0] ?? null;
  const readiness = focused ? templateReadiness(focused) : null;
  const choice = focused ? templateChoice(focused, selectedId) : null;
  const focusedCategory = focused ? templateCategory(focused) : null;

  return (
    <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,1fr)_220px]" data-testid="template-browser">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[160px] flex-1">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-lyx-fg-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("templatePicker.search")}
              aria-label={t("templatePicker.search")}
              className="h-9 w-full rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg pl-8 pr-2 text-[12.5px]"
            />
          </label>
          <select value={engine} onChange={(event) => setEngine(event.target.value as RenderEngine | "all")} aria-label={t("renderEngine.galleryEngineFilter")} className="h-9 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg px-2 text-[12.5px]">
            <option value="all">{t("renderEngine.galleryAllEngines")}</option>
            {engines.map((item) => <option key={item} value={item}>{t(`templates.library.engineBadge.${item}`)}</option>)}
          </select>
          <div className="inline-flex overflow-hidden rounded-[var(--lyx-radius)] border border-lyx-border text-[12px]" role="group" aria-label={t("templatePicker.density")}>
            {([4, 5, 6] as const).map((value) => (
              <button key={value} type="button" aria-pressed={density === value} onClick={() => setDensity(value)} className={`px-2.5 py-1.5 ${density === value ? "bg-lyx-fg text-lyx-bg" : "text-lyx-fg-muted hover:bg-lyx-muted"}`}>{value}</button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-lyx-fg-muted">
          <span data-testid="template-ready-count">{t("templates.library.readyCount", { ready: readyCount.ready, total: readyCount.total })}</span>
          {readyCount.ready < readyCount.total ? (
            <button type="button" aria-pressed={readyOnly} onClick={() => setReadyOnly((value) => !value)} data-testid="template-ready-only" className={`rounded-full border px-2 py-0.5 ${readyOnly ? "border-lyx-fg bg-lyx-fg text-lyx-bg" : "border-lyx-border hover:bg-lyx-muted"}`}>
              {t("templates.library.readyOnly")}
            </button>
          ) : null}
        </div>
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <div className="w-max min-w-full"><CategoryChips filters={CATEGORY_FILTERS} value={category} counts={counts} onChange={setCategory} label={t("templates.library.categoryFilter")} /></div>
        </div>
        {visible.length === 0 ? <p className="text-[12px] text-lyx-fg-muted">{t("templatePicker.empty")}</p> : (
          <div className={`grid gap-2 ${DENSITY_COLUMNS[density]}`} data-testid="template-browser-grid">
            {visible.map((item) => {
              const ready = templateReadiness(item).ready;
              const isSelected = item.externalTemplateId === selectedId;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setFocusKey(item.key)}
                  onDoubleClick={() => { if (!choosing && templateChoice(item, selectedId).ok) onChoose(item); }}
                  aria-pressed={focused?.key === item.key}
                  title={item.name}
                  data-testid="template-mini-card"
                  data-selected={isSelected ? "true" : "false"}
                  data-ready={ready ? "true" : "false"}
                  className={`group relative overflow-hidden rounded-[8px] border bg-lyx-bg text-left transition ${focused?.key === item.key ? "border-lyx-fg ring-1 ring-lyx-fg" : "border-lyx-border hover:border-lyx-strong"}`}
                >
                  <div className="flex items-center justify-center overflow-hidden bg-lyx-muted text-[10px] text-lyx-fg-subtle" style={{ aspectRatio: "9 / 16" }}>
                    <TemplateThumb template={item} fallbackLabel={t("templates.previewNoImage")} />
                  </div>
                  {isSelected ? <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-lyx-fg text-lyx-bg" aria-label={t("templates.previewSelected")}><Check size={12} strokeWidth={3} aria-hidden="true" /></span> : null}
                  {!ready ? <span className="absolute inset-x-1 top-1 truncate rounded-[4px] bg-lyx-warn-bg px-1 py-0.5 text-center text-[9.5px] font-semibold text-lyx-warn" title={t("templates.library.notReadyBadge")} data-testid="template-mini-not-ready">{t("templates.library.notReadyShort")}</span> : null}
                  <div className="truncate px-1.5 py-1 text-[11px] font-medium">{item.name}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <aside className="flex flex-col gap-2 md:border-l md:border-lyx-border md:pl-4" aria-live="polite" data-testid="template-browser-detail">
        {focused ? (
          <>
            <div className="mx-auto w-full max-w-[180px] overflow-hidden rounded-[10px] border border-lyx-border bg-lyx-muted" style={{ aspectRatio: "9 / 16" }}>
              <TemplateThumb template={focused} fallbackLabel={t("templates.previewNoImage")} playing />
            </div>
            <div className="text-[13px] font-medium">{focused.name}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <EngineBadge engine={focused.engine} />
              <span className="text-[11px] text-lyx-fg-muted">{focusedCategory ? t(`templates.library.category.${focusedCategory}`) : t("templates.library.categoryNone")} · 9:16</span>
            </div>
            {templateLanguages(focused).length > 0 ? <div className="text-[11px] text-lyx-fg-muted">{templateLanguages(focused).map((code) => t(`templates.library.language.${code}`, { defaultValue: code })).join(", ")}</div> : null}
            {readiness && !readiness.ready ? <p className="rounded-[4px] bg-lyx-warn-bg px-2 py-1 text-[11.5px] text-lyx-warn" data-testid="template-detail-not-ready">{t("templates.library.notReadyWarning", { reason: t(`templates.library.blockReason.${readiness.reason}`) })}</p> : null}
            <div className="mt-auto flex flex-col gap-1.5 pt-2">
              <Button type="button" variant="secondary" onClick={() => setPreviewIndex(visible.findIndex((item) => item.key === focused.key))}><Eye size={14} aria-hidden="true" /> {t("templatePicker.fullPreview")}</Button>
              <Button
                type="button"
                disabled={choosing || !choice?.ok}
                onClick={() => { if (templateChoice(focused, selectedId).ok) onChoose(focused); }}
                title={choice && !choice.ok && choice.reason === "not_ready" ? t(`templates.library.blockReason.${choice.blockReason}`) : undefined}
                data-testid="template-browser-choose"
              >
                {choice && !choice.ok && choice.reason === "current" ? t("templates.current") : choice && !choice.ok ? t("templates.library.notReadyBadge") : chooseLabel}
              </Button>
            </div>
          </>
        ) : <p className="text-[12px] text-lyx-fg-muted">{t("templatePicker.empty")}</p>}
      </aside>

      {previewIndex !== null && visible[previewIndex] ? (
        <TemplatePreviewModal
          templates={visible}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          selectedId={selectedId}
          selecting={choosing}
          selectLabel={chooseLabel}
          onSelect={(template) => { setPreviewIndex(null); onChoose(template as LibraryTemplate); }}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
    </div>
  );
}
