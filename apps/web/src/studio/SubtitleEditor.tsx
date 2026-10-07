import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../components/feedback";
import type { AudioVersionResponse, SubtitleVersionResponse } from "@lyonix/contracts";
import { SUBTITLE_EDIT_LIMITS, mergeWithNext, nudgeCue, splitCue, validateSubtitleCues, type SubtitleCue, type SubtitleCueError } from "@lyonix/domain/subtitle-edit";
import { ApiError } from "../api";
import { Button, TextArea } from "../components/ui";
import { resetSubtitleVersion, saveSubtitleVersion } from "./subtitle-api";
import { cueErrorKey, cuesChanged, errorsByCue, formatCueTime } from "./subtitle-editor";

export type SubtitleEditorProps = {
  /** The scene's bound voice; its `subtitleVersion` (the newest one) is what gets edited. */
  audio: AudioVersionResponse;
  /** SubtitleVersion the timeline pins for this scene (null = none pinned). */
  pinnedSubtitleVersionId: string | null;
  /** Signed URL of the voice, for "play this line". */
  audioUrl: string | undefined;
  /** A new version was saved (edit or reset): the parent re-binds the scene to it. */
  onSaved: (subtitle: SubtitleVersionResponse) => void;
  /** Re-bind the scene to the voice's newest version without editing (when the timeline pins an older one). */
  onUseLatest: (subtitle: SubtitleVersionResponse) => void;
};

const toCues = (subtitle: SubtitleVersionResponse | null): SubtitleCue[] => (subtitle?.segments ?? []).map((cue) => ({ text: cue.text, startMs: cue.startMs, endMs: cue.endMs }));

/**
 * V03-03: editor of one voice's timed subtitles. Every cue keeps the voice's real start/end; the user can change the words,
 * nudge an edge by `nudgeStepMs`, split at the cursor, merge with the next line, play the line, or restore the automatic
 * subtitles. Saving creates a new SubtitleVersion (the server re-validates with the same domain rules) and hands it to the
 * parent, which re-binds the scene - the timeline then needs a save + re-approval before a render uses it.
 */
