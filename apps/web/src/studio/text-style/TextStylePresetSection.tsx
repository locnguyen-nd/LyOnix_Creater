import { useTranslation } from "react-i18next";
import { CAPTION_PRESETS, captionPresetSupport, type CaptionPreset } from "@lyonix/domain/caption-presets";
import { Button } from "../../components/ui";
import { captionPresetEdit, captionPresetStatus, type CaptionStyleEdit, type StudioCaptionContext } from "./caption-style-model";
import { CAPTION_REASON_KEY, CaptionPresetSwatch, captionPresetStyle } from "./CaptionPresetViews";

/**
 * VE2E-94: "Ready-made styles" in the Studio text style panel (whole video only). Hover/focus previews a preset on the scene preview
 * (nothing saved); a click applies it to the whole-video style as ONE undoable change. Scene overrides are never touched, and a later
 * manual edit only marks the style "customised" - nothing is reset.
 */
export function TextStylePresetSection({
  ctx,
  onPreview,
  onCancel,
  onCommit,
}: {
  ctx: StudioCaptionContext;
  onPreview: (edit: CaptionStyleEdit) => void;
  onCancel: () => void;
  onCommit: (edit: CaptionStyleEdit) => void;
}) {
  const { t } = useTranslation();
  const engine = ctx.engine ?? "lyonix";
  const status = captionPresetStatus(ctx);
  const name = (item: CaptionPreset) => t(item.nameKey);
  const statusText =
    status.kind === "preset" ? t("captionPresets.statusPreset", { name: name(status.preset) })
    : status.kind === "custom" ? (status.basedOn ? t("captionPresets.statusCustomFrom", { name: name(status.basedOn) }) : t("captionPresets.statusCustom"))
    : t("captionPresets.statusTemplate");

  return (
    <div className="flex flex-col gap-1.5" data-testid="text-style-presets">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium text-lyx-fg-muted">{t("captionPresets.studioTitle")}</span>
        <span className="text-[10px] text-lyx-fg" data-testid="caption-preset-status" data-status={status.kind}>{statusText}</span>
      </div>
      {status.kind === "custom" && status.basedOn && captionPresetSupport(engine, status.basedOn).ok ? (
        <Button variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => onCommit(captionPresetEdit(status.basedOn!))}>
          {t("captionPresets.restore", { name: name(status.basedOn) })}
        </Button>
      ) : null}
      <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t("captionPresets.studioTitle")}>
        {CAPTION_PRESETS.map((item) => {
          const support = captionPresetSupport(engine, item);
          const selected = status.kind === "preset" && status.preset.id === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              disabled={!support.ok}
              title={support.ok ? t(item.descriptionKey) : t(CAPTION_REASON_KEY[support.reason])}
              onMouseEnter={() => support.ok && onPreview(captionPresetEdit(item))}
              onFocus={() => support.ok && onPreview(captionPresetEdit(item))}
              onMouseLeave={onCancel}
              onBlur={onCancel}
              onClick={() => onCommit(captionPresetEdit(item))}
              className={`flex min-w-0 flex-col gap-1 rounded-[6px] border p-1 text-left disabled:cursor-not-allowed disabled:opacity-40 ${selected ? "border-lyx-fg ring-1 ring-lyx-fg" : "border-lyx-border"}`}
              data-testid="caption-preset-option"
              data-preset={item.id}
            >
              <CaptionPresetSwatch style={captionPresetStyle(item, ctx.engine, ctx.defaults)} />
              <span className="truncate text-[10.5px] font-medium">{name(item)}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[10px] leading-4 text-lyx-fg-subtle">{t("captionPresets.studioHint")}</p>
    </div>
  );
}
