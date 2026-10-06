import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Eye } from "lucide-react";
import { TemplateThumb } from "./TemplatePreviewModal";
import { ProviderBadge, ProviderMark } from "./ProviderBadge";
import { templateCategory, templateReadiness } from "../studio/template-catalog";
import type { PreviewableTemplate } from "../studio/template-preview";

/**
 * V04-01 / V04-02: one template of the library. The whole card is ONE button that opens the 9:16 preview - it never selects (only
 * "Chọn template này" in the preview does). Picture (provider image, LyOnix simulation moving while hovered / focused, or a styled
 * fallback) with the provider mark in its corner; name, group · 9:16, provider badge and "Chưa sẵn sàng render" below the picture so
 * nothing covers it; a clear ring + check mark when it is the template in use. "Xem trước" shows on hover / focus with a pointer,
 * always on touch screens. Keyboard: Tab to the card, Enter / Space opens the preview.
 */
export function TemplateCard({ template, selected, onPreview }: { template: PreviewableTemplate; selected: boolean; onPreview: () => void }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const category = templateCategory(template);
  const readiness = templateReadiness(template);
  const providerName = t(`templates.library.engineBadge.${template.engine}`);
  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-[10px] border bg-lyx-bg transition duration-150 ${selected ? "border-lyx-fg ring-2 ring-lyx-fg" : "border-lyx-border hover:-translate-y-0.5 hover:border-lyx-strong hover:shadow-md"}`}
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
        aria-label={`${t("templates.previewOpen")}: ${template.name} · ${providerName}`}
        className="relative block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-lyx-fg"
      >
        <div className="relative overflow-hidden bg-lyx-muted" style={{ aspectRatio: "9 / 16" }}>
          <div className="h-full w-full transition-transform duration-300 group-hover:scale-[1.03]">
            <TemplateThumb template={template} playing={hovered} />
          </div>
          <span className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/35 to-transparent" aria-hidden="true" />
        </div>
        <span className="absolute left-1.5 top-1.5 rounded-[5px] shadow-sm" title={providerName} data-testid="template-card-provider-mark">
          <ProviderMark engine={template.engine} size={20} />
        </span>
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
      <div className="flex flex-1 flex-col gap-1 p-2.5">
        <div className="line-clamp-2 text-[12.5px] font-semibold leading-snug [overflow-wrap:anywhere]" title={template.name}>{template.name}</div>
        <div className="text-[11px] text-lyx-fg-muted">{category ? t(`templates.library.category.${category}`) : t("templates.library.categoryNone")} · 9:16</div>
        <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
          <ProviderBadge engine={template.engine} />
          {!readiness.ready ? (
            <span className="inline-flex items-center rounded-[4px] bg-lyx-warn-bg px-1.5 py-0.5 text-[10px] font-semibold leading-tight text-lyx-warn" data-testid="template-not-ready">
              {t("templates.library.notReadyBadge")}
            </span>
          ) : null}
        </div>
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
