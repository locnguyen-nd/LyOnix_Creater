import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { CaptionFontScript } from "@lyonix/domain/caption-fonts";
import { captionStyleCapability, captionStyleFieldReason, type CaptionStyleField, type CaptionStyleUnsupportedReason } from "@lyonix/domain/caption-style-capabilities";
import {
  CAPTION_FONT_SIZE_RANGE,
  CAPTION_STROKE_WIDTH_RANGE,
  captionStyleFieldValue,
  type CaptionPatchField,
  type CaptionTextStylePatch,
} from "@lyonix/domain/caption-style";
import { Button } from "../../components/ui";
import {
  CaptionStyleEditSession,
  captionStyleNotices,
  countCustomizedFields,
  isFieldCustomized,
  previewCaptionStyle,
  type CaptionStyleEdit,
  type CaptionStyleNotice,
  type CaptionStyleScope,
  type StudioCaptionContext,
} from "./caption-style-model";
import { TextStyleChoiceField, TextStyleFieldRow } from "./TextStyleFieldRow";
import { TextStyleColorField } from "./TextStyleColorField";
import { TextStyleFontField } from "./TextStyleFontField";
import { TextStyleNumberField } from "./TextStyleNumberField";
import { TextStylePositionField } from "./TextStylePositionField";

const FILL_SWATCHES = ["#FFFFFF", "#FFE600", "#000000", "#FF3B30"] as const;
const STROKE_SWATCHES = ["#000000", "#FFFFFF"] as const;

const REASON_KEY: Record<CaptionStyleUnsupportedReason, string> = {
  provider_unsupported: "studioPro.textStyleReasonProviderUnsupported",
  no_word_highlight: "studioPro.textStyleReasonNoWordHighlight",
};
const SCRIPT_KEY: Record<CaptionFontScript, string> = {
  latin: "studioPro.textStyleScriptLatin",
  ja: "studioPro.textStyleScriptJa",
  ko: "studioPro.textStyleScriptKo",
  vi: "studioPro.textStyleScriptVi",
};

export type TextStylePanelScene = { sceneId: string; index: number; patch: CaptionTextStylePatch | null; text: string };

export type TextStylePanelProps = {
  ctx: StudioCaptionContext;
  /** The selected scene (null = none selected). */
  scene: TextStylePanelScene | null;
  /** Caption texts of every scene (font coverage warnings for the whole video). */
  allTexts: readonly string[];
  anySceneOverride: boolean;
  /** The pinned LyOnix template has provider fallbacks (the Router may render it elsewhere). */
  hasFallback: boolean;
  /** The edit being dragged right now (shown by the previews, not saved yet). */
  pending: CaptionStyleEdit | null;
  onPreview: (edit: CaptionStyleEdit | null) => void;
  /** One committed change (StudioProPage writes it into the draft: one undo entry, debounced autosave). */
  onCommit: (edit: CaptionStyleEdit) => void;
  onResetScene: (sceneId: string) => void;
  onResetVideo: () => void;
};

/**
 * VE2E-93: caption text style panel (whole video / this scene). Every control's availability comes from the capability map; values are
 * the effective style; a slider/colour drag previews live and is written once on release. No API call happens here.
 */
