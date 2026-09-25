import { useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";

type Variant = "primary" | "secondary" | "danger" | "ghost";

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: "lyx-btn-primary",
    secondary: "lyx-btn-secondary",
    danger: "lyx-btn-danger",
    ghost: "lyx-btn-ghost",
  };
  return (
    <button type={type} className={`lyx-btn ${styles[variant]} ${className}`} {...props} />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[14px] font-medium">{label}</span>
      {children}
      {hint ? <span className="text-[12px] leading-4 text-lyx-fg-muted">{hint}</span> : null}
      {error ? <span className="text-[12px] leading-4 text-lyx-danger">{error}</span> : null}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`h-10 rounded-[4px] border border-lyx-border bg-lyx-muted px-3 text-lyx-fg placeholder:text-lyx-fg-subtle ${props.className ?? ""}`}
    />
  );
}

/** Password field with a show/hide toggle so users can verify what they typed. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? "text" : "password"}
        className={`h-10 w-full rounded-[4px] border border-lyx-border bg-lyx-muted px-3 pr-10 text-lyx-fg placeholder:text-lyx-fg-subtle ${props.className ?? ""}`}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t("common.hidePassword") : t("common.showPassword")}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-lyx-fg-muted hover:text-lyx-fg"
      >
        {visible ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.8 21.8 0 0 1 5.06-6.06M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.79 21.79 0 0 1-3.22 4.53" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`h-10 rounded-[4px] border border-lyx-border bg-lyx-muted px-3 text-lyx-fg ${props.className ?? ""}`}
    />
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`min-h-24 rounded-[4px] border border-lyx-border bg-lyx-muted px-3 py-2 text-lyx-fg placeholder:text-lyx-fg-subtle ${props.className ?? ""}`}
    />
  );
}
