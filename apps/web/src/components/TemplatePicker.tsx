import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { templateCategory, templateLanguages, templateReadiness, uniqueTemplates, type LibraryTemplate } from "../studio/template-catalog";
import { EngineBadge, TemplateThumb } from "./TemplatePreviewModal";
import { TemplateBrowser } from "./TemplateBrowser";
import { Button } from "./ui";

/**
 * Compact template picker: one row for the template in use (thumbnail, name, engine, readiness) with "Xem trước" and "Đổi template".
 * The full library lives in a right-hand drawer (search, filters, dense grid, details) so the form keeps its space.
 */
export function TemplatePicker({ templates, selectedId, onChoose, onPreviewSelected }: {
  templates: readonly LibraryTemplate[];
  selectedId: string | null;
  onChoose: (template: LibraryTemplate) => void;
  /** Opens the 9:16 preview of the template in use. */
  onPreviewSelected?: (template: LibraryTemplate) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const all = useMemo(() => uniqueTemplates(templates), [templates]);
  const selected = selectedId ? all.find((item) => item.externalTemplateId === selectedId) ?? null : null;
  const readiness = selected ? templateReadiness(selected) : null;
  const category = selected ? templateCategory(selected) : null;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-2" data-testid="template-picker-chip">
        <div className="flex h-[60px] w-[34px] flex-none items-center justify-center overflow-hidden rounded-[6px] bg-lyx-muted text-[9px] text-lyx-fg-subtle">
          {selected ? <TemplateThumb template={selected} fallbackLabel="" /> : null}
        </div>
        <div className="min-w-[160px] flex-1">
          {selected ? (
            <>
              <div className="truncate text-[13px] font-medium" title={selected.name}>{selected.name}</div>
              <div className="truncate text-[11px] text-lyx-fg-muted">{category ? t(`templates.library.category.${category}`) : t("templates.library.categoryNone")} · 9:16{templateLanguages(selected).length > 0 ? ` · ${templateLanguages(selected).join("/")}` : ""}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <EngineBadge engine={selected.engine} />
                {readiness && !readiness.ready ? <span className="rounded-[4px] bg-lyx-warn-bg px-1.5 py-0.5 text-[10.5px] font-semibold text-lyx-warn" data-testid="template-not-ready">{t("templates.library.notReadyBadge")}</span> : null}
              </div>
            </>
          ) : <div className="text-[12.5px] text-lyx-fg-muted">{t("templatePicker.none")}</div>}
        </div>
        {/* narrow screens: the two actions move under the template instead of squeezing it */}
        <div className="flex shrink-0 items-center justify-end gap-2 max-sm:w-full">
          {selected && onPreviewSelected ? <Button type="button" variant="ghost" onClick={() => onPreviewSelected(selected)}>{t("templates.previewOpen")}</Button> : null}
          <Button type="button" variant="secondary" onClick={() => setOpen(true)} data-testid="template-picker-open">{selected ? t("templatePicker.change") : t("templatePicker.choose")}</Button>
        </div>
      </div>

      {open ? (
        <div className="lyx-anim-backdrop fixed inset-0 z-50 flex justify-end bg-[var(--lyx-overlay)]" role="presentation" onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label={t("templatePicker.title")} onClick={(event) => event.stopPropagation()} className="lyx-anim-drawer flex h-full w-full max-w-[920px] flex-col bg-lyx-bg shadow-xl" data-testid="template-picker-drawer">
            <div className="flex items-center justify-between border-b border-lyx-border px-4 py-3">
              <h2 className="text-[15px] font-semibold">{t("templatePicker.title")} <span className="text-[12px] font-normal text-lyx-fg-muted">· {t("templates.matchCount", { count: all.length })}</span></h2>
              <button type="button" onClick={() => setOpen(false)} aria-label={t("templatePicker.close")} className="rounded p-1 hover:bg-lyx-muted"><X size={18} aria-hidden="true" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <TemplateBrowser templates={all} selectedId={selectedId} chooseLabel={t("templatePicker.use")} onChoose={(template) => { setOpen(false); onChoose(template); }} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
