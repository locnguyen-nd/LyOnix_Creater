import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Plus, Scissors, Trash2 } from "lucide-react";
import { LazyThumb } from "../components/LazyThumb";
import { planSplit } from "./timeline-edit-actions";
import { dropIndexFromPointer, splitMarkerRatios } from "./timeline-track-math";

export type TimelineClip = {
  sceneId: string;
  widthPx: number;
  durationSec: number;
  narration: string;
  thumbUrl?: string | undefined;
  thumbKind: "video" | "image";
  muted: boolean;
  segmentIndex: number;
  excluded: boolean;
};

type Props = {
  clips: TimelineClip[];
  selectedId: string | null;
  /** Gap between clips in px (must match the voice/music tracks below so they stay aligned). */
  gapPx: number;
  onSelect: (sceneId: string) => void;
  onReorder: (sceneId: string, toIndex: number) => void;
  /** Insert a new scene after `afterSceneId` (null = at the very start). */
  onInsert: (afterSceneId: string | null, narration: string) => void;
  onDuplicate: (sceneId: string) => void;
  onRemove: (sceneId: string) => void;
  onSplit: (sceneId: string, sentenceBoundary: number) => void;
  onUndo: () => void;
  onRedo: () => void;
};

export const TIMELINE_BAR_LANE_PX = 34;
const BAR_LANE_PX = TIMELINE_BAR_LANE_PX;

/**
 * Direct-manipulation scene track (VE2E-59 follow-up): select a clip and use the floating bar (split /
 * duplicate / delete), drag a clip to reorder, hover the seam between clips for "+" to insert, and use
 * the keyboard (Delete, Ctrl+D, S, arrows, Alt+arrows, Ctrl+Z). Presentational: every edit is a callback
 * the page runs through its undoable `mutate()`.
 */
