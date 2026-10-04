import type { RenderEngine, RenderJobResponse, RenderRouteReason } from "@lyonix/contracts";

/** Engine a render account belongs to (`lyonix` = the system account of the internal FFmpeg engine). */
export const engineOfProvider = (provider: string): RenderEngine => (provider === "lyonix" ? "lyonix" : provider === "orshot" ? "orshot" : "creatomate");

export const engineNameKey = (engine: RenderEngine): string => `renderEngine.name.${engine}`;
export const routeReasonKey = (reason: RenderRouteReason): string => `renderEngine.reason.${reason}`;

/** The choices of the admin-only "Render engine" select. `auto` = let the Router decide (no `forceEngine` is sent). */
export const FORCE_ENGINE_CHOICES = ["auto", "lyonix", "creatomate", "orshot"] as const;
export type ForceEngineChoice = (typeof FORCE_ENGINE_CHOICES)[number];

/** Only admins may override the Router (the API rejects anyone else with FORBIDDEN). */
export const canForceEngine = (role: string | undefined): boolean => role === "admin";

export const forceEngineValue = (choice: ForceEngineChoice): RenderEngine | undefined => (choice === "auto" ? undefined : choice);

export type RenderEngineSummary = {
  engine: RenderEngine;
  reason: RenderRouteReason | null;
  isFallback: boolean;
  fallbackOfJobId: string | null;
  /** Internal render in flight: percent from the worker's progress messages. */
  internalProgress: number | null;
  qcFailedCodes: string[];
};

/** What the UI shows about the engine of a job; `null` for jobs created before VE2E-108 (no engine recorded). */
export function summarizeRenderEngine(job: Pick<RenderJobResponse, "engine" | "routeReason" | "fallbackOfJobId" | "status" | "progress" | "qcFailedCodes">): RenderEngineSummary | null {
  if (!job.engine) return null;
  const inFlight = job.status === "rendering" || job.status === "verifying";
  return {
    engine: job.engine,
    reason: job.routeReason ?? null,
    isFallback: Boolean(job.fallbackOfJobId),
    fallbackOfJobId: job.fallbackOfJobId ?? null,
    internalProgress: job.engine === "lyonix" && inFlight && typeof job.progress === "number" ? Math.max(0, Math.min(100, Math.round(job.progress))) : null,
    qcFailedCodes: job.qcFailedCodes ?? [],
  };
}
