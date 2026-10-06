import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Eye } from "lucide-react";
import { EngineBadge, TemplateThumb } from "./TemplatePreviewModal";
import { templateCategory, templateReadiness } from "../studio/template-catalog";
import type { PreviewableTemplate } from "../studio/template-preview";

/**
 * V04-01: one template of the library. The whole card opens the 9:16 preview - it never selects (only "Chọn template này" in the
 * preview does). Picture (a LyOnix template moves while hovered), name, group · 9:16, engine badge; "Chưa sẵn sàng render" when it
 * cannot be applied; a clear border + check mark when it is the template in use. "Xem trước" shows on hover / focus with a pointer,
 * always on touch screens.
 */
export function TemplateCard({ template, selected, onPreview }: { template: PreviewableTemplate; selected: boolean; onPreview: () => void }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const category = templateCategory(template);
  const readiness = templateReadiness(template);
  return (
    <div
      className={`group relative overflow-hidden rounded-[8px] border bg-lyx-bg transition ${selected ? "border-lyx-fg ring-2 ring-lyx-fg" : "border-lyx-border hover:border-lyx-strong"}`}
      data-testid="template-card"
      data-engine={template.engine}
      data-selected={selected ? "true" : "false"}
    >
      <button
        type="button"
        onClick={onPreview}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        aria-label={`${t("templates.previewOpen")}: ${template.name}`}
        className="relative block w-full text-left"
      >
        <div className="flex items-center justify-center overflow-hidden bg-lyx-muted text-[11px] text-lyx-fg-subtle" style={{ aspectRatio: "9 / 16" }}>
          <TemplateThumb template={template} fallbackLabel={t("templates.previewNoImage")} playing={hovered} />
        </div>
        {!readiness.ready ? (
          <span className="absolute left-1.5 top-1.5 max-w-[calc(100%-2.5rem)] rounded-[4px] bg-lyx-warn-bg px-1.5 py-0.5 text-[10px] font-semibold leading-tight text-lyx-warn shadow-sm" data-testid="template-not-ready">
            {t("templates.library.notReadyBadge")}
          </span>
        ) : null}
        {selected ? (
          <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-lyx-fg text-lyx-bg shadow" data-testid="template-card-check" aria-label={t("templates.previewSelected")}>
            <Check size={14} strokeWidth={3} aria-hidden="true" />
          </span>
        ) : null}
        <span className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 group-focus-within:opacity-100">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1.5 text-[12px] font-semibold text-white shadow-lg">
            <Eye size={14} aria-hidden="true" /> {t("templates.previewOpen")}
          </span>
        </span>
      </button>
      <div className="flex flex-col gap-1 p-2">
        <div className="truncate text-[12px] font-medium" title={template.name}>{template.name}</div>
        <div className="text-[11px] text-lyx-fg-muted">{category ? t(`templates.library.category.${category}`) : t("templates.library.categoryNone")} · 9:16</div>
        <EngineBadge engine={template.engine} />
      </div>
    </div>
  );
}

/** Group filter chips (Tất cả / Tin tức / Thể thao / Faceless / Breaking News) with counts. Only changes what is listed. */
export function CategoryChips<T extends string>({ filters, value, counts, onChange, label }: { filters: readonly T[]; value: T; counts: Record<T, number>; onChange: (value: T) => void; label: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label} data-testid="template-category-filter">
      {filters.map((filter) => (
        <button
          key={filter}
          type="button"
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
          className={`rounded-full border px-3 py-1 text-[12px] transition ${value === filter ? "border-lyx-fg bg-lyx-fg font-semibold text-lyx-bg" : "border-lyx-border text-lyx-fg-muted hover:border-lyx-strong hover:text-lyx-fg"}`}
        >
          {t(`templates.library.category.${filter}`)} <span className="opacity-70">{counts[filter] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
