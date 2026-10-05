import { useTranslation } from "react-i18next";
import type { MediaPlanSegmentDiagnostics } from "@lyonix/contracts";
import { parseSourceReason } from "./source-diagnostics";

/** VE2E-48: Apify/Pexels badge + fallback reason for one segment's diagnostics. */
export function SourceBadge({ diagnostic }: { diagnostic: Pick<MediaPlanSegmentDiagnostics, "sourceProvider" | "fallbackReason"> }) {
  const { t } = useTranslation();
  const reason = parseSourceReason(diagnostic.fallbackReason);
  if (!diagnostic.sourceProvider && !reason) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5" data-testid="source-badge">
      {diagnostic.sourceProvider ? (
        <span className="rounded bg-lyx-muted px-1.5 py-0.5 text-[10px] font-medium">{t(diagnostic.sourceProvider === "apify" ? "studioPro.sourceApify" : "studioPro.sourcePexels")}</span>
      ) : null}
      {reason ? <span className="text-[10px] text-lyx-fg-muted">{reason.key ? t(`studioPro.sourceReason_${reason.key}`, { detail: reason.detail }) : reason.raw}</span> : null}
    </span>
  );
}
