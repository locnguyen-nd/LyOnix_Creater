import { useTranslation } from "react-i18next";
import { CAPTION_FONTS } from "@lyonix/domain/caption-fonts";
import type { CaptionTextStyle } from "@lyonix/domain/caption-style";
import { Select } from "../../components/ui";

const LEGACY_VALUE = "__legacy";

/**
 * VE2E-93: only fonts of the verified catalog are offered (the same typeface on the preview and every engine). A font saved by an
 * earlier version (VE2E-26 free text) stays visible as the current value, marked as such - it is never silently swapped.
 */
export function TextStyleFontField({
  id,
  label,
  style,
  inheritLabel,
  customized,
  onCommit,
}: {
  id: string;
  label: string;
  /** Effective style of the scope being edited. */
  style: CaptionTextStyle;
  /** Label of the "inherit" option (template default for the whole video, whole-video font for a scene). */
  inheritLabel: string;
  /** The scope itself sets the font (otherwise the "inherit" option is selected). */
  customized: boolean;
  /** `undefined` = inherit. */
  onCommit: (fontId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const legacy = customized && style.font.source === "legacy";
  const value = legacy ? LEGACY_VALUE : customized && style.font.source === "catalog" && style.font.id ? style.font.id : "";
  return (
    <Select id={id} aria-label={label} className="h-8 w-full text-[12px]" value={value} onChange={(event) => onCommit(event.target.value === "" ? undefined : event.target.value)}>
      <option value="">{inheritLabel}</option>
      {CAPTION_FONTS.map((font) => (
        <option key={font.id} value={font.id} style={{ fontFamily: font.css }}>
          {font.label}
        </option>
      ))}
      {legacy ? (
        <option value={LEGACY_VALUE} disabled>
          {t("studioPro.textStyleFontLegacy", { font: style.font.family })}
        </option>
      ) : null}
    </Select>
  );
}
