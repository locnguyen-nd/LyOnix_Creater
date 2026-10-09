import type { QualityGateDiagnostics } from "@lyonix/contracts";

/** VE2E-151: quality-gate warnings that say the video may not stay on the chosen person (script drift / too little media of the person). */
export const PERSON_FOCUS_WARNING_CODES = ["script_off_target", "person_media_low_confidence"] as const;

export const personFocusWarnings = (gate: QualityGateDiagnostics | null | undefined): QualityGateDiagnostics["warnings"] =>
  (gate?.warnings ?? []).filter((warning) => (PERSON_FOCUS_WARNING_CODES as readonly string[]).includes(warning.code));

/** VE2E-152: "Không đủ footage sạch, đang dùng media có overlay nhẹ." - medium (overlay) sources taken because nothing clean was usable. */
export const overlayFallbackWarnings = (gate: QualityGateDiagnostics | null | undefined): QualityGateDiagnostics["warnings"] =>
  (gate?.warnings ?? []).filter((warning) => warning.code === "media_overlay_fallback");
