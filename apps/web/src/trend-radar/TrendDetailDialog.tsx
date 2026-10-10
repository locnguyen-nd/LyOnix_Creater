import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Sparkles, Video } from "lucide-react";
import type { TrendAnalyzeResponse, TrendClusterDetailResponse } from "@lyonix/contracts";
import { ApiError } from "../api";
import { Banner, SkeletonRows, StatusPill } from "../components/chrome";
import { Modal } from "../components/Modal";
import { Button } from "../components/ui";
import { analyzeTrendCluster, getTrendCluster } from "../trend-radar-api";
import { ScoreReasons, TimeAgo, TrendMetrics } from "./TrendCard";
import { PROVIDER_SHORT, bandTone } from "./trend-ui";

const STATUS_KEY = { failed: "analysisFailed", quota: "analysisQuota", limit: "analysisLimit", not_configured: "analysisNotConfigured" } as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-lyx-fg-subtle">{title}</h3>
      {children}
    </section>
  );
}

/**
 * VE2E-158: one topic in full - every score part with its reason, the sources with what each one really returned, and the AI analysis.
 * "Phân tích" is the only AI call here and it is the user's click (1 call, counted in the daily budget); the facts are kept apart from the
 * AI's creative suggestions.
 */
export function TrendDetailDialog({ clusterId, onClose, onChanged, onCreateVideo }: { clusterId: string; onClose: () => void; onChanged: (cluster: TrendClusterDetailResponse) => void; onCreateVideo: (cluster: TrendClusterDetailResponse) => void }) {
  const { t } = useTranslation();
  const [cluster, setCluster] = useState<TrendClusterDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [outcome, setOutcome] = useState<Pick<TrendAnalyzeResponse, "status" | "message" | "retryAt"> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTrendCluster(clusterId)
      .then((next) => { if (!cancelled) setCluster(next); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : t("common.error")); });
    return () => { cancelled = true; };
  }, [clusterId, t]);

  const analyze = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const result = await analyzeTrendCluster(clusterId);
      setCluster(result.cluster);
      setOutcome({ status: result.status, message: result.message, retryAt: result.retryAt });
      onChanged(result.cluster);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setAnalyzing(false);
    }
  };

  const analysis = cluster?.analysis ?? null;
  const failedStatus = outcome && outcome.status !== "done" ? outcome.status : cluster && cluster.analysisStatus !== "none" && cluster.analysisStatus !== "done" ? cluster.analysisStatus : null;
  const failedMessage = outcome && outcome.status !== "done" ? outcome.message : cluster?.analysisError ?? null;

  return (
    <Modal title={cluster?.title ?? t("common.loading")} onClose={onClose} width={640}>
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {!cluster ? <SkeletonRows label={t("common.loading")} count={4} /> : (
        <div className="flex flex-col gap-5" data-testid="trend-detail">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={bandTone(cluster.band)}>{t(`trendRadar.band.${cluster.band}`)}</StatusPill>
            <strong className="text-[15px]">{t("trendRadar.detail.scoreTitle", { score: cluster.score })}</strong>
            <span className="ml-auto flex gap-2">
              <Button onClick={() => onCreateVideo(cluster)}><Video size={14} aria-hidden />{t("trendRadar.card.createVideo")}</Button>
            </span>
          </div>
          <ScoreReasons cluster={cluster} />
          {cluster.history.length > 1 ? (
            <Section title={t("trendRadar.detail.history")}>
              <p className="text-[12px] text-lyx-fg-muted tabular-nums">
                {cluster.history.slice(-8).map((point) => `${new Date(point.measuredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${point.score}`).join("  →  ")}
              </p>
            </Section>
          ) : null}

          <Section title={t("trendRadar.detail.sourcesTitle", { count: cluster.items.length })}>
            <ul className="flex flex-col gap-3">
              {cluster.items.map((item) => (
                <li key={item.id} className="flex flex-col gap-1 rounded-[var(--lyx-radius)] border border-lyx-border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-lyx-fg-muted">
                    <span className="font-semibold text-lyx-fg">{item.publisher ?? item.author ?? PROVIDER_SHORT[item.provider]}</span>
                    <span>{PROVIDER_SHORT[item.provider]}</span>
                    <span>·</span>
                    <TimeAgo iso={item.publishedAt} />
                    <span>·</span>
                    <span>{t(`trendRadar.completeness.${item.completeness}`)}</span>
                  </div>
                  <a href={item.url} target="_blank" rel="noopener noreferrer" lang="ja" className="inline-flex items-start gap-1.5 text-[13px] font-medium hover:underline">
                    <ExternalLink size={13} className="mt-1 shrink-0" aria-hidden />{item.title}
                  </a>
                  {item.excerpt ? <p lang="ja" className="text-[12px] text-lyx-fg-muted">{item.excerpt}</p> : null}
                  {item.hashtags.length ? <p lang="ja" className="text-[11px] text-lyx-fg-muted">{item.hashtags.map((tag) => `#${tag}`).join(" ")}</p> : null}
                  <TrendMetrics metrics={item.metrics} />
                </li>
              ))}
            </ul>
          </Section>

          <Section title={t("trendRadar.detail.analysisTitle")}>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" loading={analyzing} onClick={() => void analyze()}><Sparkles size={14} aria-hidden />{analyzing ? t("trendRadar.detail.analyzing") : analysis ? t("trendRadar.detail.reanalyze") : t("trendRadar.detail.analyze")}</Button>
              {analysis && cluster.analysisModel ? <span className="text-[11px] text-lyx-fg-subtle">{t("trendRadar.detail.model", { model: cluster.analysisModel, time: cluster.analyzedAt ? new Date(cluster.analyzedAt).toLocaleString() : "" })}</span> : null}
            </div>
            {failedStatus ? (
              <Banner variant={failedStatus === "failed" ? "danger" : "warn"}>
                <strong>{t(`trendRadar.detail.${STATUS_KEY[failedStatus]}`)}</strong>
                {failedMessage ? <> - {failedMessage}</> : null}
                {outcome?.retryAt ? <> ({new Date(outcome.retryAt).toLocaleString()})</> : null}
              </Banner>
            ) : null}
            {!analysis ? <p className="text-[12.5px] text-lyx-fg-muted">{t("trendRadar.detail.analysisNone")}</p> : (
              <div className="flex flex-col gap-4 text-[13px] leading-6" data-testid="trend-analysis">
                <p className="text-[12px] text-lyx-fg-muted">{t("trendRadar.detail.aiDisclaimer")}</p>
                <div>
                  <p lang="ja" className="font-semibold">{analysis.titleJa}</p>
                  <p className="text-lyx-fg-muted">{analysis.titleVi}</p>
                  <p className="mt-1">{analysis.summaryVi}</p>
                </div>
                <Section title={t("trendRadar.detail.facts")}>
                  <ul className="list-disc pl-5">{analysis.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
                </Section>
                <Section title={t("trendRadar.detail.why")}><p>{analysis.whyInteresting}</p></Section>
                <Section title={t("trendRadar.detail.angles")}>
                  <ol className="list-decimal pl-5">{analysis.angles.map((angle) => <li key={angle.title}><strong>{angle.title}</strong> - {angle.approach}</li>)}</ol>
                </Section>
                <Section title={t("trendRadar.detail.hooks")}>
                  <ul className="list-disc pl-5" lang="ja">{analysis.hooksJa.map((hook) => <li key={hook}>{hook}</li>)}</ul>
                </Section>
                <Section title={t("trendRadar.detail.suggestedTitle")}><p lang="ja">{analysis.suggestedTitleJa}</p></Section>
                <Section title={t("trendRadar.detail.caption")}><p lang="ja" className="whitespace-pre-line">{analysis.captionJa}</p></Section>
                <Section title={t("trendRadar.detail.hashtags")}><p lang="ja">{analysis.hashtags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}</p></Section>
                <Section title={t("trendRadar.detail.reliability")}>
                  <p><StatusPill tone={analysis.reliability.level === "high" ? "ok" : analysis.reliability.level === "medium" ? "warn" : "danger"}>{t(`trendRadar.reliability.${analysis.reliability.level}`)}</StatusPill> {analysis.reliability.reason}</p>
                </Section>
                {analysis.warnings.length ? (
                  <Section title={t("trendRadar.detail.warnings")}><ul className="list-disc pl-5">{analysis.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Section>
                ) : null}
                <Section title={t("trendRadar.detail.dataNote")}><p className="text-lyx-fg-muted">{analysis.dataNote}</p></Section>
              </div>
            )}
          </Section>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>{t("trendRadar.detail.close")}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
