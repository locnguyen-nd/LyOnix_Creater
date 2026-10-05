import { useTranslation } from "react-i18next";
import type { VideoProductionListItemResponse, WorkflowRunStatus, WorkflowStepEventResponse } from "@lyonix/contracts";
import { STAGE_COLORS, STAGE_KEYS, currentStage, formatElapsed, isTerminalRun, summarizeStages, type StageStatus } from "../video-production-stages";

const QUEUED: ReadonlySet<WorkflowRunStatus> = new Set(["draft", "source_ready"]);
const ATTENTION: ReadonlySet<WorkflowRunStatus> = new Set(["failed", "cancelled", "blocked_provider", "needs_input"]);

const pct = (value: number, from: number, span: number) => Math.min(100, Math.max(0, ((value - from) / span) * 100));

function tickLabels(fromMs: number, spanMs: number) {
  const step = spanMs <= 40 * 60_000 ? 5 * 60_000 : 10 * 60_000;
  const first = Math.ceil(fromMs / step) * step;
  const ticks: { left: number; label: string }[] = [];
  for (let at = first; at < fromMs + spanMs; at += step) {
    ticks.push({ left: pct(at, fromMs, spanMs), label: new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
  }
  return ticks;
}

export function AutoRunTimeline({
  rows,
  events,
  nowMs,
  windowMinutes,
  onOpen,
}: {
  rows: VideoProductionListItemResponse[];
  events: Record<string, WorkflowStepEventResponse[] | undefined>;
  nowMs: number;
  windowMinutes: number;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  // The window is at least `windowMinutes` long and stretches back to the oldest visible run so no bar is clipped.
  const earliest = rows.reduce((min, row) => Math.min(min, Date.parse(row.createdAt)), nowMs);
  const fromMs = Math.min(nowMs - windowMinutes * 60_000, earliest - 60_000);
  const spanMs = (nowMs - fromMs) * 1.12;
  const ticks = tickLabels(fromMs, spanMs);
  const nowLeft = pct(nowMs, fromMs, spanMs);

  return (
    <div className="overflow-hidden rounded-xl border border-lyx-border bg-lyx-bg" data-testid="auto-timeline">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-lyx-border px-4 py-2.5">
        <p className="text-[13px] font-semibold">{t("videoProductions.timeline.title")}</p>
        <ul className="flex flex-wrap items-center gap-3 text-[11px] text-lyx-fg-muted">
          {STAGE_KEYS.map((key) => (
            <li key={key} className="inline-flex items-center gap-1.5">
              <i className="inline-block h-2 w-3 rounded-sm" style={{ background: STAGE_COLORS[key] }} />
              {t(`videoProduction.stage.${key}`)}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex border-b border-lyx-border bg-lyx-bg-muted text-[11px] text-lyx-fg-muted">
        <div className="w-[230px] shrink-0 px-4 py-2">{t("videoProductions.timeline.video")}</div>
        <div className="relative h-8 grow">
          {ticks.map((tick) => (
            <span key={tick.label} className="absolute top-2 pl-1.5" style={{ left: `${tick.left}%` }}>{tick.label}</span>
          ))}
        </div>
      </div>
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-[230px] right-0">
          {ticks.map((tick) => <div key={tick.label} className="absolute inset-y-0 border-l border-lyx-border/60" style={{ left: `${tick.left}%` }} />)}
          <div className="absolute inset-y-0 border-l-2 border-lyx-danger" style={{ left: `${nowLeft}%` }} />
          <span className="absolute top-0 -translate-x-1/2 rounded-b bg-lyx-danger px-1.5 py-px text-[10px] font-bold text-white" style={{ left: `${nowLeft}%` }}>{t("videoProductions.timeline.now")}</span>
        </div>
        {rows.map((row) => {
          const title = row.title || t(`videoProductions.source.${row.sourceType || "unknown"}`);
          const rowEvents = events[row.id];
          const stages = summarizeStages(rowEvents ?? [], row, nowMs);
          const queued = QUEUED.has(row.status) && stages.every((s) => s.status === "pending");
          const attention = ATTENTION.has(row.status);
          const current = currentStage(stages);
          const startedMs = Date.parse(row.createdAt);
          const endedMs = isTerminalRun(row.status) ? Date.parse(row.updatedAt) : nowMs;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onOpen(row.id)}
              aria-label={`${t("videoGallery.openDetails")}: ${title}`}
              className={`flex w-full border-b border-lyx-border/70 text-left last:border-b-0 hover:bg-lyx-muted ${attention ? "bg-lyx-warn-bg/60" : ""}`}
            >
              <div className="w-[230px] shrink-0 px-4 py-3">
                <p className="truncate text-[13px] font-semibold">{title}</p>
                <p className={`mt-0.5 truncate text-[11px] ${attention ? "text-lyx-warn" : row.status === "completed" ? "text-lyx-ok" : "text-lyx-fg-muted"}`}>
                  {t(`videoProduction.status.${row.status}`)} · {formatElapsed(endedMs - startedMs)}
                </p>
              </div>
              <div className="relative h-[58px] grow">
                {queued ? (
                  <div
                    className="absolute top-[18px] h-[22px] rounded border border-dashed border-lyx-fg-subtle px-2 text-[11px] leading-5 text-lyx-fg-muted"
                    style={{ left: `${pct(startedMs, fromMs, spanMs)}%`, width: `${Math.max(6, nowLeft - pct(startedMs, fromMs, spanMs))}%` }}
                  >
                    {t("videoProductions.timeline.queued")}
                  </div>
                ) : (
                  stages.filter((s) => s.startMs !== null && s.endMs !== null).map((stage) => {
                    const left = pct(stage.startMs!, fromMs, spanMs);
                    const width = Math.max(0.8, pct(stage.endMs!, fromMs, spanMs) - left);
                    const state: StageStatus = stage.status;
                    return (
                      <div
                        key={stage.key}
                        title={`${t(`videoProduction.stage.${stage.key}`)} · ${formatElapsed(stage.endMs! - stage.startMs!)}`}
                        className={`absolute top-[18px] h-[22px] overflow-hidden whitespace-nowrap px-1.5 text-[10.5px] leading-5 ${state === "running" ? "animate-pulse border border-lyx-fg" : state === "failed" ? "border border-lyx-danger" : ""}`}
                        style={{ left: `${left}%`, width: `${width}%`, background: STAGE_COLORS[stage.key] }}
                      >
                        {stage.key === current.key && state !== "done" && stage.stepsTotal > 1 ? `${stage.stepsDone}/${stage.stepsTotal}` : state === "done" && stage.key === "render" ? "✓" : ""}
                      </div>
                    );
                  })
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
