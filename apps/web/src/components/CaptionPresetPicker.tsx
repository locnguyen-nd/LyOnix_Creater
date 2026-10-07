import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Check, Lock, Maximize2, Sparkles } from "lucide-react";
import { CAPTION_PRESETS, captionPresetById, captionPresetSupport, type CaptionPreset } from "@lyonix/domain/caption-presets";
import type { CaptionStyleEngine } from "@lyonix/domain/caption-style-capabilities";
import type { CaptionTemplateDefaults, CaptionTextStyle } from "@lyonix/domain/caption-style";
import { captionFontById } from "@lyonix/domain/caption-fonts";
import { CAPTION_REASON_KEY, CaptionPresetCompatibility, CaptionStyleSample, captionPresetStyle } from "../studio/text-style/CaptionPresetViews";
import { CaptionMotionPreview } from "../studio/text-style/CaptionMotionPreview";
import { captionCssFont } from "../studio/text-style/CaptionPreview";
import { captionPresetSamples, captionPresetTheme } from "../studio/text-style/caption-preset-theme";
import { Button } from "./ui";
import { Modal } from "./Modal";

/**
 * VE2E-94 / VE2E-96: "Caption style" of the create-video form - the template's own style or one of the shared caption presets, shown as
 * a preset gallery: a live 9:16 stage (the hovered / chosen style, in motion) next to one card per preset (its own preview, name, font,
 * colours, position, the engines that draw it). Hover / focus previews, click chooses. Everything is drawn locally by the VE2E-93 caption
 * preview (no render, provider, AI or TTS call). A preset the chosen template's engine cannot draw is locked with the reason; with no
 * template chosen yet every preset can be picked and is checked again before the run starts.
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
  const [enlarged, setEnlarged] = useState(false);
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
  const shownTheme = captionPresetTheme(shown);
  const shownStyle = captionPresetStyle(shown, engine, defaults);
  const shownReason = reasonFor(shown);

  return (
    <div className="flex flex-col gap-3" data-testid="caption-preset-picker">
      <p className="text-[11.5px] text-lyx-fg-muted">{engine ? t("captionPresets.previewHint") : t("captionPresets.pickTemplateFirst")}</p>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {/* the stage: the style being looked at, in motion */}
        <div className="flex gap-3 sm:w-[184px] sm:flex-none sm:flex-col" data-testid="caption-preset-preview" data-preset={shownId || "template"}>
          <CaptionMotionPreview key={shownId || "template"} style={shownStyle} engine={engine} samples={captionPresetSamples(shown)} scene={shownTheme.scene} accent={shownTheme.accent} className="w-[112px] flex-none sm:w-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5" aria-live="polite" data-testid="caption-preset-details">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight">
              <span className="inline-block h-2 w-2 flex-none rounded-full" style={{ background: shownTheme.accent }} aria-hidden />
              {nameOf(shown)}
            </p>
            <p className="text-[11.5px] leading-4 text-lyx-fg-muted">{descriptionOf(shown)}</p>
            {shown ? <CaptionPresetCompatibility item={shown} /> : null}
            {shownReason ? <p className="text-[11px] leading-4 text-lyx-fg-subtle">{shownReason}</p> : null}
            <Button type="button" variant="ghost" className="h-7 w-fit gap-1.5 px-2 text-[11.5px]" onClick={() => setEnlarged(true)} data-testid="caption-preset-enlarge">
              <Maximize2 size={13} aria-hidden /> {t("captionPresets.enlarge")}
            </Button>
          </div>
        </div>

        <div role="radiogroup" aria-label={t("captionPresets.title")} className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(176px,1fr))] content-start gap-2.5" onMouseLeave={() => setHoverId(null)}>
          {options.map((item) => {
            const id = item?.id ?? "";
            return (
              <PresetCard
                key={id || "template"}
                id={id}
                item={item}
                name={nameOf(item)}
                description={descriptionOf(item)}
                style={captionPresetStyle(item, engine, defaults)}
                engine={engine}
                selected={selectedId === id}
                reason={reasonFor(item)}
                onPreview={() => setHoverId(id)}
                onLeave={() => setHoverId(null)}
                onChoose={() => onChoose(id)}
              />
            );
          })}
        </div>
      </div>

      {enlarged ? (
        <Modal title={nameOf(shown)} onClose={() => setEnlarged(false)}>
          <div className="flex flex-col items-center gap-3" data-testid="caption-preset-modal">
            <CaptionMotionPreview key={shownId || "template"} style={shownStyle} engine={engine} samples={captionPresetSamples(shown)} scene={shownTheme.scene} accent={shownTheme.accent} className="w-[240px] max-w-full" testId="caption-motion-preview-large" />
            <p className="text-center text-[12.5px] text-lyx-fg-muted">{descriptionOf(shown)}</p>
            {shown ? <CaptionPresetCompatibility item={shown} /> : null}
            {shownReason ? <p className="text-center text-[11px] text-lyx-fg-subtle">{shownReason}</p> : null}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setEnlarged(false)}>{t("captionPresets.close")}</Button>
              <Button disabled={selectedId === shownId || Boolean(shownReason)} onClick={() => { onChoose(shownId); setEnlarged(false); }}>
                {selectedId === shownId ? t("captionPresets.selected") : t("captionPresets.choose")}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** Caption anchor -> label key ("center" is shown as "middle", like the position control). */
const POSITION_KEY: Record<string, "top" | "middle" | "bottom"> = { top: "top", center: "middle", bottom: "bottom" };

/** One preset: its own 9:16 preview, name, font, colours, position / lines, engines - with hover lift / glow and a selected ring. */
function PresetCard({ id, item, name, description, style, engine, selected, reason, onPreview, onLeave, onChoose }: {
  id: string;
  item: CaptionPreset | null;
  name: string;
  description: string;
  style: CaptionTextStyle;
  engine: CaptionStyleEngine | null;
  selected: boolean;
  reason: string | null;
  onPreview: () => void;
  onLeave: () => void;
  onChoose: () => void;
}) {
  const { t } = useTranslation();
  const theme = captionPresetTheme(item);
  const font = captionFontById(style.font.id)?.label ?? style.font.family;
  const state = reason
    ? "cursor-not-allowed border-lyx-border bg-lyx-bg opacity-55 grayscale"
    : selected
      ? "border-[color:var(--accent)] bg-[color-mix(in_srgb,var(--accent)_9%,var(--lyx-bg))] shadow-[0_0_0_1px_var(--accent),0_14px_30px_-16px_var(--accent)]"
      : "border-lyx-border bg-lyx-bg hover:-translate-y-0.5 hover:border-[color:var(--accent)] hover:shadow-[0_14px_30px_-18px_var(--accent)] focus-visible:border-[color:var(--accent)]";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={Boolean(reason)}
      title={reason ? `${name}: ${reason}` : description}
      className={`group relative flex min-w-0 gap-2.5 rounded-[10px] border p-2 text-left transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out ${state}`}
      style={{ "--accent": theme.accent } as CSSProperties}
      data-testid="caption-preset-card"
      data-preset={id || "template"}
      data-selected={selected}
      onMouseEnter={onPreview}
      onFocus={onPreview}
      onBlur={onLeave}
      onClick={() => { if (!reason) onChoose(); }}
    >
      <span className={`w-[54px] flex-none transition-transform duration-200 ${reason ? "" : "group-hover:scale-[1.05]"}`}>
        <CaptionStyleSample style={style} engine={engine} background={theme.scene} text={captionPresetSamples(item)[0] ?? ""} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
        <span className="truncate text-[12.5px] font-semibold leading-tight">{name}</span>
        <span className="truncate text-[10.5px] text-lyx-fg-muted" style={{ fontFamily: captionCssFont(style) }}>
          {font} · {style.fontSizePx}px{style.bold ? " · B" : ""}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-lyx-fg-muted">
          <span className="h-3.5 w-3.5 rounded-full ring-1 ring-lyx-border" style={{ background: style.fillColor }} title={t("captionPresets.textColor")} aria-label={`${t("captionPresets.textColor")} ${style.fillColor}`} />
          {style.stroke.enabled ? (
            <span className="h-3.5 w-3.5 rounded-full outline outline-1 outline-white/25" style={{ boxShadow: `inset 0 0 0 ${Math.min(4, Math.max(2, Math.round(style.stroke.widthPx / 2)))}px ${style.stroke.color}` }} title={t("captionPresets.strokeColor")} aria-label={`${t("captionPresets.strokeColor")} ${style.stroke.color}`} />
          ) : (
            <span className="text-[9.5px]">{t("captionPresets.noStroke")}</span>
          )}
          <span>{t(`captionPresets.position.${POSITION_KEY[style.position.anchor] ?? "bottom"}`)} · {t("captionPresets.lines", { count: style.maxLines })}</span>
        </span>
        {style.animation === "word_highlight" ? (
          <span className="inline-flex w-fit items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-semibold" style={{ background: `color-mix(in srgb, ${theme.accent} 22%, transparent)` }}>
            <Sparkles size={10} aria-hidden /> {t("captionPresets.wordHighlight")}
          </span>
        ) : null}
        {item ? <CaptionPresetCompatibility item={item} /> : null}
        {reason ? (
          <span className="flex items-start gap-1 text-[10px] leading-[13px] text-lyx-fg-subtle"><Lock size={11} className="mt-px flex-none" aria-hidden /> {reason}</span>
        ) : null}
      </span>
      {selected ? (
        <span className="lyx-anim-pop absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-white shadow-md" style={{ background: theme.accent }} aria-hidden data-testid="caption-preset-check">
          <Check size={12} strokeWidth={3} />
        </span>
      ) : null}
    </button>
  );
}
