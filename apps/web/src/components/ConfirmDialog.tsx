import { useEffect, useId, useRef } from "react";
import { AlertTriangle, Info, Trash2, X } from "lucide-react";

export type ConfirmTone = "danger" | "warn";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  /** What the action takes away (shown as a red-tinted list). */
  details?: readonly string[];
  /** Reassurance about what is kept. */
  note?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Shown on the confirm button while the action runs. */
  busyLabel?: string;
  busy?: boolean;
  /** `danger` (default): red, destructive. `warn`: amber, for a reversible but costly step such as leaving unsaved edits. */
  tone?: ConfirmTone;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * VE2E-124: in-app confirmation for a destructive action (replaces the browser's `window.confirm`): red accent, the consequences
 * spelled out, entrance animation (disabled under prefers-reduced-motion). Focus starts on Cancel so Enter never destroys by
 * accident; Escape and a click on the backdrop cancel.
 */
export function ConfirmDialog({ open, title, message, details, note, confirmLabel, cancelLabel, busyLabel, busy = false, tone = "danger", onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="lyx-anim-backdrop fixed inset-0 z-50 flex items-center justify-center bg-[var(--lyx-overlay)] p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        data-testid="confirm-dialog"
        className="lyx-anim-dialog relative w-[440px] max-w-full overflow-hidden rounded-[12px] border border-lyx-border bg-lyx-elevated shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={`h-1 w-full ${tone === "warn" ? "bg-lyx-warn" : "bg-lyx-danger"}`} aria-hidden="true" />
        <button
          type="button"
          aria-label={cancelLabel}
          disabled={busy}
          onClick={onCancel}
          className="absolute right-3 top-4 rounded-full p-1 text-lyx-fg-subtle transition-colors hover:bg-lyx-muted hover:text-lyx-fg"
        >
          <X size={16} />
        </button>

        <div className="flex gap-4 px-6 pb-2 pt-6">
          <div className={`lyx-anim-danger-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${tone === "warn" ? "bg-lyx-warn-bg text-lyx-warn" : "bg-lyx-danger-bg text-lyx-danger"}`}>
            {tone === "warn" ? <AlertTriangle size={20} strokeWidth={2.2} /> : <Trash2 size={20} strokeWidth={2.2} />}
          </div>
          <div className="min-w-0 flex-1 pr-4">
            <h2 id={titleId} className="text-[16px] font-semibold leading-6 text-lyx-fg">{title}</h2>
            <p id={messageId} className="mt-1 text-[13px] leading-5 text-lyx-fg-muted">{message}</p>
          </div>
        </div>

        {details?.length ? (
          <ul className="mx-6 mt-3 flex flex-col gap-1.5 rounded-[8px] border border-lyx-danger/25 bg-lyx-danger-bg px-4 py-3 text-[12.5px] leading-5 text-lyx-fg">
            {details.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-lyx-danger" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {note ? (
          <p className="mx-6 mt-3 flex items-start gap-2 text-[12px] leading-5 text-lyx-fg-muted">
            <Info size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
            <span>{note}</span>
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2 border-t border-lyx-border bg-lyx-muted/40 px-6 py-4">
          <button ref={cancelRef} type="button" className="lyx-btn lyx-btn-secondary" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={`lyx-btn ${tone === "warn" ? "lyx-btn-primary" : "lyx-btn-danger-solid"}`} disabled={busy} onClick={onConfirm} data-testid="confirm-dialog-confirm">
            {tone === "warn" ? null : <Trash2 size={15} aria-hidden="true" />}
            {busy && busyLabel ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
