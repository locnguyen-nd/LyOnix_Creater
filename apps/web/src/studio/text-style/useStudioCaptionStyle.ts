import { useState } from "react";
import type { CaptionTemplateDefaults, CaptionTextStyle, CaptionTextStylePatch } from "@lyonix/domain/caption-style";
import type { CaptionStyleEngine } from "@lyonix/domain/caption-style-capabilities";
import {
  applySceneCaptionEdit,
  applyVideoEdit,
  previewCaptionStyle,
  resetVideoCaptionStyle,
  studioCaptionEngine,
  type CaptionStyleEdit,
  type StudioCaptionContext,
} from "./caption-style-model";
import type { TextStylePanelProps, TextStylePanelScene } from "./TextStylePanel";

type CaptionDraft = {
  optionValues: Readonly<Record<string, string>>;
  scenes: ReadonlyArray<{ sceneId: string; captionStyleOverride: CaptionTextStylePatch | null }>;
};

/**
 * VE2E-93: StudioProPage's caption style wiring in one place - the engine (pinned template + render account), the edit being dragged
 * (preview only), and committed edits written to the draft as ONE change each (one undo entry, then the page's usual debounced autosave).
 */
export function useStudioCaptionStyle<D extends CaptionDraft>(input: {
  template: { engine?: string | undefined; captionStyleDefaults?: CaptionTemplateDefaults | undefined; fallbackSnapshotIds?: string[] | undefined } | null;
  renderProvider: string | null | undefined;
  draft: D;
  setDraft: (updater: (prev: D) => D) => void;
  undo: { push(previous: D): void };
}) {
  const { template, draft, setDraft, undo } = input;
  const [pending, setPending] = useState<CaptionStyleEdit | null>(null);
  const engine: CaptionStyleEngine | null = studioCaptionEngine(template, input.renderProvider);
  const ctxFor = (optionValues: Readonly<Record<string, string>>): StudioCaptionContext => ({ engine, defaults: template?.captionStyleDefaults ?? null, optionValues });

  /** Applies `change` to the draft as one undoable step; a change that changes nothing leaves the draft (and the undo stack) alone. */
  const write = (change: (prev: D) => D) => {
    setPending(null);
    setDraft((prev) => {
      const next = change(prev);
      if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
      undo.push(prev);
      return next;
    });
  };
  const withSceneOverride = (prev: D, sceneId: string | null, patch: (current: CaptionTextStylePatch | null) => CaptionTextStylePatch | null): D =>
    ({ ...prev, scenes: prev.scenes.map((row) => (row.sceneId === sceneId ? { ...row, captionStyleOverride: patch(row.captionStyleOverride) } : row)) }) as D;

  const commit = (edit: CaptionStyleEdit) =>
    write((prev) =>
      edit.scope === "video"
        ? ({ ...prev, optionValues: applyVideoEdit(ctxFor(prev.optionValues), edit) } as D)
        : withSceneOverride(prev, edit.sceneId, (current) => applySceneCaptionEdit(ctxFor(prev.optionValues), current, edit.changes)),
    );
  const resetScene = (sceneId: string) => write((prev) => withSceneOverride(prev, sceneId, () => null));
  const resetVideo = () => write((prev) => ({ ...prev, optionValues: resetVideoCaptionStyle(prev.optionValues) }) as D);

  /** Effective style of a scene as the previews show it (committed style + the edit being dragged). */
  const styleOf = (sceneId: string): CaptionTextStyle =>
    previewCaptionStyle(ctxFor(draft.optionValues), sceneId, draft.scenes.find((row) => row.sceneId === sceneId)?.captionStyleOverride ?? null, pending);

  return {
    engine,
    styleOf,
    stylesByScene: (): ReadonlyMap<string, CaptionTextStyle> => new Map(draft.scenes.map((row) => [row.sceneId, styleOf(row.sceneId)])),
    panelProps: (scene: TextStylePanelScene | null, allTexts: readonly string[]): TextStylePanelProps => ({
      ctx: ctxFor(draft.optionValues),
      scene,
      allTexts,
      anySceneOverride: draft.scenes.some((row) => row.captionStyleOverride !== null),
      hasFallback: (template?.fallbackSnapshotIds?.length ?? 0) > 0,
      pending,
      onPreview: setPending,
      onCommit: commit,
      onResetScene: resetScene,
      onResetVideo: resetVideo,
    }),
  };
}
