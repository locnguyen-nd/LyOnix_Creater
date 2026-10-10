/**
 * VE2E-158 Trend Radar - pure helpers of the web page (no DOM, no network): labels / tones, metric formatting that never shows a number a
 * provider did not return, the list filters as a query string, the angle suggestion for several people, and the topic handed to the
 * existing create-video page (headline + chosen angle + named source links - the same shape as a picked news item).
 */
import { suggestAngle } from "@lyonix/domain/trend-radar";
import type { TrendBandResponse, TrendClusterDetailResponse, TrendClusterResponse, TrendMetricsResponse, TrendProviderIdResponse, TrendRadarConfigResponse, TrendRadarConfigUpdateRequest, TrendRunStatusResponse, TrendSourceViewResponse } from "@lyonix/contracts";

export const TOPIC_MAX_CHARS = 400;

export const bandTone = (band: TrendBandResponse): "danger" | "warn" | "ok" | "neutral" => (band === "hot" ? "danger" : band === "rising" ? "warn" : band === "review" ? "ok" : "neutral");
export const runTone = (status: TrendRunStatusResponse): "ok" | "warn" | "danger" | "neutral" => (status === "completed" ? "ok" : status === "partial" ? "warn" : status === "failed" ? "danger" : "neutral");
export const sourceTone = (state: TrendSourceViewResponse["state"]): "ok" | "warn" | "danger" | "neutral" =>
  state === "ok" ? "ok" : state === "partial" || state === "rights_unconfirmed" || state === "not_connected" ? "warn" : state === "failed" || state === "quota_exhausted" ? "danger" : "neutral";

export const PROVIDER_SHORT: Record<TrendProviderIdResponse, string> = { yahoo_news: "Yahoo!ニュース", tiktok: "TikTok", manual: "URL thủ công" };

/** 1234 -> "1.2K"; null -> null (not reported: the UI says so, it never shows 0). */
export const compactNumber = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

/** Only the metrics a source really returned, as label/value pairs; empty = "Chưa có số liệu tương tác". */
export function metricEntries(metrics: TrendMetricsResponse | null): Array<{ key: "views" | "likes" | "comments" | "shares"; value: string }> {
  if (!metrics) return [];
  return (["views", "likes", "comments", "shares"] as const).flatMap((key) => {
    const value = compactNumber(metrics[key]);
    return value === null ? [] : [{ key, value }];
  });
}

export type TrendListFilters = { provider: string; sinceHours: string; category: string; minScore: string; status: string; band: string; q: string; assigneeId: string; saved: boolean };
export const EMPTY_FILTERS: TrendListFilters = { provider: "", sinceHours: "48", category: "", minScore: "", status: "", band: "", q: "", assigneeId: "", saved: false };

export function filtersQuery(filters: TrendListFilters, page: { limit: number; offset: number }): string {
  const params = new URLSearchParams();
  for (const key of ["provider", "sinceHours", "category", "minScore", "status", "band", "assigneeId"] as const) if (filters[key]) params.set(key, filters[key]);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.saved) params.set("saved", "1");
  params.set("limit", String(page.limit));
  params.set("offset", String(page.offset));
  return params.toString();
}

/** Angles of a topic: the AI's three when analysed, nothing otherwise (the user can then type their own). */
export const anglesOf = (cluster: Pick<TrendClusterDetailResponse, "analysis">): Array<{ title: string; approach: string }> => cluster.analysis?.angles ?? [];

/** Angles already taken by OTHER people on this topic, and the one to suggest next (different videos, not the same one twice). */
export function angleChoice(cluster: Pick<TrendClusterResponse, "assignments"> & Pick<TrendClusterDetailResponse, "analysis">, userId: string): { taken: Map<number, string>; suggested: number | null } {
  const taken = new Map<number, string>();
  for (const assignment of cluster.assignments) if (assignment.userId !== userId && assignment.angleIndex !== null) taken.set(assignment.angleIndex, assignment.displayName);
  return { taken, suggested: suggestAngle(anglesOf(cluster).length, [...taken.keys()]) };
}

