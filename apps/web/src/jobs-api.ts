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
  createdByUserId: string;
  updatedAt: string;
  script: ApiScript;
};
