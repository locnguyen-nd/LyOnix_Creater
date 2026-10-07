import { useTranslation } from "react-i18next";
import { captionPresetSupport, type CaptionPreset } from "@lyonix/domain/caption-presets";
import { CAPTION_STYLE_ENGINES, type CaptionStyleEngine, type CaptionStyleUnsupportedReason } from "@lyonix/domain/caption-style-capabilities";
import { resolveCaptionTextStyle, type CaptionTemplateDefaults, type CaptionTextStyle } from "@lyonix/domain/caption-style";
import { captionCssFont, SceneCaptionPreview } from "./CaptionPreview";

/**
 * VE2E-94: how a caption preset is shown in Auto and Studio - all drawn by the VE2E-93 caption preview with the same resolver the render
 * uses (no second preview engine), support read from the capability map (no rule of its own).
 */

/** Why a control or preset is disabled (`studioPro.textStyleReason*`). */
export const CAPTION_REASON_KEY: Record<CaptionStyleUnsupportedReason, string> = {
  provider_unsupported: "studioPro.textStyleReasonProviderUnsupported",
  no_word_highlight: "studioPro.textStyleReasonNoWordHighlight",
};

/** The style a preset gives the whole video (the template only supplies what a preset never sets: bold, the highlight colour). */
export const captionPresetStyle = (item: CaptionPreset | null, engine: CaptionStyleEngine | null, defaults: CaptionTemplateDefaults | null): CaptionTextStyle =>
  resolveCaptionTextStyle({ engine: engine === "creatomate" ? "creatomate" : "lyonix", defaults, global: item?.style ?? null });

/** A 9:16 preview of a caption style with a sample text, laid out exactly like the engine (VE2E-93 `SceneCaptionPreview`). */
export function CaptionStyleSample({ style, engine, className = "", background, text }: { style: CaptionTextStyle; engine: CaptionStyleEngine | null; className?: string; /** Backdrop standing for the video (CSS background); default a neutral dusk gradient. */ background?: string; /** Sample caption; default the localized sample sentence. */ text?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`relative overflow-hidden rounded-[8px] ${background ? "" : "bg-[linear-gradient(160deg,#3a4a5c,#1b2430_55%,#0e1218)]"} ${className}`} style={{ aspectRatio: "9 / 16", containerType: "inline-size", ...(background ? { background } : {}) }} data-testid="caption-style-sample">
      <SceneCaptionPreview text={text ?? t("captionPresets.sampleText")} style={style} engine={engine === "creatomate" ? "creatomate" : "lyonix"} sceneIndex={0} durationMs={4000} />
    </div>
  );
}

/** A small "Aa あ" swatch in a preset's font, colours and outline (Studio's preset list). */
export function CaptionPresetSwatch({ style }: { style: CaptionTextStyle }) {
  const size = 22;
  const stroke = style.stroke.enabled ? Math.max(1, (style.stroke.widthPx * 2 * size) / style.fontSizePx) : 0;
  return (
    <svg viewBox="0 0 96 34" className="h-[30px] w-full rounded-[4px] bg-[#25303b]" aria-hidden data-testid="caption-preset-swatch">
      <text
        x="48"
        y="24"
        textAnchor="middle"
        fontFamily={captionCssFont(style)}
        fontSize={size}
        fontWeight={style.bold ? 700 : 400}
        fill={style.fillColor}
        stroke={stroke > 0 ? style.stroke.color : "none"}
        strokeWidth={stroke}
        paintOrder="stroke"
        strokeLinejoin="round"
      >
        Aa あ
      </text>
    </svg>
  );
}

/** Which render engines draw this preset, each with the reason when it cannot (from the capability map). */
export function CaptionPresetCompatibility({ item }: { item: CaptionPreset }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-wrap gap-1" aria-label={t("captionPresets.compatibility")} data-testid="caption-preset-compat">
      {CAPTION_STYLE_ENGINES.map((engine) => {
        const support = captionPresetSupport(engine, item);
        const status = support.ok ? t("captionPresets.supported") : t("captionPresets.unsupported");
        return (
          <li
            key={engine}
            title={support.ok ? status : t(CAPTION_REASON_KEY[support.reason])}
            className={`rounded-full px-1.5 py-px text-[9.5px] ${support.ok ? "bg-emerald-500/15 text-lyx-fg" : "bg-lyx-muted text-lyx-fg-subtle line-through"}`}
            data-engine={engine}
            data-supported={support.ok}
          >
            {t(`renderEngine.name.${engine}`)}
            <span className="sr-only">: {status}</span>
          </li>
        );
      })}
    </ul>
  );
}
