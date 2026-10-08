import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { ConfirmDialog, type ConfirmTone } from "./ConfirmDialog";

export type ToastTone = "success" | "info" | "warn" | "danger";
export type ConfirmOptions = {
  title: string;
  message: string;
  details?: readonly string[];
  note?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` (default, red, destructive) or `warn` (amber, e.g. leaving with unsaved edits). */
  tone?: ConfirmTone;
};

type Toast = { id: number; tone: ToastTone; message: string; title?: string };
type Feedback = {
  toast: (tone: ToastTone, message: string, title?: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const FeedbackContext = createContext<Feedback | null>(null);

/** Auto-dismiss: errors stay longer so they can be read; every toast has a close button and pauses on hover. */
export const TOAST_DURATION_MS: Record<ToastTone, number> = { success: 4000, info: 5000, warn: 7000, danger: 9000 };
const MAX_TOASTS = 4;
/** Length of the slide-out before a dismissed toast is removed (matches .lyx-anim-toast-out). */
export const TOAST_EXIT_MS = 160;

const TONE_STYLE: Record<ToastTone, { bar: string; icon: string; Icon: typeof Info }> = {
  success: { bar: "bg-lyx-ok", icon: "text-lyx-ok", Icon: CheckCircle2 },
  info: { bar: "bg-lyx-fg-subtle", icon: "text-lyx-fg-muted", Icon: Info },
  warn: { bar: "bg-lyx-warn", icon: "text-lyx-warn", Icon: AlertTriangle },
  danger: { bar: "bg-lyx-danger", icon: "text-lyx-danger", Icon: XCircle },
};

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Slide out first, then unmount (a timer rather than animationend, so it also leaves when animations are off).
  const close = useCallback(() => setLeaving(true), []);
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(onClose, TOAST_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onClose]);
  useEffect(() => {
    if (paused || leaving) return undefined;
    const timer = window.setTimeout(close, TOAST_DURATION_MS[toast.tone]);
    return () => window.clearTimeout(timer);
  }, [paused, leaving, toast.tone, close]);
  const style = TONE_STYLE[toast.tone];
  return (
    <div
      role={toast.tone === "danger" || toast.tone === "warn" ? "alert" : "status"}
      data-testid="toast"
      data-tone={toast.tone}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      data-leaving={leaving ? "true" : undefined}
      className={`${leaving ? "lyx-anim-toast-out" : "lyx-anim-toast"} pointer-events-auto relative flex w-[360px] max-w-full items-start gap-3 overflow-hidden rounded-[10px] border border-lyx-border bg-lyx-elevated py-3 pl-4 pr-9 shadow-xl`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${style.bar}`} aria-hidden="true" />
      <style.Icon size={18} className={`mt-[1px] shrink-0 ${style.icon} ${toast.tone === "success" ? "lyx-anim-check" : ""}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {toast.title ? <div className="text-[13px] font-semibold leading-5 text-lyx-fg">{toast.title}</div> : null}
        <div className="break-words text-[12.5px] leading-5 text-lyx-fg-muted">{toast.message}</div>
      </div>
      <button type="button" onClick={close} aria-label={t("feedback.dismiss")} className="absolute right-2 top-2 rounded-full p-1 text-lyx-fg-subtle transition-colors hover:bg-lyx-muted hover:text-lyx-fg">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * App-wide feedback: toasts (top right, stacked, auto-dismiss) and a promise-based confirmation that replaces the browser's
 * `window.confirm` / `alert` with the in-app dialog. Mount once above the routes; use `useToast()` / `useConfirm()`.
 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (value: boolean) => void } | null>(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((item) => item.id !== id)), []);
  const toast = useCallback((tone: ToastTone, message: string, title?: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current.filter((item) => !(item.tone === tone && item.message === message)), { id, tone, message, ...(title ? { title } : {}) }].slice(-MAX_TOASTS));
  }, []);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending((current) => {
    current?.resolve(false);
    return { options, resolve };
  })), []);

  const settle = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };

  const value = useMemo<Feedback>(() => ({ toast, confirm }), [toast, confirm]);
  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex flex-col items-end gap-2" aria-live="polite" data-testid="toast-region">
        {toasts.map((item) => <ToastItem key={item.id} toast={item} onClose={() => dismiss(item.id)} />)}
      </div>
      <ConfirmDialog
        open={pending !== null}
        title={pending?.options.title ?? ""}
        message={pending?.options.message ?? ""}
        {...(pending?.options.details ? { details: pending.options.details } : {})}
        {...(pending?.options.note ? { note: pending.options.note } : {})}
        tone={pending?.options.tone ?? "danger"}
        confirmLabel={pending?.options.confirmLabel ?? t("feedback.confirm")}
        cancelLabel={pending?.options.cancelLabel ?? t("common.cancel")}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </FeedbackContext.Provider>
  );
}

/** Used when a component renders outside the provider (isolated tests, embedded panels): toasts are dropped, confirmation falls back to the browser dialog. */
const FALLBACK: Feedback = {
  toast: () => undefined,
  confirm: async (options) => (typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(options.message) : false),
};

const useFeedback = (): Feedback => useContext(FeedbackContext) ?? FALLBACK;

/** `const toast = useToast(); toast.success("Đã lưu")`. */
export function useToast() {
  const { toast } = useFeedback();
  return useMemo(() => ({
    success: (message: string, title?: string) => toast("success", message, title),
    info: (message: string, title?: string) => toast("info", message, title),
    warn: (message: string, title?: string) => toast("warn", message, title),
    error: (message: string, title?: string) => toast("danger", message, title),
  }), [toast]);
}

/** `if (!(await useConfirm()({ title, message }))) return;` - resolves true on confirm, false on cancel/Escape/backdrop. */
export const useConfirm = () => useFeedback().confirm;
