import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CAPTION_PRESETS, captionPresetById, captionPresetSupport, type CaptionPreset } from "@lyonix/domain/caption-presets";
import type { CaptionStyleEngine } from "@lyonix/domain/caption-style-capabilities";
import type { CaptionTemplateDefaults } from "@lyonix/domain/caption-style";
import { CAPTION_REASON_KEY, CaptionPresetCompatibility, CaptionPresetSwatch, CaptionStyleSample, captionPresetStyle } from "../studio/text-style/CaptionPresetViews";

/**
 * VE2E-94 / VE2E-96: "Caption style" of the create-video panel - the template's own style or one of the shared caption presets, as a
 * compact chip grid next to ONE 9:16 preview. Hover / focus previews a style, click chooses it. Previews are drawn locally by the VE2E-93
 * caption preview (no render, provider, AI or TTS call). A preset the chosen template's engine cannot draw is disabled with the reason;
 * with no template chosen yet every preset can be picked and is checked again before the run starts.
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
  const [hoverId, setHoverId] = useState<string | null>(null);
  const shownId = hoverId ?? selectedId;
  const shown = shownId ? captionPresetById(shownId) : null;
  const reasonFor = (item: CaptionPreset | null): string | null => {
    if (!item || !engine) return null;
    const support = captionPresetSupport(engine, item);
    return support.ok ? null : t(CAPTION_REASON_KEY[support.reason]);
  };
  const nameOf = (item: CaptionPreset | null) => (item ? t(item.nameKey) : t("captionPresets.templateDefault"));
  const descriptionOf = (item: CaptionPreset | null) => (item ? t(item.descriptionKey) : t("captionPresets.templateDefaultDescription"));
  const options: Array<CaptionPreset | null> = [null, ...CAPTION_PRESETS];
  const shownReason = reasonFor(shown);

  return (
    <div className="flex flex-col gap-2" data-testid="caption-preset-picker">
      <p className="text-[11.5px] text-lyx-fg-muted">{engine ? t("captionPresets.previewHint") : t("captionPresets.pickTemplateFirst")}</p>
      <div className="flex gap-2.5">
        <div className="w-[78px] flex-none" data-testid="caption-preset-preview" data-preset={shownId || "template"}>
          <CaptionStyleSample style={captionPresetStyle(shown, engine, defaults)} engine={engine} />
        </div>
        <div role="radiogroup" aria-label={t("captionPresets.title")} className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start gap-1.5" onMouseLeave={() => setHoverId(null)}>
          {options.map((item) => {
            const id = item?.id ?? "";
            const selected = selectedId === id;
            const reason = reasonFor(item);
            const name = nameOf(item);
            return (
              <button
                key={id || "template"}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={Boolean(reason)}
                title={reason ? `${name}: ${reason}` : descriptionOf(item)}
                className={`flex min-w-0 items-center gap-1.5 rounded-[6px] border p-1 text-left transition-colors ${selected ? "border-lyx-fg ring-1 ring-lyx-fg" : "border-lyx-border hover:border-lyx-fg-subtle"} ${reason ? "cursor-not-allowed opacity-50" : ""}`}
                data-testid="caption-preset-card"
                data-preset={id || "template"}
                onMouseEnter={() => setHoverId(id)}
                onFocus={() => setHoverId(id)}
                onBlur={() => setHoverId(null)}
                onClick={() => { if (!reason) onChoose(id); }}
              >
                <span className="w-[40px] flex-none"><CaptionPresetSwatch style={captionPresetStyle(item, engine, defaults)} /></span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">{name}</span>
                {reason ? <span className="sr-only">{reason}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex min-h-[3.25em] flex-col gap-1 text-[11px] leading-4 text-lyx-fg-muted" aria-live="polite" data-testid="caption-preset-details">
        <p><span className="font-semibold text-lyx-fg">{nameOf(shown)}</span> · {descriptionOf(shown)}</p>
        {shown ? <CaptionPresetCompatibility item={shown} /> : null}
        {shownReason ? <p className="text-lyx-fg-subtle">{shownReason}</p> : null}
      </div>
    </div>
  );
}