export function SubtitleEditor({ audio, pinnedSubtitleVersionId, audioUrl, onSaved, onUseLatest }: SubtitleEditorProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [base, setBase] = useState<SubtitleVersionResponse | null>(audio.subtitleVersion);
  const [cues, setCues] = useState<SubtitleCue[]>(() => toCues(audio.subtitleVersion));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const caretByCue = useRef(new Map<number, number>());
  const player = useRef<HTMLAudioElement | null>(null);
  const stopAtMs = useRef<number | null>(null);

  useEffect(() => {
    setBase(audio.subtitleVersion);
    setCues(toCues(audio.subtitleVersion));
    setNotice(null);
    setError(null);
  }, [audio.id, audio.subtitleVersion?.id]);

  const validation = useMemo(() => validateSubtitleCues(cues, audio.durationMs), [cues, audio.durationMs]);
  const rowErrors = validation.ok ? new Map<number, SubtitleCueError["code"]>() : errorsByCue(validation.errors);
  const listError = rowErrors.get(-1);
  const dirty = cuesChanged(cues, toCues(base));
  const editable = audio.status === "current" && base !== null;
  const step = SUBTITLE_EDIT_LIMITS.nudgeStepMs;

  if (!base) return <p className="text-[11px] text-lyx-fg-muted">{t("studioPro.subtitleNone")}</p>;

  const apply = (next: SubtitleCue[] | null, failureKey?: string) => {
    if (!next) {
      if (failureKey) setError(t(failureKey));
      return;
    }
    setError(null);
    setNotice(null);
    setCues(next);
  };

  const persist = async (request: () => Promise<SubtitleVersionResponse>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await request();
      setBase(saved);
      setCues(toCues(saved));
      setNotice(t("studioPro.subtitleSaved", { version: saved.version }));
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "VERSION_CONFLICT" ? t("studioPro.subtitleConflict") : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!validation.ok) return;
    void persist(() => saveSubtitleVersion(audio.id, { basedOnSubtitleVersionId: base.id, cues: validation.cues }));
  };

  const reset = async () => {
    if (!(await confirm({ title: t("studioPro.subtitleResetConfirm"), message: t("studioPro.subtitleResetConfirm"), tone: "warn" }))) return;
    void persist(() => resetSubtitleVersion(audio.id, { basedOnSubtitleVersionId: base.id }));
  };

  const play = (cue: SubtitleCue) => {
    const element = player.current;
    if (!element) return;
    stopAtMs.current = cue.endMs;
    element.currentTime = cue.startMs / 1000;
    void element.play().catch(() => undefined);
  };

  const pinnedIsOlder = pinnedSubtitleVersionId !== null && pinnedSubtitleVersionId !== base.id;

  return (
    <section aria-label={t("studioPro.subtitleTitle")} data-testid="subtitle-editor" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[10px] text-lyx-fg-muted">{t("studioPro.subtitleTitle")}</p>
        <span className="text-[10px] text-lyx-fg-subtle">
          {t(base.source === "manual_edit" ? "studioPro.subtitleSourceEdited" : "studioPro.subtitleSourceAuto", { version: base.version })}
        </span>
      </div>
      <p className="text-[10px] text-lyx-fg-subtle">{t("studioPro.subtitleHint")}</p>
      {!editable ? <p role="note" className="text-[11px] text-amber-400">{t("studioPro.subtitleStaleVoice")}</p> : null}
      {pinnedIsOlder ? (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-amber-400">{t("studioPro.subtitlePinnedOlder")}</span>
          <Button variant="ghost" onClick={() => onUseLatest(base)}>{t("studioPro.subtitleUseLatest", { version: base.version })}</Button>
        </div>
      ) : null}
      {audioUrl ? (
        <audio
          ref={player}
          src={audioUrl}
          className="hidden"
          onTimeUpdate={(event) => {
            if (stopAtMs.current !== null && event.currentTarget.currentTime * 1000 >= stopAtMs.current) {
              event.currentTarget.pause();
              stopAtMs.current = null;
            }
          }}
        />
      ) : null}

      <ol className="space-y-2">
        {cues.map((cue, index) => {
          const rowError = rowErrors.get(index);
          return (
            <li key={index} data-testid="subtitle-cue" className={`rounded border p-1.5 ${rowError ? "border-red-500/60" : "border-lyx-border"}`}>
              <div className="mb-1 flex items-center gap-1 font-mono text-[10px] text-lyx-fg-muted">
                <span className="mr-auto">{t("studioPro.subtitleLine", { line: index + 1 })}</span>
                <button type="button" className="lyx-btn lyx-btn-ghost h-6 px-1" disabled={!editable || busy} title={t("studioPro.subtitleEarlier", { ms: step })} onClick={() => apply(nudgeCue(cues, index, "start", -step, audio.durationMs))}>−</button>
                <span>{formatCueTime(cue.startMs)}</span>
                <button type="button" className="lyx-btn lyx-btn-ghost h-6 px-1" disabled={!editable || busy} title={t("studioPro.subtitleLater", { ms: step })} onClick={() => apply(nudgeCue(cues, index, "start", step, audio.durationMs))}>+</button>
                <span>→</span>
                <button type="button" className="lyx-btn lyx-btn-ghost h-6 px-1" disabled={!editable || busy} title={t("studioPro.subtitleEarlier", { ms: step })} onClick={() => apply(nudgeCue(cues, index, "end", -step, audio.durationMs))}>−</button>
                <span>{formatCueTime(cue.endMs)}</span>
                <button type="button" className="lyx-btn lyx-btn-ghost h-6 px-1" disabled={!editable || busy} title={t("studioPro.subtitleLater", { ms: step })} onClick={() => apply(nudgeCue(cues, index, "end", step, audio.durationMs))}>+</button>
                <button type="button" className="lyx-btn lyx-btn-ghost h-6 px-1" disabled={!audioUrl} title={t("studioPro.subtitlePlay")} onClick={() => play(cue)}>▶</button>
              </div>
              <TextArea
                className="!min-h-0 w-full px-2 py-1 text-[12px]"
                rows={2}
                value={cue.text}
                disabled={!editable || busy}
                aria-invalid={rowError ? true : undefined}
                onChange={(event) => apply(cues.map((item, i) => (i === index ? { ...item, text: event.target.value } : item)))}
                onSelect={(event) => caretByCue.current.set(index, event.currentTarget.selectionStart)}
              />
              {rowError ? <p className="text-[10px] text-red-500">{t(cueErrorKey(rowError))}</p> : null}
              <div className="mt-1 flex gap-1">
                <Button variant="ghost" className="h-6 text-[10px]" disabled={!editable || busy} onClick={() => apply(splitCue(cues, index, caretByCue.current.get(index) ?? 0), "studioPro.subtitleSplitFailed")}>{t("studioPro.subtitleSplit")}</Button>
                {index < cues.length - 1 ? (
                  <Button variant="ghost" className="h-6 text-[10px]" disabled={!editable || busy} onClick={() => apply(mergeWithNext(cues, index))}>{t("studioPro.subtitleMerge")}</Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {listError ? <p role="alert" className="text-[11px] text-red-500">{t(cueErrorKey(listError))}</p> : null}
      {error ? <p role="alert" className="text-[11px] text-red-500">{error}</p> : null}
      {notice ? <p role="status" className="text-[11px] text-emerald-500">{notice}</p> : null}
      {base.source === "manual_edit" || dirty ? <p className="text-[10px] text-lyx-fg-subtle">{t("studioPro.subtitleEstimated")}</p> : null}

      <div className="flex flex-wrap gap-1">
        <Button disabled={!editable || busy || !dirty || !validation.ok} onClick={save}>{busy ? t("studioPro.subtitleSaving") : t("studioPro.subtitleSave")}</Button>
        <Button variant="secondary" disabled={busy || !dirty} onClick={() => apply(toCues(base))}>{t("studioPro.subtitleDiscard")}</Button>
        <Button variant="ghost" disabled={!editable || busy} onClick={reset}>{t("studioPro.subtitleReset")}</Button>
      </div>
    </section>
  );
}
