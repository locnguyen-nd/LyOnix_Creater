import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Hourglass } from "lucide-react";
import type { QueueStateFields, QueueSummaryResponse, WorkflowRunStatus } from "@lyonix/contracts";
import { fetchQueueSummary } from "../video-productions-api";
import { formatWaited, isQueueSaturated, isWaitingInQueue } from "../queue-display";

/** Re-renders every `intervalMs` so a "waited 3m 05s" label keeps counting without refetching. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** "Waiting #N · waited 3m 05s" for a run that is still queued; nothing otherwise. */
export function QueueBadge({ status, queue }: { status: WorkflowRunStatus; queue: QueueStateFields | null | undefined }) {
  const { t } = useTranslation();
  const now = useNow();
  if (!queue || !isWaitingInQueue(status, queue)) return null;
  const waited = formatWaited(queue.queuedAt, now);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-lyx-border bg-lyx-muted px-2 py-0.5 text-[11px] tabular-nums" role="status">
      <Hourglass size={11} aria-hidden="true" />
      {t("videoProductions.queueWaiting", { position: queue.queuePosition })}
      {waited ? <span className="text-lyx-fg-muted"> · {t("videoProductions.queueWaited", { time: waited })}</span> : null}
    </span>
  );
}

/** Running k/limit · n waiting for each queue (workflow / render / media), refreshed on an interval. Hidden if the endpoint is unavailable. */
export function QueueSummaryBar({ intervalMs = 5000 }: { intervalMs?: number }) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<QueueSummaryResponse[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetchQueueSummary()
        .then((rows) => { if (!cancelled) setSummary(rows); })
        .catch(() => { if (!cancelled) setSummary(null); });
    };
    load();
    const timer = setInterval(load, intervalMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [intervalMs]);
  if (!summary || summary.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-lyx-fg-muted" aria-label={t("videoProductions.queueSummaryTitle")}>
      <span className="font-medium text-lyx-fg">{t("videoProductions.queueSummaryTitle")}</span>
      {summary.map((item) => (
        <span key={item.kind} className={isQueueSaturated(item) ? "text-lyx-warn" : undefined}>
          {t(`videoProductions.queueKind.${item.kind}`)}: {t("videoProductions.queueSummary", { active: item.active, limit: item.limit, queued: item.queued })}
        </span>
      ))}
    </div>
  );
}