export function TextStylePanel(props: TextStylePanelProps) {
  const { t } = useTranslation();
  const { ctx, scene } = props;
  const [scopeChoice, setScopeChoice] = useState<CaptionStyleScope>("video");

  // latest callbacks for the long-lived edit session
  const callbacks = useRef({ onPreview: props.onPreview, onCommit: props.onCommit });
  callbacks.current = { onPreview: props.onPreview, onCommit: props.onCommit };
  const session = useMemo(() => new CaptionStyleEditSession((edit) => callbacks.current.onPreview(edit), (edit) => callbacks.current.onCommit(edit)), []);
  useEffect(() => () => session.cancel(), [session]);

  if (!ctx.engine) {
    return (
      <section className="flex flex-col gap-2 border-t border-lyx-border pt-2" aria-label={t("studioPro.textStyleTitle")} data-testid="text-style-panel">
        <p className="text-[10px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("studioPro.textStyleTitle")}</p>
        <p className="text-[11px] text-lyx-fg-muted">{t("studioPro.textStyleNeedTemplate")}</p>
      </section>
    );
  }

  const engine = ctx.engine;
  const capability = captionStyleCapability(engine);
  const sceneScopeAvailable = Boolean(scene) && capability.sceneOverride;
  const scope: CaptionStyleScope = scopeChoice === "scene" && sceneScopeAvailable ? "scene" : "video";
  const scenePatch = scope === "scene" ? scene?.patch ?? null : null;
  const sceneId = scope === "scene" ? scene?.sceneId ?? null : null;
  const style = previewCaptionStyle(ctx, sceneId, scenePatch, props.pending);
  const notices = captionStyleNotices({ ctx, style, scenePatch, texts: scope === "scene" && scene ? [scene.text] : props.allTexts, anySceneOverride: props.anySceneOverride, hasFallback: props.hasFallback });

  const reason = (field: CaptionStyleField): string | null => {
    const code = captionStyleFieldReason(engine, field);
    return code ? t(REASON_KEY[code]) : null;
  };
  const edit = (field: CaptionPatchField, value: CaptionTextStylePatch[CaptionPatchField] | undefined): CaptionStyleEdit => ({ scope, sceneId, changes: [{ field, value }] });
  const commit = (field: CaptionPatchField, value: CaptionTextStylePatch[CaptionPatchField] | undefined) => session.commit(edit(field, value));
  const preview = (field: CaptionPatchField, value: CaptionTextStylePatch[CaptionPatchField]) => session.preview(edit(field, value));
  const release = () => session.commit();
  const customized = (...fields: CaptionPatchField[]) => isFieldCustomized(ctx, scope, scenePatch, fields);
  // a group reset (e.g. the stroke's three fields) is one action: one draft change, one undo entry
  const reset = (...fields: CaptionPatchField[]) => () => session.commit({ scope, sceneId, changes: fields.map((field) => ({ field, value: undefined })) });
  const idFor = (name: string) => `text-style-${scope}-${name}`;
  const inheritFont = scope === "video" ? t("studioPro.textStyleFontTemplate", { font: ctx.defaults?.fontFamily ?? style.font.family }) : t("studioPro.textStyleFontInherit", { font: previewCaptionStyle(ctx, null, null, null).font.family });

  return (
    <section className="flex min-w-0 flex-col gap-3 border-t border-lyx-border pt-2" aria-label={t("studioPro.textStyleTitle")} data-testid="text-style-panel" data-engine={engine}>
      <p className="text-[10px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("studioPro.textStyleTitle")}</p>

      <div role="radiogroup" aria-label={t("studioPro.textStyleScope")} className="flex gap-1" title={capability.editable ? undefined : t(REASON_KEY.provider_unsupported)}>
        {(["video", "scene"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={scope === value}
            disabled={value === "scene" && !sceneScopeAvailable}
            onClick={() => { session.cancel(); setScopeChoice(value); }}
            className={`h-8 flex-1 rounded-[6px] border text-[11.5px] disabled:opacity-40 ${scope === value ? "border-lyx-fg bg-lyx-fg text-lyx-bg" : "border-lyx-border text-lyx-fg"}`}
          >
            {value === "video" ? t("studioPro.textStyleScopeVideo") : t("studioPro.textStyleScopeScene")}
          </button>
        ))}
      </div>

      {scope === "scene" && scene ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="font-medium">
            {t("studioPro.textStyleSceneHeading", { index: scene.index + 1 })}
            {" · "}
            <span className={countCustomizedFields(scene.patch) > 0 ? "text-lyx-fg" : "text-lyx-fg-muted"} data-testid="text-style-scene-status">
              {countCustomizedFields(scene.patch) > 0 ? t("studioPro.textStyleSceneCustomizedCount", { count: countCustomizedFields(scene.patch) }) : t("studioPro.textStyleSceneNoOverride")}
            </span>
          </span>
          {countCustomizedFields(scene.patch) > 0 ? (
            <Button variant="secondary" className="h-7 px-2 text-[11px]" onClick={() => { session.cancel(); props.onResetScene(scene.sceneId); }}>
              {t("studioPro.textStyleResetScene")}
            </Button>
          ) : null}
        </div>
      ) : !scene && capability.sceneOverride ? (
        <p className="text-[10px] text-lyx-fg-subtle">{t("studioPro.textStyleSceneScopeUnavailable")}</p>
      ) : null}

      {notices.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="text-style-notices">
          {notices.map((notice, index) => (
            <li key={`${notice.kind}-${index}`} role="note" className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10.5px] leading-4 text-lyx-fg">
              {noticeText(t, notice)}
            </li>
          ))}
        </ul>
      ) : null}

      <TextStyleFieldRow label={t("studioPro.textStylePosition")} customized={customized("position")} disabledReason={reason("position")} onReset={reset("position")}>
        <TextStylePositionField label={t("studioPro.textStylePosition")} value={captionStyleFieldValue(style, "position") ?? null} onCommit={(value) => commit("position", value)} />
      </TextStyleFieldRow>

      <TextStyleFieldRow label={t("studioPro.textStyleFont")} labelFor={idFor("font")} customized={customized("fontId")} disabledReason={reason("font")} onReset={reset("fontId")}>
        <TextStyleFontField id={idFor("font")} label={t("studioPro.textStyleFont")} style={style} inheritLabel={inheritFont} customized={customized("fontId")} onCommit={(value) => commit("fontId", value)} />
      </TextStyleFieldRow>

      <TextStyleFieldRow
        label={t("studioPro.textStyleFontSize")}
        labelFor={idFor("size")}
        customized={customized("fontSizePx")}
        disabledReason={reason("fontSize")}
        onReset={reset("fontSizePx")}
        hint={engine === "lyonix" ? t("studioPro.textStyleFontSizeHint") : null}
      >
        <TextStyleNumberField
          id={idFor("size")}
          label={t("studioPro.textStyleFontSize")}
          value={style.fontSizePx}
          min={CAPTION_FONT_SIZE_RANGE.min}
          max={CAPTION_FONT_SIZE_RANGE.max}
          step={CAPTION_FONT_SIZE_RANGE.step}
          onPreview={(value) => preview("fontSizePx", value)}
          onRelease={release}
          onCommit={(value) => commit("fontSizePx", value)}
        />
      </TextStyleFieldRow>

      <TextStyleFieldRow label={t("studioPro.textStyleFillColor")} labelFor={idFor("fill")} customized={customized("fillColor")} disabledReason={reason("fillColor")} onReset={reset("fillColor")}>
        <TextStyleColorField id={idFor("fill")} label={t("studioPro.textStyleFillColor")} value={style.fillColor} swatches={FILL_SWATCHES} onPreview={(value) => preview("fillColor", value)} onRelease={release} onCommit={(value) => commit("fillColor", value)} />
      </TextStyleFieldRow>

      <TextStyleFieldRow label={t("studioPro.textStyleStroke")} customized={customized("strokeEnabled", "strokeColor", "strokeWidthPx")} disabledReason={reason("stroke")} onReset={reset("strokeEnabled", "strokeColor", "strokeWidthPx")}>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={style.stroke.enabled} onChange={(event) => commit("strokeEnabled", event.target.checked)} />
            {t("studioPro.textStyleStrokeEnabled")}
          </label>
          <fieldset disabled={!style.stroke.enabled} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-50">
            <TextStyleColorField id={idFor("stroke-color")} label={t("studioPro.textStyleStrokeColor")} value={style.stroke.color} swatches={STROKE_SWATCHES} onPreview={(value) => preview("strokeColor", value)} onRelease={release} onCommit={(value) => commit("strokeColor", value)} />
            <TextStyleNumberField
              id={idFor("stroke-width")}
              label={t("studioPro.textStyleStrokeWidth")}
              value={style.stroke.widthPx}
              min={CAPTION_STROKE_WIDTH_RANGE.min}
              max={CAPTION_STROKE_WIDTH_RANGE.max}
              step={CAPTION_STROKE_WIDTH_RANGE.step}
              onPreview={(value) => preview("strokeWidthPx", value)}
              onRelease={release}
              onCommit={(value) => commit("strokeWidthPx", value)}
            />
          </fieldset>
        </div>
      </TextStyleFieldRow>

      <TextStyleFieldRow label={t("studioPro.textStyleMaxLines")} customized={customized("maxLines")} disabledReason={reason("maxLines")} onReset={reset("maxLines")}>
        <TextStyleChoiceField
          label={t("studioPro.textStyleMaxLines")}
          value={style.maxLines}
          options={[{ value: 1 as const, label: t("studioPro.textStyleLinesOne") }, { value: 2 as const, label: t("studioPro.textStyleLinesTwo") }]}
          onChange={(value) => commit("maxLines", value)}
        />
      </TextStyleFieldRow>

      <TextStyleFieldRow label={t("studioPro.textStyleAnimation")} customized={customized("animation")} disabledReason={reason("animation")} onReset={reset("animation")}>
        <TextStyleChoiceField
          label={t("studioPro.textStyleAnimation")}
          value={capability.animations.includes(style.animation) ? style.animation : "none"}
          options={[
            { value: "none" as const, label: t("studioPro.textStyleAnimationNone") },
            { value: "word_highlight" as const, label: t("studioPro.textStyleAnimationWordHighlight"), disabled: !capability.animations.includes("word_highlight") },
          ]}
          onChange={(value) => commit("animation", value)}
        />
      </TextStyleFieldRow>

      {engine === "creatomate" ? <p className="text-[10px] leading-4 text-lyx-fg-subtle">{t("studioPro.textStyleCreatomateApprox")}</p> : null}

      {scope === "video" && capability.editable ? (
        <Button variant="secondary" className="h-8 text-[11px]" onClick={() => { session.cancel(); props.onResetVideo(); }}>
          {t("studioPro.textStyleResetVideo")}
        </Button>
      ) : null}
    </section>
  );
}

function noticeText(t: TFunction, notice: CaptionStyleNotice): string {
  switch (notice.kind) {
    case "legacy_font":
      return t("studioPro.textStyleNoticeLegacyFont", { font: notice.font });
    case "unknown_font":
      return t("studioPro.textStyleNoticeUnknownFont");
    case "alpha_color":
      return t("studioPro.textStyleNoticeAlphaColor", { color: notice.color });
    case "unverified_scripts":
      return t("studioPro.textStyleNoticeScripts", { font: notice.font, scripts: notice.scripts.map((script) => t(SCRIPT_KEY[script])).join(", ") });
    case "preview_font":
      return t("studioPro.textStyleNoticePreviewFont", { font: notice.font });
    case "stored_ignored":
      return t("studioPro.textStyleNoticeStoredIgnored");
    case "highlight_unsupported":
      return t("studioPro.textStyleNoticeHighlightUnsupported");
    case "color_cycle":
      return t("studioPro.textStyleNoticeColorCycle");
    case "highlight_fallback":
      return t("studioPro.textStyleNoticeHighlightFallback");
  }
}
