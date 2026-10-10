import { useTranslation } from "react-i18next";
import type { TrendRunResponse } from "@lyonix/contracts";
import { EmptyState, SkeletonRows, StatusPill } from "../components/chrome";
import { PROVIDER_SHORT, runTone, sourceTone } from "./trend-ui";

/** VE2E-158 run history: every run with its counts and, per source, its own status and error (one source failing never hides the others). */
export function TrendRunsPanel({ runs }: { runs: TrendRunResponse[] | null }) {
  const { t } = useTranslation();
  if (runs === null) return <SkeletonRows label={t("common.loading")} count={5} />;
  if (runs.length === 0) return <EmptyState title={t("trendRadar.history.empty")} />;
  return (
    <ul className="flex flex-col gap-3" data-testid="trend-runs">
      {runs.map((run) => {
        const seconds = run.startedAt && run.finishedAt ? Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)) : null;
        return (
          <li key={run.id} className="flex flex-col gap-2 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-3.5 text-[12.5px]">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={runTone(run.status)}>{t(`trendRadar.history.status.${run.status}`)}</StatusPill>
              <span className="font-semibold">{t(`trendRadar.history.trigger.${run.trigger}`)}</span>
              <span className="text-lyx-fg-muted">{new Date(run.startedAt ?? run.createdAt).toLocaleString()}</span>
              {seconds !== null ? <span className="text-lyx-fg-subtle">{t("trendRadar.history.duration", { seconds })}</span> : null}
            </div>
            <p className="text-lyx-fg-muted tabular-nums">
              {t("trendRadar.history.counts", { fetched: run.fetchedCount, created: run.newCount, duplicates: run.duplicateCount, notified: run.notifiedCount, analysed: run.analysedCount })}
            </p>
            {run.error ? <p className="text-lyx-danger">{run.error.code}: {run.error.message}</p> : null}
            {run.sources.length ? (
              <ul className="flex flex-col gap-1 border-t border-lyx-border pt-2">
                {run.sources.map((source) => {
                  const unitErrors = source.units.filter((unit) => unit.error);
                  return (
                    <li key={source.provider} className="flex flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="w-28 font-medium">{PROVIDER_SHORT[source.provider]}</span>
                        <StatusPill tone={sourceTone(source.status)}>{t(`trendRadar.sources.state.${source.status}`)}</StatusPill>
                        <span className="text-lyx-fg-muted tabular-nums">{source.fetched} / {source.new} / {source.duplicates}</span>
                      </div>
                      {source.error ? <p className="pl-[7.5rem] text-lyx-danger">{source.error.code}: {source.error.message}</p> : null}
                      {unitErrors.map((unit) => <p key={unit.unit} className="pl-[7.5rem] text-lyx-warn">{unit.unit} - {unit.error!.code}: {unit.error!.message}</p>)}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
