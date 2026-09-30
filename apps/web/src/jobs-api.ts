/** V00-10: per-model real generate-endpoint verification status + freshness, not just a listed model name. */
export type ApiProviderModelSnapshotEntry = { modelId: string; status: string; checkedAt: string; source: string; reason?: string; fresh: boolean };

export type ApiProvider = {
  id: string;
  name: string;
  provider: string;
  role: "content" | "tts" | "visual" | "render";
  scope: "personal" | "organization";
  status: "unverified" | "verified" | "failed";
  model: string;
  availableModels: string[];
  modelSnapshot: ApiProviderModelSnapshotEntry[];
  preferredModels: string[];
  modelCooldowns: Array<{ modelId: string; cooldownUntil: string }>;
  isFake: boolean;
  version: number;
};

export type ApiScript = {
  title: string;
  hook: string;
  body: string;
  cta: string;
  caption: string;
  scenes: Array<{ sceneId: string; narration: string; screenText: string; visualBrief: string; estimatedDurationMs?: number }>;
  version: number;
  approvedVersion: number | null;
};

export type ApiJobEvent = { id: string; at: string; kind: string; message: string };

/** VE2E-18: the job's real production step - see jobs.service.ts `PipelineStep` for the full contract. */
export type ApiPipelineStep = "script" | "produce" | "review" | "media" | "voice" | "timeline" | "render" | "done";

export type ApiJobRenderSummary = {
  id: string;
  status: string;
  resultUrl: string | null;
  snapshotUrl: string | null;
  renderDurationMs: number | null;
  costAmount: string | null;
  costCurrency: string | null;
};

export type ApiJob = {
  id: string;
  code: string;
  mode: "topic" | "long_video";
  topic: string;
  locale: string;
  status: string;
  currentStep: string;
  channelId: string;
  promptSpec: string;
  contentProviderAccountId: string;
  model: string;
  promptTemplateVersion?: string;
  schemaVersion?: string;
  providerConfigVersion?: number;
  lastNotice?: string | null;
  events?: ApiJobEvent[];
  captionPlan?: {
    scenes: Array<{
      sceneId: string;
      spokenText: string;
      visualIntent: string;
      durationHintMs: number;
      segments: Array<{ text: string; breakAfter: boolean }>;
    }>;
  } | null;
  handoff?: { status: string; relativePath: string; fingerprint: string; sceneCount: number } | null;
  pipelineStep?: ApiPipelineStep;
  studioProjectId?: string | null;
  render?: ApiJobRenderSummary | null;
  createdByUserId: string;
  createdByName?: string | null;
  updatedAt: string;
  script: ApiScript;
};

/**
 * VE2E-18: routes a job list/detail click to the page matching its real current step
 * (CR-JOBS-PIPELINE-STATUS-2026-09-26 AC #1/#3), instead of always `/jobs/:id/script`.
 * Falls back to the legacy script route when `pipelineStep` isn't present yet (older
 * cached response shape, or a job never bridged into Studio).
 */
export const routeForJob = (job: ApiJob): string => {
  switch (job.pipelineStep) {
    case "media":
      return `/jobs/${job.id}/studio?tab=media`;
    case "voice":
      return `/jobs/${job.id}/studio?tab=voice`;
    case "timeline":
      return `/jobs/${job.id}/studio`;
    case "render":
    case "done":
      return job.render?.id ? `/jobs/${job.id}/studio?renderJobId=${job.render.id}` : `/jobs/${job.id}/studio`;
    default:
      return `/jobs/${job.id}/script`;
  }
};

export const isJobDone = (job: ApiJob): boolean => job.pipelineStep === "done";
