import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { StudioSceneContextResponse } from "@lyonix/contracts";
import { Button, TextArea } from "../components/ui";
import { planSplit } from "./timeline-edit-actions";

type Props = {
  /** Scene the add/duplicate/delete/split actions apply to (null = none selected). */
  selectedScene: StudioSceneContextResponse | null;
  sceneCount: number;
  /** Script scenes removed from the timeline, recoverable. */
  removedScenes: StudioSceneContextResponse[];
  /** Non-excluded scenes with no voice yet (new/split scenes land here). */
  missingVoiceCount: number;
  voiceReady: boolean;
  voiceBusy: boolean;
  message: string | null;
  onAdd: (narration: string) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onSplit: (sceneId: string, sentenceBoundary: number) => void;
  onRestore: (sceneId: string) => void;
  onGenerateMissingVoices: () => void;
};

/**
 * VE2E-59: the Studio timeline's scene editing controls. Presentational only - every edit is a pure
 * domain op applied by StudioProPage through its undoable `mutate()`, nothing here touches the network.
 */
export function TimelineEditToolbar({
  selectedScene,
  sceneCount,
  removedScenes,
  missingVoiceCount,
  voiceReady,
  voiceBusy,
  message,
  onAdd,
  onDuplicate,
  onRemove,
  onSplit,
  onRestore,
  onGenerateMissingVoices,
}: Props) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [narration, setNarration] = useState("");
  const [splitting, setSplitting] = useState(false);
  const plan = selectedScene ? planSplit(selectedScene.narration) : null;

  const confirmAdd = () => {
    const text = narration.trim();
    if (!text) return;
    onAdd(text);
    setNarration("");
    setAdding(false);
  };

  return (
    <section aria-label={t("studioPro.editToolbarTitle")} className="space-y-2 border border-lyx-border p-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-1">
        <span className="font-medium">{t("studioPro.editToolbarTitle")}</span>
        <Button variant="secondary" onClick={() => setAdding((open) => !open)}>
          {t("studioPro.editAddScene")}
        </Button>
        <Button variant="secondary" onClick={onDuplicate} disabled={!selectedScene}>
          {t("studioPro.editDuplicate")}
        </Button>
        <Button variant="secondary" onClick={() => setSplitting((open) => !open)} disabled={!selectedScene}>
          {t("studioPro.editSplit")}
        </Button>
        <Button variant="danger" onClick={onRemove} disabled={!selectedScene || sceneCount <= 1}>
          {t("studioPro.editRemove")}
        </Button>
      </div>

      {adding && (
        <div className="space-y-1">
          <TextArea aria-label={t("studioPro.editAddPrompt")} placeholder={t("studioPro.editAddPrompt")} value={narration} onChange={(event) => setNarration(event.target.value)} rows={3} />
          <Button onClick={confirmAdd} disabled={!narration.trim()}>
            {t("studioPro.editAddConfirm")}
          </Button>
        </div>
      )}

      {splitting && (
        <div className="space-y-1">
          {!selectedScene ? (
            <p className="text-lyx-fg-muted">{t("studioPro.editNoScene")}</p>
          ) : plan && plan.boundaries.length === 0 ? (
            <p className="text-lyx-fg-muted">{t("studioPro.editSplitNone")}</p>
          ) : (
            plan?.boundaries.map((boundary) => (
              <div key={boundary} className="flex items-start gap-2 border border-lyx-border p-1">
                <Button
                  variant="secondary"
                  onClick={() => {
                    onSplit(selectedScene.sceneId, boundary);
                    setSplitting(false);
                  }}
                >
                  {t("studioPro.editSplitAfter", { n: boundary })}
                </Button>
                <p className="min-w-0 flex-1 text-lyx-fg-muted">
                  <span className="text-lyx-fg">{plan.sentences.slice(0, boundary).join(" ")}</span> │ {plan.sentences.slice(boundary).join(" ")}
                </p>
              </div>
            ))
          )}
        </div>
      )}

      {message && (
        <p role="alert" className="text-red-600">
          {message}
        </p>
      )}

      {missingVoiceCount > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t("studioPro.editMissingVoice", { count: missingVoiceCount })}</span>
          <Button variant="secondary" onClick={onGenerateMissingVoices} disabled={!voiceReady || voiceBusy}>
            {t("studioPro.editGenerateMissing")}
          </Button>
        </div>
      )}

      {removedScenes.length > 0 && (
        <details>
          <summary className="cursor-pointer">{t("studioPro.editRemovedTitle", { count: removedScenes.length })}</summary>
          <ul className="mt-1 space-y-1">
            {removedScenes.map((scene) => (
              <li key={scene.sceneId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-lyx-fg-muted">{scene.narration}</span>
                <Button variant="ghost" onClick={() => onRestore(scene.sceneId)}>
                  {t("studioPro.editRestore")}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
