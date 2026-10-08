import { useId, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";

/** The accent of a create-video card: its top strip, icon tile, step chip and chosen chips (styles.css "Accent sections"). */
export type SectionAccent = "blue" | "green" | "violet" | "amber" | "rose" | "cta";

/** Square tinted tile holding a section's icon (lifts a little when its card is hovered). */
function IconTile({ icon, size = "md" }: { icon: ReactNode; size?: "sm" | "md" }) {
  return (
    <span className={`lyx-section-icon flex shrink-0 items-center justify-center ${size === "md" ? "h-9 w-9 rounded-[10px]" : "h-7 w-7 rounded-[8px]"}`} aria-hidden>
      {icon}
    </span>
  );
}

/**
 * One card of the create-video page (Nội dung / Video / Phong cách). Its chip says "Bước N" until the card holds what it needs,
 * then turns into a green "Xong" with a short pop.
 */
export function FormSection({ step, title, subtitle, icon, accent, complete = false, stepLabel, doneLabel, testId, children }: {
  step: number;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  accent: SectionAccent;
  complete?: boolean;
  /** e.g. "Bước 1" */
  stepLabel: string;
  doneLabel: string;
  testId?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      className={`lyx-section lyx-accent-${accent} lyx-panel-hover flex min-w-0 flex-col gap-4 rounded-xl border border-lyx-border bg-lyx-bg p-4 sm:p-5`}
      aria-labelledby={id}
      data-testid={testId}
      data-step={step}
      data-complete={complete ? "true" : "false"}
    >
      <header className="flex items-start gap-3">
        <IconTile icon={icon} />
        <div className="min-w-0 flex-1">
          <h2 id={id} className="text-[15px] font-semibold leading-6">{title}</h2>
          {subtitle ? <p className="text-[12.5px] leading-5 text-lyx-fg-muted">{subtitle}</p> : null}
        </div>
        {complete ? (
          <span key="done" className="lyx-anim-pop inline-flex shrink-0 items-center gap-1 rounded-full bg-lyx-ok-bg px-2 py-0.5 text-[11px] font-semibold text-lyx-ok" data-testid="section-status">
            <Check size={12} strokeWidth={3} aria-hidden /> {doneLabel}
          </span>
        ) : (
          <span key="step" className="lyx-accent-chip lyx-fade shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold" data-testid="section-status">{stepLabel}</span>
        )}
      </header>
      {children}
    </section>
  );
}

/** A labelled group of buttons (chips / segmented control) - a div, not a <label>, so the label never clicks the first button. */
export function ChoiceField({ label, hint, icon, children }: { label: string; hint?: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className={`text-[13px] font-medium ${icon ? "inline-flex items-center gap-1.5" : ""}`}>{icon}{label}</span>
      {children}
      {hint ? <span className="text-[12px] leading-4 text-lyx-fg-muted">{hint}</span> : null}
    </div>
  );
}

/** The small coloured icon before a field label, in its section's accent. */
export function LabelIcon({ icon }: { icon: ReactNode }) {
  return <span className="lyx-accent-text inline-flex" aria-hidden>{icon}</span>;
}

/**
 * Collapsible technical settings (accounts, render options). `open` is controlled: the page keeps it open while a required
 * choice inside is still missing, so a required field is never hidden from the browser's validation.
 */
export function AdvancedSection({ title, subtitle, icon, open, onToggle, attention, children }: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Short badge text when something inside needs a choice. */
  attention?: string | null;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="lyx-section lyx-accent-amber group lyx-panel-hover min-w-0 rounded-xl border border-lyx-border bg-lyx-bg"
      data-testid="advanced-settings"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3.5 sm:px-5 [&::-webkit-details-marker]:hidden">
        <IconTile icon={icon} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">{title}</span>
          <span className="block text-[12px] text-lyx-fg-muted">{subtitle}</span>
        </span>
        {attention ? <span className="lyx-anim-pop shrink-0 rounded-full bg-lyx-warn-bg px-2 py-0.5 text-[11px] font-semibold text-lyx-warn">{attention}</span> : null}
        <ChevronDown size={16} className="shrink-0 text-lyx-fg-muted transition-transform duration-200 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="lyx-enter flex flex-col gap-4 border-t border-lyx-border px-4 py-4 sm:px-5">{children}</div>
    </details>
  );
}

/** A small card in the side / bottom of the page with an accent strip and an icon tile in its header. */
export function AccentCard({ accent, icon, title, subtitle, testId, className = "", children }: {
  accent: SectionAccent;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  testId?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`lyx-section lyx-accent-${accent} flex flex-col gap-3 rounded-xl border border-lyx-border bg-lyx-bg p-4 ${className}`} data-testid={testId}>
      <div className="flex items-center gap-2.5">
        <IconTile icon={icon} size="sm" />
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold leading-5">{title}</p>
          {subtitle ? <p className="text-[12px] leading-5 text-lyx-fg-muted">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

/** One line of the summary card: a coloured icon (its section's accent), the label, and the value fading in when it changes. */
export function SummaryRow({ label, value, icon, accent, empty = false }: { label: string; value: string; icon: ReactNode; accent: SectionAccent; empty?: boolean }) {
  return (
    <div className={`lyx-accent-${accent} flex items-center justify-between gap-3 py-1.5 text-[12.5px]`}>
      <dt className="inline-flex shrink-0 items-center gap-2 text-lyx-fg-muted">
        <span className="lyx-accent-text inline-flex" aria-hidden>{icon}</span>
        {label}
      </dt>
      <dd key={value} className={`lyx-fade min-w-0 truncate text-right font-medium ${empty ? "text-lyx-fg-subtle" : ""}`} title={value}>{value}</dd>
    </div>
  );
}

/**
 * Segmented progress of the create-video cards: one segment per card in that card's colour, filling (transform only) when the
 * card is done. Display only.
 */
export function ProgressStrip({ title, label, steps }: { title: string; label: string; steps: ReadonlyArray<{ name: string; accent: SectionAccent; done: boolean }> }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="create-progress">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-bold uppercase tracking-wide text-lyx-fg-subtle">{title}</span>
        <span key={label} className="lyx-fade font-semibold text-lyx-fg-muted">{label}</span>
      </div>
      <ul className="flex gap-1.5">
        {steps.map((step) => (
          <li key={step.name} title={step.name} aria-label={step.name} data-done={step.done ? "true" : "false"} className={`lyx-accent-${step.accent} lyx-progress-segment relative h-1.5 flex-1 overflow-hidden rounded-full bg-lyx-neutral-bg`}>
            <span className="lyx-progress-fill absolute inset-0 rounded-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One line of "Kiểm tra trước khi chạy": a check or a cross (popping when it changes), the label, and an optional action. */
export function ReadyItem({ ok, label, action }: { ok: boolean; label: string; action?: ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-[12.5px]" data-ready={ok ? "true" : "false"}>
      <span key={ok ? "ok" : "missing"} className={`lyx-anim-pop flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${ok ? "bg-lyx-ok-bg text-lyx-ok" : "bg-lyx-danger-bg text-lyx-danger"}`} aria-hidden>
        {ok ? <Check size={10} strokeWidth={3} /> : <X size={10} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">{label}</span>
      {ok ? null : action}
    </li>
  );
}
