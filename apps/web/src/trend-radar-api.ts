import type {
  NotificationListResponse,
  TrendAnalyzeResponse,
  TrendAssigneeResponse,
  TrendClusterDetailResponse,
  TrendClusterListResponse,
  TrendDuplicateResponse,
  TrendImportResponse,
  TrendOverviewResponse,
  TrendRadarConfigResponse,
  TrendRadarConfigUpdateRequest,
  TrendRunResponse,
} from "@lyonix/contracts";
import { api, csrfHeaders } from "./api";

/** VE2E-158 Trend Radar + notifications API (the server holds every key; nothing secret reaches the browser). */

const json = async (method: string, body?: unknown): Promise<RequestInit> => ({ method, headers: await csrfHeaders(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const getTrendOverview = () => api<TrendOverviewResponse>("/trend-radar/overview");
export const listTrendClusters = (query: string) => api<TrendClusterListResponse>(`/trend-radar/clusters?${query}`);
export const getTrendCluster = (id: string) => api<TrendClusterDetailResponse>(`/trend-radar/clusters/${encodeURIComponent(id)}`);
export const updateTrendCluster = async (id: string, patch: { status?: string; saved?: boolean }) => api<TrendClusterDetailResponse>(`/trend-radar/clusters/${encodeURIComponent(id)}`, await json("PATCH", patch));
export const analyzeTrendCluster = async (id: string) => api<TrendAnalyzeResponse>(`/trend-radar/clusters/${encodeURIComponent(id)}/analyze`, await json("POST", {}));
export const trendDuplicates = (id: string) => api<TrendDuplicateResponse[]>(`/trend-radar/clusters/${encodeURIComponent(id)}/duplicates`);
export const assignTrendCluster = async (id: string, body: { userId?: string; angleIndex?: number | null; angleTitle?: string | null; remove?: boolean }) =>
  api<TrendClusterDetailResponse>(`/trend-radar/clusters/${encodeURIComponent(id)}/assignment`, await json("PUT", body));
export const linkTrendProduction = async (id: string, body: { kind: "job" | "video_production"; productionId: string; angleIndex: number | null }) =>
  api<TrendClusterDetailResponse>(`/trend-radar/clusters/${encodeURIComponent(id)}/productions`, await json("POST", body));
export const listTrendAssignees = () => api<TrendAssigneeResponse[]>("/trend-radar/assignees");
export const runTrendRadarNow = async () => api<{ run: TrendRunResponse | null; started: boolean; reason: string }>("/trend-radar/runs", await json("POST", {}));
export const listTrendRuns = (limit = 20) => api<TrendRunResponse[]>(`/trend-radar/runs?limit=${limit}`);
export const importTrendUrl = async (url: string) => api<TrendImportResponse>("/trend-radar/import", await json("POST", { url }));
export const getTrendConfig = () => api<TrendRadarConfigResponse>("/trend-radar/config");
export const updateTrendConfig = async (patch: TrendRadarConfigUpdateRequest) => api<TrendRadarConfigResponse>("/trend-radar/config", await json("PATCH", patch));
export const testTrendSource = async (provider: "yahoo_news" | "tiktok") => api<{ provider: string; ok: boolean; state: string; message: string }>(`/trend-radar/sources/${provider}/test`, await json("POST", {}));

export const listNotifications = (unreadOnly = false) => api<NotificationListResponse>(`/notifications?limit=30${unreadOnly ? "&unread=1" : ""}`);
export const unreadNotificationCount = () => api<{ unread: number }>("/notifications/unread-count");
export const markNotificationRead = async (id: string) => api<{ id: string }>(`/notifications/${encodeURIComponent(id)}/read`, await json("POST", {}));
export const markAllNotificationsRead = async () => api<{ marked: number }>("/notifications/read-all", await json("POST", {}));
