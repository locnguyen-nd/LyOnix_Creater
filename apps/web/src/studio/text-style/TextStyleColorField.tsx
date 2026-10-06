import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeHexColor } from "@lyonix/domain/caption-style";

/**
 * VE2E-93: colour = quick swatches + the native picker + a HEX text field (the colour is never conveyed by the swatch alone). The picker
 * previews while it moves and commits once when it closes (native `change`); swatches and a valid HEX (Enter/blur) commit directly.
 */
export function TextStyleColorField({
  id,
  label,
  value,
  swatches,
  onPreview,
  onRelease,
  onCommit,
}: {
  id: string;
  label: string;
  /** `#RRGGBB`. */
  value: string;
  swatches: readonly string[];
  onPreview: (value: string) => void;
  onRelease: () => void;
  onCommit: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState<string | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const releaseRef = useRef(onRelease);
  releaseRef.current = onRelease;

  // React's onChange on <input type="color"> fires on every move; the native `change` event fires once, when the picker closes.
  useEffect(() => {
    const picker = pickerRef.current;
    if (!picker) return;
    const handle = () => releaseRef.current();
    picker.addEventListener("change", handle);
    return () => picker.removeEventListener("change", handle);
  }, []);

  const invalid = typed !== null && normalizeHexColor(typed) === null;
  const submitTyped = () => {
    if (typed === null) return;
    const hex = normalizeHexColor(typed);
    if (!hex) return;
    onCommit(hex.toUpperCase());
    setTyped(null);
  };
  const current = normalizeHexColor(value)?.toLowerCase() ?? "#ffffff";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {swatches.map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={`${label}: ${hex}`}
            aria-pressed={current === hex.toLowerCase()}
            onClick={() => onCommit(hex)}
            className={`h-[22px] w-[22px] shrink-0 rounded-[4px] border ${current === hex.toLowerCase() ? "border-lyx-fg ring-1 ring-lyx-fg" : "border-lyx-border"}`}
            style={{ backgroundColor: hex }}
          />
        ))}
        <input
          ref={pickerRef}
          type="color"
          aria-label={`${label}: ${t("studioPro.textStyleColorPicker")}`}
          value={current}
          onChange={(event) => onPreview(event.target.value.toUpperCase())}
          onBlur={onRelease}
          className="h-[24px] w-[28px] shrink-0 cursor-pointer rounded-[4px] border border-lyx-border bg-transparent p-0"
        />
        <input
          id={id}
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label={`${label}: ${t("studioPro.textStyleColorHex")}`}
          aria-invalid={invalid}
          maxLength={7}
          value={typed ?? value.toUpperCase()}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={submitTyped}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitTyped();
            if (event.key === "Escape") setTyped(null);
          }}
          className={`h-7 min-w-[72px] flex-1 rounded-[4px] border bg-lyx-muted px-1.5 font-mono text-[11px] uppercase text-lyx-fg ${invalid ? "border-lyx-danger" : "border-lyx-border"}`}
        />
      </div>
      {invalid ? <p role="alert" className="text-[10px] text-lyx-danger">{t("studioPro.textStyleColorInvalid")}</p> : null}
    </div>
  );
}
