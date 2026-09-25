import type { DashboardMetric } from "./types";

export function formatMetricDisplay(metric: DashboardMetric): {
  display: string;
  unavailable: boolean;
  reason: string | null;
} {
  if (metric.availability !== "available") {
    return {
      display: "unavailable",
      unavailable: true,
      reason: metric.reasonCode,
    };
  }
  if (metric.value === null) {
    return {
      display: "unavailable",
      unavailable: true,
      reason: metric.reasonCode ?? "not_returned",
    };
  }
  if (metric.currency) {
    return {
      display: `${metric.value} ${metric.currency}`,
      unavailable: false,
      reason: null,
    };
  }
  return { display: metric.value, unavailable: false, reason: null };
}

export function isAttentionStatus(status: string): boolean {
  return (
    status === "awaiting_staff_ack" ||
    status === "blocked_provider" ||
    status === "needs_attention"
  );
}
