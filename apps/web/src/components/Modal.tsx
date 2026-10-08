import type { ReactNode } from "react";
import { useEffect } from "react";

export function Modal({
  title,
  onClose,
  children,
  width = 480,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: 480 | 640;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="lyx-anim-backdrop fixed inset-0 z-50 flex items-center justify-center bg-[var(--lyx-overlay)] p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="lyx-anim-modal max-h-[90vh] overflow-auto rounded-[4px] border border-lyx-border bg-lyx-elevated p-4"
        style={{ width }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] leading-6 font-semibold">{title}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}
