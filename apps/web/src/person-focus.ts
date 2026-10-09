import type { QualityGateDiagnostics } from "@lyonix/contracts";

/** VE2E-151: quality-gate warnings that say the video may not stay on the chosen person (script drift / too little media of the person). */
export const PERSON_FOCUS_WARNING_CODES = ["script_off_target", "person_media_low_confidence"] as const;

export const personFocusWarnings = (gate: QualityGateDiagnostics | null | undefined): QualityGateDiagnostics["warnings"] =>
  (gate?.warnings ?? []).filter((warning) => (PERSON_FOCUS_WARNING_CODES as readonly string[]).includes(warning.code));
