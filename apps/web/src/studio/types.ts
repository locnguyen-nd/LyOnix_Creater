import type { Role, UiLocale } from "@lyonix/contracts";

export type ThemePref = "light" | "dark" | "system";

export type Me = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  preferences: { uiLocale: UiLocale; theme: ThemePref; timezone: string };
  grants: { teamIds: string[]; projectIds: string[]; channelIds: string[] };
  version: number;
};

export type AuthType = "oauth2" | "token" | "api_key";
export type PeriodKey = "1d" | "7d" | "30d" | "90d";

export type ChannelPulse = {
  views: number;
  likes: number;
  comments: number;
  series: number[];
};

export type Channel = {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string;
  authType: AuthType;
  connected: boolean;
  lastSyncAt: string | null;
  coverageLabel: string;
  projectId: string;
  teamId: string;
};

export type MetricAvailability =
  | "available"
  | "not_granted"
  | "unsupported"
  | "error"
  | "not_returned";

export type DashboardMetric = {
  id: "views" | "engagement" | "followerDelta" | "revenue_from_views";
  value: string | null;
  currency: string | null;
  availability: MetricAvailability;
  reasonCode: string | null;
  missingBaseline: boolean;
};

export type JobMode = "topic" | "long_video";

export type JobStatus =
  | "accepted"
  | "validating"
  | "transcribing"
  | "scripting"
  | "awaiting_staff_ack"
  | "producing"
  | "editing"
  | "rendering_vrew"
  | "verifying"
  | "completed"
  | "blocked_provider"
  | "needs_attention"
  | "failed"
  | "cancelled";

export type JobStepKey =
  | "intake"
  | "check"
  | "script"
  | "review"
  | "produce"
  | "edit"
  | "vrew"
  | "done";

export type JobEvent = {
  id: string;
  at: string;
  message: string;
};

export type ScriptScene = {
  sceneId: string;
  narration: string;
  screenText: string;
  visualBrief: string;
};

export type ScriptDraft = {
  hook: string;
  body: string;
  cta: string;
  title: string;
  caption: string;
  scenes: ScriptScene[];
  approvedVersion: number | null;
  version: number;
};

export type Job = {
  id: string;
  code: string;
  mode: JobMode;
  topic: string;
  channelId: string;
  projectId: string;
  status: JobStatus;
  currentStep: JobStepKey;
  providerAccountIds: {
    content: string;
    tts: string;
    visual: string;
    render: string;
  };
  updatedAt: string;
  events: JobEvent[];
  script: ScriptDraft;
  vrewUrl: string | null;
  contentLanguage: UiLocale;
  createdByUserId: string;
  promptSpec: string;
};

export type ProviderRole = "content" | "tts" | "visual" | "render";
export type ProviderScope = "personal" | "organization";

export type ProviderAccount = {
  id: string;
  name: string;
  provider: string;
  role: ProviderRole;
  scope: ProviderScope;
  ownerUserId: string;
  status: "unverified" | "verified" | "failed";
  model: string;
  quotaRemaining: number | null;
  quotaUnit: string | null;
  isFake: boolean;
  secretMasked: boolean;
  version: number;
};

export type AssetRow = {
  id: string;
  name: string;
  kind: "image" | "video" | "audio" | "file";
  jobId: string | null;
  sizeLabel: string;
  expiresAt: string;
  thumbUrl: string;
  previewUrl: string;
};

export type ArtifactRow = {
  id: string;
  jobId: string;
  channelId: string;
  durationLabel: string;
  qc: string;
  vrewUrl: string | null;
  renderStatus: string;
};

export type OrgUser = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  teamId: string;
  teamIds: string[];
  channelIds: string[];
  directChannelIds?: string[];
  disabled: boolean;
};

export type Team = {
  id: string;
  name: string;
  projectNames: string[];
  channelIds: string[];
  memberIds: string[];
};

export type StudioState = {
  users: Me[];
  passwords: Record<string, string>;
  channels: Channel[];
  jobs: Job[];
  providers: ProviderAccount[];
  assets: AssetRow[];
  artifacts: ArtifactRow[];
  orgUsers: OrgUser[];
  teams: Team[];
  metricsByChannel: Record<string, DashboardMetric[]>;
  periodStats: Record<string, Record<PeriodKey, ChannelPulse>>;
  orgTimezone: string;
};
