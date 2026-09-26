export type PublicChannel = {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  authType: "oauth2" | "token" | "api_key" | "fixture";
  connected: boolean;
  lastSyncAt: string | null;
  grantedScopes: string[];
};

export type ChannelSnapshot = {
  metric: string;
  value: string | null;
  availability: string;
  reasonCode: string | null;
  capturedAt: string;
};

export type ChannelDetail = { channel: PublicChannel; snapshots: ChannelSnapshot[] };

export type InsightMetric = {
  id: string;
  availability: string;
  reasonCode: string | null;
  current: number | null;
  baseline: number | null;
  delta: number | null;
  pct: number | null;
  missingBaseline: boolean;
  series: Array<{ t: number; v: number }>;
};

export type ChannelInsights = {
  channel: PublicChannel;
  period: string;
  from: string;
  to: string;
  granted: Array<{ scope: string; granted: boolean; metrics: string[] }>;
  metrics: InsightMetric[];
};

export const PERIODS = ["1d", "7d", "30d", "90d"] as const;
export type PeriodKey = (typeof PERIODS)[number];

export const METRIC_COLORS: Record<string, string> = {
  followers: "#161616",
  likes: "#e11d48",
  views: "#2563eb",
  comments: "#ca8a04",
  shares: "#16a34a",
  video_count: "#7c3aed",
};

/** Hide TikTok open_id-looking handles (e.g. `-000YG…`); only show real @usernames. */
export function channelHandleLabel(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const raw = handle.replace(/^@/, "").trim();
  if (!raw || raw.startsWith("-")) return null;
  if (!/^[a-zA-Z0-9._]{2,24}$/.test(raw)) return null;
  return `@${raw}`;
}

export const formatCount = (value: number | null) =>
  value === null ? null : value.toLocaleString("vi-VN");

export const formatDelta = (delta: number | null, pct: number | null) => {
  if (delta === null) return null;
  const sign = delta > 0 ? "+" : "";
  const pctPart = pct === null ? "" : ` (${sign}${pct.toFixed(1)}%)`;
  return `${sign}${delta.toLocaleString("vi-VN")}${pctPart}`;
};
