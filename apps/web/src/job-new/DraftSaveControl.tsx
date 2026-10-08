import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, CheckCircle2, Loader2, Save } from "lucide-react";
import type { DraftSaveStatus } from "./draft-autosave";

export type DraftSaveMode = "idle" | "saving" | "saved" | "error";

/** What the button shows: saving / failed come from the save itself; "saved" is the short success after a save the user asked for. */
export const draftSaveMode = (status: DraftSaveStatus, flash: boolean): DraftSaveMode =>
  status.kind === "saving" ? "saving" : status.kind === "error" ? "error" : flash ? "saved" : "idle";

/** The success animation plays once, when a save the user clicked ends (saving -> saved) - never for a background autosave. */
export const earnsSaveFlash = (before: DraftSaveStatus["kind"], status: DraftSaveStatus, requested: boolean): boolean => requested && before === "saving" && status.kind === "saved";

/**
 * VE2E-124 draft bar, with clear feedback: the "Lưu bản nháp" button shows saving (spinner), a short "Đã lưu" success (check pop + green
 * ring, after a save the user asked for - never on every autosave) and a failed save (red, retry); the status next to it says what is
 * stored (saved at / unsaved changes / failed / saved elsewhere). Only presentation: saving is DraftAutosaver's, unchanged.
 */
export function DraftSaveControl({ status, disabled, onSave, onRetry, onOverwrite, formatTime }: {
  status: DraftSaveStatus;
  disabled: boolean;
  onSave: () => void;
  onRetry: () => void;
  onOverwrite: () => void;
  formatTime: (date: Date) => string;
}) {
  const { t } = useTranslation();
  const [flash, setFlash] = useState(false);
  /** The user clicked: the next "saved" is theirs and earns the success animation. */
  const requested = useRef(false);
  const previous = useRef(status.kind);

  useEffect(() => {
    const before = previous.current;
    previous.current = status.kind;
    if (status.kind === "error" || status.kind === "conflict") requested.current = false;
    if (!earnsSaveFlash(before, status, requested.current)) return undefined;
    requested.current = false;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 2400);
    return () => clearTimeout(timer);
  }, [status]);

  const mode = draftSaveMode(status, flash);
  const click = () => {
    requested.current = true;
    setFlash(false);
    if (mode === "error") onRetry();
    else onSave();
  };
  const look: Record<DraftSaveMode, string> = {
    idle: "lyx-btn-secondary",
    saving: "lyx-btn-secondary cursor-progress",
    saved: "lyx-anim-success border border-lyx-ok bg-lyx-ok-bg text-lyx-ok",
    error: "border border-lyx-danger bg-lyx-danger-bg text-lyx-danger",
  };

  return (
    <div className="flex flex-wrap items-center gap-2.5" data-testid="draft-save" data-mode={mode}>
      <button
        type="button"
        className={`lyx-btn min-w-[148px] gap-1.5 transition-colors duration-200 ${look[mode]}`}
        disabled={disabled || mode === "saving"}
        aria-busy={mode === "saving"}
        onClick={click}
        data-testid="draft-save-button"
      >
        {mode === "saving" ? <Loader2 size={14} className="animate-spin" aria-hidden />
          : mode === "saved" ? <Check size={15} strokeWidth={3} className="lyx-anim-pop" aria-hidden />
          : mode === "error" ? <AlertTriangle size={14} aria-hidden />
          : <Save size={14} aria-hidden />}
        <span>{mode === "saving" ? t("jobs.draftSaving") : mode === "saved" ? t("jobs.draftSavedNow") : mode === "error" ? t("jobs.draftRetry") : t("jobs.draftSave")}</span>
      </button>

      {status.kind === "saved" ? (
        <span key={status.at.getTime()} role="status" className="lyx-anim-fade-up inline-flex items-center gap-1.5 text-lyx-fg-muted" data-testid="draft-status">
          <CheckCircle2 size={14} className="text-lyx-ok" aria-hidden /> {t("jobs.draftSavedAt", { time: formatTime(status.at) })}
        </span>
      ) : status.kind === "pending" ? (
        <span role="status" className="lyx-anim-fade-up inline-flex items-center gap-1.5 text-lyx-fg-muted" data-testid="draft-status">
          <span className="lyx-anim-soft-pulse inline-block h-2 w-2 rounded-full bg-lyx-warn" aria-hidden /> {t("jobs.draftPending")}
        </span>
      ) : status.kind === "saving" ? (
        <span role="status" className="sr-only">{t("jobs.draftSaving")}</span>
      ) : status.kind === "error" ? (
        <span role="alert" className="lyx-anim-fade-up inline-flex items-center gap-1.5 text-lyx-danger" data-testid="draft-status">
          <AlertTriangle size={14} aria-hidden /> {t("jobs.draftSaveFailed")}
        </span>
      ) : status.kind === "conflict" ? (
        <span role="alert" className="lyx-anim-fade-up inline-flex flex-wrap items-center gap-2 text-lyx-warn" data-testid="draft-status">
          <AlertTriangle size={14} aria-hidden /> {t("jobs.draftConflict")}
          <button type="button" className="lyx-btn lyx-btn-ghost h-7 px-2 text-[12px]" onClick={onOverwrite}>{t("jobs.draftOverwrite")}</button>
        </span>
      ) : null}
    </div>
  );
}
