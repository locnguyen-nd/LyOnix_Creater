import { Aperture, Clapperboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RenderEngine } from "@lyonix/contracts";

/**
 * V04-02: provider identity of a template - LyOnix Render / Creatomate / Orshot. The repo has no official provider logo and none is
 * hotlinked: LyOnix uses its own "LY" mark (as in the app shell), Creatomate / Orshot a neutral icon on the provider's accent colour,
 * always next to (or labelled with) the provider name. Fixed colours, so the mark reads the same in light and dark mode.
 */
const MARK_STYLE: Record<RenderEngine, string> = {
  lyonix: "bg-white text-neutral-900 ring-1 ring-black/15",
  creatomate: "bg-violet-600 text-white",
  orshot: "bg-orange-500 text-white",
};

/** The small square mark alone (decorative: the provider name is always shown or given as a label next to it). */
export function ProviderMark({ engine, size = 16 }: { engine: RenderEngine; size?: number }) {
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-[4px] ${MARK_STYLE[engine]}`} style={{ width: size, height: size }} data-provider-mark={engine}>
      {engine === "lyonix" ? (
        <span className="font-extrabold leading-none tracking-tight" style={{ fontSize: Math.round(size * 0.5) }}>LY</span>
      ) : engine === "creatomate" ? (
        <Clapperboard size={Math.round(size * 0.68)} strokeWidth={2.4} />
      ) : (
        <Aperture size={Math.round(size * 0.68)} strokeWidth={2.4} />
      )}
    </span>
  );
}

/**
 * Mark + provider name. `inline` for the card details and the preview panel (keeps the `engine-badge` test id of V04-01), `overlay`
 * for the top-left corner of a picture (dark translucent pill, readable on any thumbnail).
 */
export function ProviderBadge({ engine, variant = "inline", viaFallback = false }: { engine: RenderEngine; variant?: "inline" | "overlay"; viaFallback?: boolean }) {
  const { t } = useTranslation();
  const name = t(`templates.library.engineBadge.${engine}`);
  if (variant === "overlay") {
    return (
      <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-black/65 py-0.5 pl-0.5 pr-2 text-[10px] font-semibold text-white shadow-sm backdrop-blur-sm" data-testid="provider-badge" data-provider={engine}>
        <ProviderMark engine={engine} size={15} />
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex w-fit max-w-full items-center gap-1 rounded-[4px] border border-lyx-border bg-lyx-muted py-0.5 pl-0.5 pr-1.5 text-[10.5px] font-medium text-lyx-fg-muted" data-testid="engine-badge" data-provider={engine}>
      <ProviderMark engine={engine} size={14} />
      <span className="truncate">{name}</span>
      {viaFallback ? <span className="text-lyx-fg-subtle">· {t("templates.library.viaFallback")}</span> : null}
    </span>
  );
}
