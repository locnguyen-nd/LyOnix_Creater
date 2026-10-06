import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Search, SearchX, X } from "lucide-react";

/**
 * V04-02: search box of the template library. Pure UI state: filtering happens client-side on the already loaded list (no request
 * per keystroke) and never touches the selected template, the render account, the draft or the user's defaults. Esc clears it.
 */
export function TemplateSearch({ value, onChange, summary }: { value: string; onChange: (value: string) => void; summary?: string | null }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="sr-only">{t("templates.search.label")}</label>
      <div className="relative w-full">
        <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lyx-fg-subtle" />
        <input
          id={id}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && value) { event.preventDefault(); onChange(""); } }}
          placeholder={t("templates.search.placeholder")}
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full rounded-[8px] border border-lyx-border bg-lyx-bg pl-9 pr-9 text-[13px] text-lyx-fg placeholder:text-lyx-fg-subtle outline-none transition hover:border-lyx-strong focus:border-lyx-fg focus:ring-2 focus:ring-lyx-fg/15 [&::-webkit-search-cancel-button]:appearance-none"
          data-testid="template-search"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label={t("templates.search.clear")}
            title={t("templates.search.clear")}
            className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-lyx-fg-subtle transition hover:bg-lyx-muted hover:text-lyx-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lyx-fg/30"
            data-testid="template-search-clear"
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {summary ? <p className="text-[11.5px] text-lyx-fg-muted" role="status" aria-live="polite" data-testid="template-search-summary">{summary}</p> : null}
    </div>
  );
}

/** Nothing matches the search (and / or the group filter): say so and offer the way back, never a blank area. */
export function TemplateSearchEmpty({ onClearSearch, onClearAll }: { onClearSearch: () => void; onClearAll?: (() => void) | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 rounded-[10px] border border-dashed border-lyx-border px-4 py-8 text-center" data-testid="template-search-empty">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-lyx-muted text-lyx-fg-muted">
        <SearchX size={18} aria-hidden="true" />
      </span>
      <p className="text-[13px] font-semibold">{t("templates.search.emptyTitle")}</p>
      <p className="max-w-[320px] text-[12px] text-lyx-fg-muted">{t("templates.search.emptyHint")}</p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <button type="button" className="lyx-btn lyx-btn-secondary" onClick={onClearSearch} data-testid="template-search-empty-clear">{t("templates.search.clearSearch")}</button>
        {onClearAll ? <button type="button" className="lyx-btn lyx-btn-ghost" onClick={onClearAll} data-testid="template-search-empty-clear-all">{t("templates.search.clearAll")}</button> : null}
      </div>
    </div>
  );
}