/**
 * The topic the create-video page starts from: the headline (Japanese), the chosen angle, then the named sources with their links (at most 2,
 * always kept). Only what the sources published + the chosen angle - nothing invented; the script itself is written by the existing flow.
 */
export function composeTrendTopic(cluster: Pick<TrendClusterDetailResponse, "title" | "items" | "analysis">, angle: { title: string; approach: string } | null): string {
  const headline = cluster.analysis?.titleJa || cluster.title;
  const sources = cluster.items.slice(0, 2).map((item) => `Source: ${item.publisher ?? item.author ?? PROVIDER_SHORT[item.provider]} - ${item.url}`);
  const angleLine = angle ? `Angle: ${angle.title} - ${angle.approach}` : null;
  const join = (parts: Array<string | null>) => parts.filter(Boolean).join("\n\n");
  const full = join([headline, angleLine, ...sources]);
  if ([...full].length <= TOPIC_MAX_CHARS) return full;
  const fixed = join([headline, ...sources]);
  const room = TOPIC_MAX_CHARS - [...fixed].length - 2;
  const trimmedAngle = angleLine && room > 20 ? [...angleLine].slice(0, room - 1).join("") + "…" : null;
  const withAngle = join([headline, trimmedAngle, ...sources]);
  if ([...withAngle].length <= TOPIC_MAX_CHARS) return withAngle;
  return join([[...headline].slice(0, 120).join(""), sources[0] ?? null]);
}

/** `/jobs/new` link of a topic (the page loads the topic, fills the form and links the video back after the user creates it). */
export const createVideoLink = (clusterId: string, angleIndex: number | null): string => `/jobs/new?entry=auto&trend=${encodeURIComponent(clusterId)}${angleIndex === null ? "" : `&angle=${angleIndex}`}`;

/** "x phút / giờ / ngày trước" from an ISO time. */
export function timeAgo(iso: string | null, now = Date.now()): { value: number; unit: "minute" | "hour" | "day" } | null {
  if (!iso) return null;
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return { value: minutes, unit: "minute" };
  if (minutes < 48 * 60) return { value: Math.round(minutes / 60), unit: "hour" };
  return { value: Math.round(minutes / 1440), unit: "day" };
}

/** One keyword / hashtag per line (commas too); blanks and repeats dropped, a leading "#" removed. */
export const linesOf = (text: string): string[] => [...new Set(text.split(/[\n,、]+/).map((line) => line.trim().replace(/^#+/, "").trim()).filter(Boolean))];

/** The settings form: the editable config fields + the two word lists as text. */
export type TrendConfigDraft = TrendRadarConfigResponse & { keywordsText: string; hashtagsText: string };

/** What "Lưu cấu hình" sends: only editable fields (the rights flag, account lists and usage are the server's, never sent back). */
export function configPatch(draft: TrendConfigDraft): TrendRadarConfigUpdateRequest {
  return {
    yahooEnabled: draft.yahooEnabled,
    yahooCategories: draft.yahooCategories,
    tiktokEnabled: draft.tiktokEnabled,
    tiktokAccountId: draft.tiktokAccountId,
    keywords: linesOf(draft.keywordsText),
    hashtags: linesOf(draft.hashtagsText),
    categories: draft.categories,
    windowHours: draft.windowHours,
    scheduleEnabled: draft.scheduleEnabled,
    intervalMinutes: draft.intervalMinutes,
    thresholds: draft.thresholds,
    notifyMinScore: draft.notifyMinScore,
    tiktokMaxQueries: draft.tiktokMaxQueries,
    tiktokResultsPerQuery: draft.tiktokResultsPerQuery,
    tiktokMinViews: draft.tiktokMinViews,
    analysisAccountId: draft.analysisAccountId,
    autoAnalysisPerDay: draft.autoAnalysisPerDay,
    analysisPerDay: draft.analysisPerDay,
  };
}
