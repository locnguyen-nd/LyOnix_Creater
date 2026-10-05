import { useTranslation } from "react-i18next";
import type { StudioSceneContextResponse } from "@lyonix/contracts";
import { Button } from "../components/ui";

type Props = {
  /** Script scenes removed from the timeline, recoverable. */
  removedScenes: StudioSceneContextResponse[];
  /** Non-excluded scenes with no voice yet (new/split scenes land here). */
  missingVoiceCount: number;
  voiceReady: boolean;
  voiceBusy: boolean;
  message: string | null;
  onRestore: (sceneId: string) => void;
  onGenerateMissingVoices: () => void;
};

/**
 * Secondary status strip for the scene track: edit errors, scenes still missing a voice and the
 * restorable "removed" list. The edit actions themselves (add / split / duplicate / delete / reorder)
 * live directly on the timeline - see SceneTimelineTrack. Renders nothing when there is nothing to say.
 */
export function TimelineEditToolbar({ removedScenes, missingVoiceCount, voiceReady, voiceBusy, message, onRestore, onGenerateMissingVoices }: Props) {
  const { t } = useTranslation();
  if (!message && missingVoiceCount === 0 && removedScenes.length === 0) return null;

  return (
    <section aria-label={t("studioPro.editToolbarTitle")} className="space-y-2 border border-lyx-border p-2 text-[11px]">
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