export function SceneTimelineTrack({ clips, selectedId, gapPx, onSelect, onReorder, onInsert, onDuplicate, onRemove, onSplit, onUndo, onRedo }: Props) {
  const { t } = useTranslation();
  const [insertAfter, setInsertAfter] = useState<string | null | undefined>(undefined);
  const [insertText, setInsertText] = useState("");
  const [splitFor, setSplitFor] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [toast, setToast] = useState<{ text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  // A selection change or removal of the scene being split closes split mode.
  useEffect(() => { if (splitFor && splitFor !== selectedId) setSplitFor(null); }, [selectedId, splitFor]);

  const offsets: number[] = [];
  let acc = 0;
  for (const clip of clips) {
    offsets.push(acc);
    acc += clip.widthPx + gapPx;
  }
  const totalWidth = Math.max(0, acc - gapPx);
  const selectedIndex = clips.findIndex((clip) => clip.sceneId === selectedId);
  const selected = selectedIndex >= 0 ? clips[selectedIndex]! : null;

  const showToast = (text: string) => {
    setToast({ text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  };

  const remove = (clip: TimelineClip, index: number) => {
    if (clips.length <= 1) return;
    onRemove(clip.sceneId);
    showToast(t("studioPro.tlDeleted", { n: index + 1 }));
  };

  const confirmInsert = () => {
    const text = insertText.trim();
    if (!text || insertAfter === undefined) return;
    onInsert(insertAfter, text);
    setInsertText("");
    setInsertAfter(undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) onRedo();
      else onUndo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      onRedo();
      return;
    }
    if (!selected) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(selected, selectedIndex);
    } else if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      onDuplicate(selected.sceneId);
    } else if (!mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      setSplitFor((current) => (current === selected.sceneId ? null : selected.sceneId));
    } else if (event.key === "Escape") {
      setSplitFor(null);
      setInsertAfter(undefined);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const dir = event.key === "ArrowLeft" ? -1 : 1;
      const next = selectedIndex + dir;
      if (next < 0 || next >= clips.length) return;
      if (event.altKey) onReorder(selected.sceneId, next);
      else onSelect(clips[next]!.sceneId);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dragId) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    setDropIndex(dropIndexFromPointer(x, offsets, clips.map((clip) => clip.widthPx)));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (dragId && dropIndex !== null) {
      const from = clips.findIndex((clip) => clip.sceneId === dragId);
      // dropIndex is a gap position (0..n); moving past itself shifts by one after removal.
      const to = dropIndex > from ? dropIndex - 1 : dropIndex;
      if (from >= 0 && to !== from) onReorder(dragId, to);
    }
    setDragId(null);
    setDropIndex(null);
  };

  const splitClip = splitFor ? clips.find((clip) => clip.sceneId === splitFor) : null;
  const splitPlan = splitClip ? planSplit(splitClip.narration) : null;
  const splitRatios = splitPlan ? splitMarkerRatios(splitPlan.sentences) : [];

  const barLeft = selected ? Math.max(0, Math.min(offsets[selectedIndex]!, Math.max(0, totalWidth - 150))) : 0;

  return (
    <div
      role="group"
      aria-label={t("studioPro.tlAria")}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative w-max outline-none focus-visible:ring-1 focus-visible:ring-lyx-fg-muted"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIndex(null); }}
    >
      <div className="relative w-max" style={{ minWidth: totalWidth + 72 }}>
        {/* floating action lane */}
        <div className="relative" style={{ height: BAR_LANE_PX }}>
          {selected ? (
            <div
              className="absolute top-1 z-20 flex items-center gap-0.5 rounded-[8px] border border-lyx-border bg-lyx-bg p-0.5 shadow-md"
              style={{ left: barLeft }}
              role="toolbar"
              aria-label={t("studioPro.tlSceneActions", { n: selectedIndex + 1 })}
            >
              <button
                type="button"
                title={`${t("studioPro.tlSplit")} (S)`}
                aria-pressed={splitFor === selected.sceneId}
                onClick={() => setSplitFor((current) => (current === selected.sceneId ? null : selected.sceneId))}
                className={`flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[10.5px] hover:bg-lyx-muted ${splitFor === selected.sceneId ? "bg-lyx-muted font-semibold" : ""}`}
              >
                <Scissors size={12} strokeWidth={2} /> {t("studioPro.tlSplit")}
              </button>
              <button type="button" title={`${t("studioPro.tlDuplicate")} (Ctrl+D)`} onClick={() => onDuplicate(selected.sceneId)} className="flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[10.5px] hover:bg-lyx-muted">
                <Copy size={12} strokeWidth={2} /> {t("studioPro.tlDuplicate")}
              </button>
              <button
                type="button"
                title={clips.length <= 1 ? t("studioPro.tlKeepOne") : `${t("studioPro.tlDelete")} (Del)`}
                disabled={clips.length <= 1}
                onClick={() => remove(selected, selectedIndex)}
                className="flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[10.5px] text-lyx-danger hover:bg-lyx-muted disabled:opacity-35"
              >
                <Trash2 size={12} strokeWidth={2} /> {t("studioPro.tlDelete")}
              </button>
            </div>
          ) : (
            <p className="pt-2 text-[10.5px] text-lyx-fg-subtle">{t("studioPro.tlSelectHint")}</p>
          )}
        </div>

        {/* clips */}
        <div className="group/track relative flex h-[52px]" style={{ gap: gapPx }}>
          {clips.map((clip, index) => {
            const isSelected = clip.sceneId === selectedId;
            const isSplitting = clip.sceneId === splitFor;
            return (
              <div
                key={clip.sceneId}
                role="button"
                tabIndex={-1}
                draggable
                onDragStart={(event) => { setDragId(clip.sceneId); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", clip.sceneId); onSelect(clip.sceneId); }}
                onDragEnd={() => { setDragId(null); setDropIndex(null); }}
                onClick={() => onSelect(clip.sceneId)}
                title={`${index + 1} · ${Math.round(clip.durationSec)}s`}
                className={`relative h-[52px] shrink-0 cursor-grab overflow-hidden rounded-[6px] border text-left active:cursor-grabbing ${clip.segmentIndex >= 0 ? "border-violet-400" : ""} ${clip.excluded ? "opacity-35" : ""} ${dragId === clip.sceneId ? "opacity-40" : ""} ${isSelected ? "outline outline-2 outline-offset-1 outline-lyx-fg" : "border-lyx-border"}`}
                style={{ width: clip.widthPx, background: "linear-gradient(160deg,#3a3a38,#1c1c1b)" }}
              >
                {clip.thumbUrl ? <LazyThumb kind={clip.thumbKind} url={clip.thumbUrl} className="pointer-events-none absolute inset-0 h-full w-full opacity-80" /> : null}
                {clip.muted ? <span className="absolute right-1 top-1 rounded bg-black/50 px-1 text-[9px] text-white">🔇</span> : null}
                {clip.segmentIndex >= 0 ? <span className="absolute left-1 top-1 rounded bg-violet-700/85 px-1 text-[8px] font-semibold text-white">B{clip.segmentIndex + 1}</span> : null}
                <span className="absolute bottom-1 left-1 rounded bg-black/35 px-1 text-[9px] font-bold text-white">{index + 1} · {Math.round(clip.durationSec)}s</span>
                {isSplitting && splitPlan ? (
                  splitPlan.boundaries.length === 0 ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/60 px-1 text-center text-[9px] text-white">{t("studioPro.editSplitNone")}</span>
                  ) : (
                    <>
                      <span className="pointer-events-none absolute inset-x-0 top-0 bg-black/55 px-1 text-center text-[8.5px] text-white">{t("studioPro.tlSplitHint")}</span>
                      {splitPlan.boundaries.map((boundary, markerIndex) => (
                        <button
                          key={boundary}
                          type="button"
                          title={t("studioPro.editSplitAfter", { n: boundary })}
                          onClick={(event) => { event.stopPropagation(); onSplit(clip.sceneId, boundary); setSplitFor(null); }}
                          className="absolute bottom-0 top-3 z-10 -ml-[7px] flex w-[14px] justify-center"
                          style={{ left: `${(splitRatios[markerIndex] ?? 0) * 100}%` }}
                        >
                          <span className="h-full w-[2px] bg-amber-400" />
                        </button>
                      ))}
                    </>
                  )
                ) : null}
              </div>
            );
          })}

          {/* seam "+" buttons (appear on hover, overlay the gap so voice/music tracks stay aligned) */}
          {[null, ...clips.map((clip) => clip.sceneId)].map((afterId, index) => {
            const left = index === 0 ? 0 : offsets[index - 1]! + clips[index - 1]!.widthPx + gapPx / 2;
            return (
              <button
                key={afterId ?? "start"}
                type="button"
                aria-label={t("studioPro.tlInsertHere")}
                title={t("studioPro.tlInsertHere")}
                onClick={() => { setInsertAfter(afterId); setInsertText(""); }}
                className="absolute top-1/2 z-10 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-lyx-border bg-lyx-bg text-lyx-fg-muted opacity-0 shadow-sm transition-opacity hover:bg-lyx-fg hover:text-lyx-bg focus-visible:opacity-100 group-hover/track:opacity-80"
                style={{ left }}
              >
                <Plus size={12} strokeWidth={2.4} />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => { setInsertAfter(clips[clips.length - 1]?.sceneId ?? null); setInsertText(""); }}
            title={t("studioPro.tlInsertHere")}
            className="flex h-[52px] w-[60px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[6px] border border-dashed border-lyx-border text-[9.5px] text-lyx-fg-muted hover:bg-lyx-muted"
          >
            <Plus size={14} strokeWidth={2} />
            {t("studioPro.tlAddEnd")}
          </button>

          {/* drop indicator */}
          {dragId && dropIndex !== null ? (
            <span
              className="pointer-events-none absolute -top-1 bottom-[-4px] z-20 w-[3px] rounded bg-amber-400"
              style={{ left: dropIndex === 0 ? -2 : offsets[dropIndex - 1]! + clips[dropIndex - 1]!.widthPx + gapPx / 2 - 1.5 }}
            />
          ) : null}
        </div>

        {insertAfter !== undefined ? (
          <div className="absolute z-30 w-[280px] rounded-[8px] border border-lyx-border bg-lyx-bg p-2 shadow-lg" style={{ top: BAR_LANE_PX + 56, left: Math.min(insertAfter === null ? 0 : (offsets[clips.findIndex((clip) => clip.sceneId === insertAfter)] ?? 0), Math.max(0, totalWidth - 200)) }}>
            <textarea
              autoFocus
              rows={3}
              value={insertText}
              onChange={(event) => setInsertText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); confirmInsert(); }
                if (event.key === "Escape") { event.stopPropagation(); setInsertAfter(undefined); }
              }}
              placeholder={t("studioPro.editAddPrompt")}
              aria-label={t("studioPro.editAddPrompt")}
              className="w-full resize-none rounded-[6px] border border-lyx-border bg-lyx-muted p-1.5 text-[11px] outline-none"
            />
            <div className="mt-1 flex justify-end gap-1">
              <button type="button" className="h-6 rounded-[6px] px-2 text-[10.5px] text-lyx-fg-muted hover:bg-lyx-muted" onClick={() => setInsertAfter(undefined)}>{t("common.cancel")}</button>
              <button type="button" disabled={!insertText.trim()} className="h-6 rounded-[6px] bg-lyx-fg px-2 text-[10.5px] font-semibold text-lyx-bg disabled:opacity-40" onClick={confirmInsert}>{t("studioPro.tlInsertConfirm")}</button>
            </div>
          </div>
        ) : null}

        {toast ? (
          <div role="status" className="absolute bottom-1 right-0 z-30 flex items-center gap-2 rounded-[8px] bg-lyx-fg px-2.5 py-1 text-[11px] text-lyx-bg shadow-lg">
            {toast.text}
            <button type="button" className="font-semibold underline" onClick={() => { onUndo(); setToast(null); }}>{t("studioPro.tlUndo")}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
