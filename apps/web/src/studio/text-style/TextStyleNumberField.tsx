import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * VE2E-93: slider + numeric input with a visible range. Dragging the slider only previews (`onPreview`); the value is written once on
 * release (`onRelease`: pointer up, key up, blur). The numeric input commits on Enter/blur when the number is a whole number in range.
 */
export function TextStyleNumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  onPreview,
  onRelease,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onPreview: (value: number) => void;
  onRelease: () => void;
  onCommit: (value: number) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState<string | null>(null);
  const invalid = typed !== null && !isValid(typed, min, max);
  const submitTyped = () => {
    if (typed === null) return;
    if (!isValid(typed, min, max)) return;
    onCommit(Number(typed));
    setTyped(null);
  };
  const clamped = Math.min(max, Math.max(min, value));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={clamped}
          aria-valuetext={`${clamped} ${t("studioPro.textStyleUnitPx")}`}
          onChange={(event) => onPreview(Number(event.target.value))}
          onPointerUp={onRelease}
          onKeyUp={onRelease}
          onBlur={onRelease}
          className="min-w-0 flex-1"
        />
        <input
          type="number"
          inputMode="numeric"
          aria-label={label}
          aria-invalid={invalid}
          min={min}
          max={max}
          step={step}
          value={typed ?? String(value)}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={submitTyped}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitTyped();
            if (event.key === "Escape") setTyped(null);
          }}
          className={`h-7 w-14 rounded-[4px] border bg-lyx-muted px-1 text-right text-[11px] text-lyx-fg ${invalid ? "border-lyx-danger" : "border-lyx-border"}`}
        />
        <span className="text-[10px] text-lyx-fg-muted">{t("studioPro.textStyleUnitPx")}</span>
      </div>
      {invalid ? <p role="alert" className="text-[10px] text-lyx-danger">{t("studioPro.textStyleNumberInvalid", { min, max })}</p> : null}
    </div>
  );
}

const isValid = (text: string, min: number, max: number): boolean => {
  if (!/^\d+$/.test(text.trim())) return false;
  const value = Number(text);
  return value >= min && value <= max;
};
