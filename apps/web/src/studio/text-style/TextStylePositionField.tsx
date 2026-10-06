import { useTranslation } from "react-i18next";
import { CAPTION_POSITION_PRESETS, type CaptionPositionPreset } from "@lyonix/domain/caption-style";
import { TextStyleChoiceField } from "./TextStyleFieldRow";

const LABEL_KEY: Record<CaptionPositionPreset, string> = {
  top: "studioPro.textStylePositionTop",
  middle: "studioPro.textStylePositionMiddle",
  bottom: "studioPro.textStylePositionBottom",
};

/** VE2E-93: top / middle / bottom presets (normalised positions inside the safe zone - never DOM pixels). */
export function TextStylePositionField({ label, value, onCommit }: { label: string; value: CaptionPositionPreset | null; onCommit: (value: CaptionPositionPreset) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <TextStyleChoiceField label={label} value={value} options={CAPTION_POSITION_PRESETS.map((preset) => ({ value: preset, label: t(LABEL_KEY[preset]) }))} onChange={onCommit} />
      {value === null ? <p className="text-[10px] text-lyx-fg-subtle">{t("studioPro.textStylePositionTemplate")}</p> : null}
    </div>
  );
}
