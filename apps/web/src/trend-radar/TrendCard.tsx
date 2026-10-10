import { Bookmark, BookmarkCheck, Check, ExternalLink, EyeOff, Sparkles, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TrendClusterResponse } from "@lyonix/contracts";
import { StatusPill } from "../components/chrome";
import { Button } from "../components/ui";
import { PROVIDER_SHORT, bandTone, metricEntries, timeAgo } from "./trend-ui";

/** "x phút / giờ / ngày trước" (or "không rõ thời gian đăng"). */
export function TimeAgo({ iso }: { iso: string | null }) {
  const { t } = useTranslation();
  const ago = timeAgo(iso);
  return <span>{ago ? t(`trendRadar.time.${ago.unit}`, { count: ago.value }) : t("trendRadar.time.unknown")}</span>;
}

/** Only the numbers a source returned; otherwise "Chưa có số liệu tương tác" (never a made-up 0). */
export function TrendMetrics({ metrics }: { metrics: TrendClusterResponse["metrics"] }) {
  const { t } = useTranslation();
  const entries = metricEntries(metrics);
  if (!metrics || entries.length === 0) return <p className="text-[12px] text-lyx-fg-muted" data-testid="trend-no-metrics">{t("trendRadar.card.noMetrics")}</p>;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        {entries.map((entry) => <span key={entry.key}><span className="text-lyx-fg-muted">{t(`trendRadar.metrics.${entry.key}`)}</span> <strong className="tabular-nums">{entry.value}</strong></span>)}
      </div>
      <p className="text-[11px] text-lyx-fg-subtle">{t("trendRadar.metrics.measuredAt", { time: new Date(metrics.measuredAt).toLocaleString() })}</p>
    </div>
  );
}

/** The score with every point it got and why (positive parts first, then penalties); the notes say what is NOT known. */
export function ScoreReasons({ cluster, limit }: { cluster: Pick<TrendClusterResponse, "components" | "notes">; limit?: number }) {
  const { t } = useTranslation();
  const parts = [...cluster.components].sort((a, b) => (b.points > 0 ? 1 : 0) - (a.points > 0 ? 1 : 0));
  const shown = limit ? parts.slice(0, limit) : parts;
  return (
    <ul className="flex flex-col gap-0.5 text-[12px] leading-5" data-testid="trend-score-reasons">
      {shown.map((part, index) => (
        <li key={`${part.key}-${index}`} className="flex gap-2">
          <span className={`w-14 shrink-0 text-right tabular-nums font-semibold ${part.points < 0 ? "text-lyx-danger" : part.points === 0 ? "text-lyx-fg-subtle" : ""}`}>{part.max > 0 ? `${part.points}/${part.max}` : part.points}</span>
          <span className="min-w-0"><span className="text-lyx-fg-muted">{t(`trendRadar.components.${part.key}`)}:</span> {part.reason}</span>
        </li>
      ))}
      {cluster.notes.map((note) => <li key={note} className="pl-16 text-lyx-fg-muted italic">{note}</li>)}
    </ul>
  );
}

export function TrendCard({
  cluster,
  busy,
  onStatus,
  onSave,
  onCreateVideo,
  onOpen,
}: {
  cluster: TrendClusterResponse;
  busy: boolean;
  onStatus: (status: "reviewed" | "rejected" | "new") => void;
  onSave: (saved: boolean) => void;
  onCreateVideo: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const assigned = cluster.assignments.map((assignment) => assignment.displayName).join(", ");
  return (
    <article data-testid="trend-card" className={`flex min-w-0 flex-col gap-3 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4 ${cluster.status === "rejected" ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={bandTone(cluster.band)}>{t(`trendRadar.band.${cluster.band}`)}</StatusPill>
        <span className="text-[20px] font-bold leading-none tabular-nums" aria-label={t("trendRadar.detail.scoreTitle", { score: cluster.score })}>{cluster.score}</span>
        {cluster.providers.map((provider) => <span key={provider} className="rounded-full border border-lyx-border px-2 py-0.5 text-[11px] text-lyx-fg-muted">{PROVIDER_SHORT[provider]}</span>)}
        {cluster.category ? <span className="text-[11px] text-lyx-fg-muted">{t(`trendRadar.category.${cluster.category}`, { defaultValue: cluster.category })}</span> : null}
        <span className="ml-auto text-[11px] text-lyx-fg-subtle"><TimeAgo iso={cluster.latestPublishedAt ?? cluster.lastSeenAt} /></span>
      </div>
      <div className="min-w-0">
        <h3 lang="ja" className="text-[15px] font-semibold leading-6">{cluster.title}</h3>
        <p className="mt-1 text-[12.5px] leading-5 text-lyx-fg-muted">{cluster.summaryVi ?? t("trendRadar.card.noSummary")}</p>
      </div>
      <div className="flex flex-wrap gap-2 text-[11px]">
        {cluster.status !== "new" ? <StatusPill tone={cluster.status === "used" ? "ok" : cluster.status === "rejected" ? "neutral" : "warn"}>{t(`trendRadar.status.${cluster.status}`)}</StatusPill> : null}
        {cluster.saved ? <StatusPill tone="ok">{t("trendRadar.card.saved")}</StatusPill> : null}
        {assigned ? <span className="text-lyx-fg-muted">{t("trendRadar.card.assigned", { names: assigned })}</span> : null}
      </div>
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-lyx-fg-subtle">{t("trendRadar.card.why")}</p>
        <ScoreReasons cluster={cluster} limit={4} />
      </div>
      {cluster.hashtags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {cluster.hashtags.slice(0, 8).map((tag) => <span key={tag} lang="ja" className="rounded bg-lyx-muted px-1.5 py-0.5 text-[11px]">#{tag}</span>)}
        </div>
      ) : null}
      <TrendMetrics metrics={cluster.metrics} />
      <div className="flex flex-col gap-1 text-[12px]">
        <span className="text-lyx-fg-muted">{t("trendRadar.card.sources", { count: cluster.itemCount })}</span>
        {cluster.topItems.slice(0, 3).map((item) => (
          <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1.5 hover:underline">
            <ExternalLink size={12} className="shrink-0" aria-hidden />
            <span className="shrink-0 text-lyx-fg-muted">{item.publisher ?? item.author ?? PROVIDER_SHORT[item.provider]}</span>
            <span lang="ja" className="truncate">{item.title}</span>
          </a>
        ))}
      </div>
      <div className="mt-auto flex flex-wrap gap-2 border-t border-lyx-border pt-3">
        <Button variant="secondary" disabled={busy || cluster.status === "reviewed"} onClick={() => onStatus("reviewed")}><Check size={14} aria-hidden />{t("trendRadar.card.markReviewed")}</Button>
        <Button variant="secondary" disabled={busy} aria-pressed={cluster.saved} onClick={() => onSave(!cluster.saved)}>{cluster.saved ? <BookmarkCheck size={14} aria-hidden /> : <Bookmark size={14} aria-hidden />}{cluster.saved ? t("trendRadar.card.saved") : t("trendRadar.card.save")}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => onStatus(cluster.status === "rejected" ? "new" : "rejected")}><EyeOff size={14} aria-hidden />{t("trendRadar.card.skip")}</Button>
        <Button variant="secondary" onClick={onOpen}><Sparkles size={14} aria-hidden />{t("trendRadar.card.details")}</Button>
        <Button onClick={onCreateVideo}><Video size={14} aria-hidden />{t("trendRadar.card.createVideo")}</Button>
      </div>
    </article>
  );
}
