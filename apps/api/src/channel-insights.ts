export const PERIOD_KEYS = ["1d", "7d", "30d", "90d"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const periodDurationMs: Record<PeriodKey, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export const INSIGHT_METRICS = ["followers", "likes", "views", "comments", "shares", "video_count", "revenue_from_views"] as const;
export type InsightMetric = (typeof INSIGHT_METRICS)[number];

export type RawMetricSnap = {
  metric: string;
  value: string | number | null;
  availability: string;
  reasonCode?: string | null;
  capturedAt: Date | string;
};

export const SCOPE_METRIC_CATALOG: Array<{ scope: string; metrics: string[] }> = [
  { scope: "user.info.basic", metrics: ["profile"] },
  { scope: "user.info.profile", metrics: ["profile"] },
  { scope: "user.info.stats", metrics: ["followers", "likes", "video_count"] },
  { scope: "video.list", metrics: ["views", "comments", "shares"] },
];

export const parsePeriod = (value: string | undefined): PeriodKey =>
  PERIOD_KEYS.includes(value as PeriodKey) ? (value as PeriodKey) : "7d";

const num = (value: string | number | null) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const pointsForMetric = (snaps: RawMetricSnap[], metric: string) =>
  snaps
    .filter((item) => item.metric === metric && item.availability === "available")
    .map((item) => ({ t: new Date(item.capturedAt).getTime(), v: num(item.value) }))
    .filter((item): item is { t: number; v: number } => item.v !== null)
    .sort((a, b) => a.t - b.t);

export const metricGrowth = (points: Array<{ t: number; v: number }>, from: number, now: number) => {
  if (!points.length) {
    return { current: null, baseline: null, delta: null, pct: null, missingBaseline: true as const };
  }
  const currentPoint = [...points].reverse().find((item) => item.t <= now) ?? points[points.length - 1];
  const baselinePoint = [...points].reverse().find((item) => item.t <= from);
  const current = currentPoint?.v ?? null;
  if (baselinePoint && currentPoint && baselinePoint.t !== currentPoint.t) {
    const delta = current! - baselinePoint.v;
    const pct = baselinePoint.v === 0 ? null : (delta / baselinePoint.v) * 100;
    return { current, baseline: baselinePoint.v, delta, pct, missingBaseline: false as const };
  }
  return { current, baseline: null, delta: null, pct: null, missingBaseline: true as const };
};

export const bucketSeries = (points: Array<{ t: number; v: number }>, from: number, now: number, period: PeriodKey) => {
  const buckets = period === "1d" ? 24 : period === "7d" ? 7 : period === "30d" ? 30 : 13;
  const span = Math.max(now - from, 1);
  const step = span / buckets;
  let last: number | null = points.filter((item) => item.t <= from).at(-1)?.v ?? null;
  const series: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < buckets; i += 1) {
    const start = from + step * i;
    const end = from + step * (i + 1);
    const inBucket = points.filter((item) => item.t > start && item.t <= end);
    if (inBucket.length) last = inBucket[inBucket.length - 1]?.v ?? last;
    if (last !== null) series.push({ t: Math.round(end), v: last });
  }
  return series;
};

export const grantedFromScopes = (scopes: string[]) => {
  const set = new Set(scopes);
  return SCOPE_METRIC_CATALOG.filter((item) => set.has(item.scope)).map((item) => ({
    scope: item.scope,
    granted: true,
    metrics: item.metrics,
  }));
};

export const buildChannelInsights = (input: {
  snaps: RawMetricSnap[];
  scopes: string[];
  period: PeriodKey;
  now?: number;
}) => {
  const now = input.now ?? Date.now();
  const from = now - periodDurationMs[input.period];
  const granted = grantedFromScopes(input.scopes);
  const metrics = INSIGHT_METRICS.map((metric) => {
    const latest = [...input.snaps]
      .filter((item) => item.metric === metric)
      .sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime())[0];
    const points = pointsForMetric(input.snaps, metric);
    const growth = metricGrowth(points, from, now);
    return {
      id: metric,
      availability: latest?.availability ?? (metric === "revenue_from_views" ? "not_granted" : "not_returned"),
      reasonCode: latest?.reasonCode ?? (metric === "revenue_from_views" ? "TIKTOK_SCOPE_NOT_GRANTED" : null),
      ...growth,
      series: bucketSeries(points, from, now, input.period),
      // Real samples only: the bucketed series above carries the last value forward,
      // which can draw a misleading flat trend when TikTok supplied just one sample.
      observations: points.filter((point) => point.t >= from && point.t <= now),
    };
  });
  return { period: input.period, from: new Date(from).toISOString(), to: new Date(now).toISOString(), granted, metrics };
};
