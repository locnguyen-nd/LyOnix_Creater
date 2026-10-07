import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CAPTION_PRESETS, captionPresetById, captionPresetSupport, type CaptionPreset } from "@lyonix/domain/caption-presets";
import type { CaptionStyleEngine } from "@lyonix/domain/caption-style-capabilities";
import type { CaptionTemplateDefaults } from "@lyonix/domain/caption-style";
import { CAPTION_REASON_KEY, CaptionPresetCompatibility, CaptionStyleSample, captionPresetStyle } from "../studio/text-style/CaptionPresetViews";
import { Button } from "./ui";
import { Modal } from "./Modal";

/**
 * VE2E-94: "Caption style" of the Auto create-video form - the template's own style or one of the shared caption presets. Previews are
 * drawn locally by the VE2E-93 caption preview (no render, provider, AI or TTS call). A preset the chosen template's engine cannot draw is
 * disabled with the reason; with no template chosen yet every preset can be picked and is checked again before the run starts.
 */
export function CaptionPresetPicker({
  selectedId,
  engine,
  defaults,
  onChoose,
}: {
  /** "" = the template's own caption style. */
  selectedId: string;
  /** Engine of the chosen template + render account; null while no template is chosen. */
  engine: CaptionStyleEngine | null;
  /** The chosen template's caption defaults when known (LyOnix recipes); null = system defaults. */
  defaults: CaptionTemplateDefaults | null;
  onChoose: (presetId: string) => void;
}) {
  const { t } = useTranslation();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewItem = previewId === "" ? null : captionPresetById(previewId);
  const reasonFor = (item: CaptionPreset | null): string | null => {
    if (!item || !engine) return null;
    const support = captionPresetSupport(engine, item);
    return support.ok ? null : t(CAPTION_REASON_KEY[support.reason]);
  };
  const options: Array<CaptionPreset | null> = [null, ...CAPTION_PRESETS];

  return (
    <div className="flex flex-col gap-2" data-testid="caption-preset-picker">
      <p className="text-[12px] text-lyx-fg-muted">{engine ? t("captionPresets.hint") : t("captionPresets.pickTemplateFirst")}</p>
      <div role="radiogroup" aria-label={t("captionPresets.title")} className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        {options.map((item) => {
          const id = item?.id ?? "";
          const selected = selectedId === id;
          const reason = reasonFor(item);
          const name = item ? t(item.nameKey) : t("captionPresets.templateDefault");
          return (
            <div
              key={id || "template"}
              role="radio"
              aria-checked={selected}
              aria-disabled={Boolean(reason)}
              className={`flex min-w-0 flex-col gap-1.5 rounded-[var(--lyx-radius)] border p-1.5 ${selected ? "border-lyx-fg ring-1 ring-lyx-fg" : "border-lyx-border"} ${reason ? "opacity-60" : ""}`}
              data-testid="caption-preset-card"
              data-preset={id || "template"}
            >
              <CaptionStyleSample style={captionPresetStyle(item, engine, defaults)} engine={engine} />
              <p className="truncate text-[12px] font-semibold">{name}</p>
              <p className="line-clamp-2 min-h-[2.5em] text-[10.5px] leading-[1.25em] text-lyx-fg-muted">{item ? t(item.descriptionKey) : t("captionPresets.templateDefaultDescription")}</p>
              {item ? <CaptionPresetCompatibility item={item} /> : null}
              {reason ? <p className="text-[10px] leading-4 text-lyx-fg-subtle">{reason}</p> : null}
              <div className="mt-auto flex gap-1">
                <Button variant="ghost" className="h-7 flex-1 px-1 text-[11px]" onClick={() => setPreviewId(id)}>{t("captionPresets.preview")}</Button>
                <Button
                  variant={selected ? "secondary" : "primary"}
                  className="h-7 flex-1 px-1 text-[11px]"
                  disabled={selected || Boolean(reason)}
                  title={reason ?? undefined}
                  onClick={() => onChoose(id)}
                >
                  {selected ? t("captionPresets.selected") : t("captionPresets.choose")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {previewId !== null ? (
        <Modal title={previewItem ? t(previewItem.nameKey) : t("captionPresets.templateDefault")} onClose={() => setPreviewId(null)}>
          <div className="flex flex-col items-center gap-3" data-testid="caption-preset-modal">
            <CaptionStyleSample style={captionPresetStyle(previewItem, engine, defaults)} engine={engine} className="w-[220px] max-w-full" />
            <p className="text-center text-[12.5px] text-lyx-fg-muted">{previewItem ? t(previewItem.descriptionKey) : t("captionPresets.templateDefaultDescription")}</p>
            {previewItem ? <CaptionPresetCompatibility item={previewItem} /> : null}
            {reasonFor(previewItem) ? <p className="text-center text-[11px] text-lyx-fg-subtle">{reasonFor(previewItem)}</p> : null}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setPreviewId(null)}>{t("captionPresets.close")}</Button>
              <Button
                disabled={selectedId === previewId || Boolean(reasonFor(previewItem))}
                onClick={() => {
                  onChoose(previewId);
                  setPreviewId(null);
                }}
              >
                {selectedId === previewId ? t("captionPresets.selected") : t("captionPresets.choose")}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
