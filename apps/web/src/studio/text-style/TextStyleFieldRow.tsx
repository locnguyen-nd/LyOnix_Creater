import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * VE2E-93: one row of the text style panel - label, "customised / inherited" badge, a per-field reset and, when the engine does not
 * apply the field, the reason (shown as text and as the tooltip; the controls are disabled through the fieldset).
 */
export function TextStyleFieldRow({
  label,
  labelFor,
  customized,
  disabledReason,
  onReset,
  children,
  hint,
}: {
  label: string;
  /** id of the main input, so the label is clickable and announced. */
  labelFor?: string;
  customized: boolean;
  disabledReason?: string | null;
  onReset?: () => void;
  children: ReactNode;
  hint?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-1" title={disabledReason ?? undefined} data-testid="text-style-field">
      <div className="flex items-center justify-between gap-2">
        {labelFor ? (
          <label htmlFor={labelFor} className="text-[10px] font-medium text-lyx-fg-muted">{label}</label>
        ) : (
          <span className="text-[10px] font-medium text-lyx-fg-muted">{label}</span>
        )}
        <span className="flex shrink-0 items-center gap-1">
          <span className={`rounded-full px-1.5 py-px text-[9px] ${customized ? "bg-lyx-fg text-lyx-bg" : "bg-lyx-muted text-lyx-fg-subtle"}`}>
            {customized ? t("studioPro.textStyleCustomized") : t("studioPro.textStyleInherited")}
          </span>
          {customized && onReset && !disabledReason ? (
            <button type="button" className="h-5 w-5 rounded text-[11px] text-lyx-fg-muted hover:text-lyx-fg" aria-label={t("studioPro.textStyleResetField", { field: label })} title={t("studioPro.textStyleResetField", { field: label })} onClick={onReset}>
              ↺
            </button>
          ) : null}
        </span>
      </div>
      <fieldset disabled={Boolean(disabledReason)} className="m-0 min-w-0 border-0 p-0 disabled:opacity-50">
        {children}
      </fieldset>
      {disabledReason ? <p className="text-[10px] leading-4 text-lyx-fg-subtle">{disabledReason}</p> : hint ? <p className="text-[10px] leading-4 text-lyx-fg-subtle">{hint}</p> : null}
    </div>
  );
}

/** Segmented single choice (position, lines, animation) as an accessible radio group of buttons. */
export function TextStyleChoiceField<V extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V | null;
  options: ReadonlyArray<{ value: V; label: string; disabled?: boolean }>;
  onChange: (value: V) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={`h-7 min-w-0 flex-1 rounded-[5px] border px-2 text-[11px] disabled:opacity-40 ${value === option.value ? "border-lyx-fg bg-lyx-fg text-lyx-bg" : "border-lyx-border text-lyx-fg"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
