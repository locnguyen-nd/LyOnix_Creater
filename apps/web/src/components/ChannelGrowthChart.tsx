import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InsightMetric } from "../channel-api";

type ChartType = "line" | "area" | "bar";
const TYPES: ChartType[] = ["line", "area", "bar"];
const WIDTH = 720;
const HEIGHT = 280;
const LEFT = 64;
const RIGHT = 18;
const TOP = 18;
const BOTTOM = 38;

export function ChannelGrowthChart({ metric, label, color }: { metric: InsightMetric | undefined; label: string; color: string }) {
  const { t } = useTranslation();
  const [type, setType] = useState<ChartType>("line");
  const [zoom, setZoom] = useState(1);
  const [end, setEnd] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const points = useMemo(() => (metric?.observations ?? []).filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v)), [metric]);

  useEffect(() => { setZoom(1); setEnd(points.length); setHover(null); }, [metric?.id, points.length]);
  const windowSize = Math.max(2, Math.ceil(points.length / zoom));
  const last = Math.min(points.length, Math.max(windowSize, end || points.length));
  const visible = points.slice(Math.max(0, last - windowSize), last);
  const plotted = type === "bar"
    ? visible.slice(1).map((point, index) => ({ t: point.t, v: point.v - visible[index]!.v }))
    : visible;
  const count = plotted.length;
  const formatValue = (value: number) => value.toLocaleString("vi-VN", { maximumFractionDigits: 1 });

  if (points.length < 2) return (
    <div className="rounded-xl border border-lyx-border bg-lyx-bg p-5">
      <h3 className="text-sm font-bold">{label}</h3>
      <p className="mt-2 text-sm text-lyx-fg-muted">{t("channels.chartNeedSamples", { count: points.length })}</p>
    </div>
  );

  const rawMin = Math.min(...plotted.map((point) => point.v), ...(type === "bar" ? [0] : []));
  const rawMax = Math.max(...plotted.map((point) => point.v), ...(type === "bar" ? [0] : []));
  const padding = Math.max((rawMax - rawMin) * 0.12, Math.abs(rawMax) * 0.02, 1);
  const yMin = type === "bar" ? Math.min(rawMin - padding, 0) : rawMin - padding;
  const yMax = type === "bar" ? Math.max(rawMax + padding, 0) : rawMax + padding;
  const span = yMax - yMin || 1;
  const innerW = WIDTH - LEFT - RIGHT;
  const innerH = HEIGHT - TOP - BOTTOM;
  const xAt = (index: number) => LEFT + (count === 1 ? innerW / 2 : index * innerW / (count - 1));
  const yAt = (value: number) => TOP + innerH - ((value - yMin) / span) * innerH;
  const line = plotted.map((point, index) => `${index === 0 ? "M" : "L"} ${xAt(index)} ${yAt(point.v)}`).join(" ");
  const area = `${line} L ${xAt(count - 1)} ${yAt(yMin)} L ${xAt(0)} ${yAt(yMin)} Z`;
  const selected = hover === null ? null : plotted[hover];
  const change = visible.at(-1)!.v - visible[0]!.v;
  const pct = visible[0]!.v === 0 ? null : (change / visible[0]!.v) * 100;
  const dateLabel = (stamp: number) => new Date(stamp).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  const canZoomIn = windowSize > 2;
  const canZoomOut = zoom > 1;

  return (
    <section className="rounded-xl border border-lyx-border bg-lyx-bg p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-lyx-fg-muted">{t("channels.growthTitle")}</p>
          <h3 className="mt-0.5 text-lg font-bold">{label}</h3>
          <p className="mt-1 text-xs text-lyx-fg-muted">{t("channels.chartSamples", { count: visible.length })} · {dateLabel(visible[0]!.t)} – {dateLabel(visible.at(-1)!.t)}</p>
        </div>
        <div className="text-right">
          <p className={`text-lg font-bold tabular-nums ${change < 0 ? "text-lyx-danger" : "text-lyx-ok"}`}>{change > 0 ? "+" : ""}{formatValue(change)}{pct === null ? "" : ` (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`}</p>
          <p className="text-xs text-lyx-fg-muted">{t("channels.chartChange")}</p>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-lg border border-lyx-border p-0.5" role="group" aria-label={t("channels.chartType")}>{TYPES.map((item) => (
          <button key={item} type="button" onClick={() => { setType(item); setHover(null); }} aria-pressed={type === item} className={`rounded-md px-3 py-1.5 text-xs ${type === item ? "bg-lyx-fg font-semibold text-lyx-bg" : "text-lyx-fg-muted hover:bg-lyx-muted"}`}>{t(`channels.chart.${item}`)}</button>
        ))}</div>
        <div className="flex items-center gap-1" role="group" aria-label={t("channels.chartZoom")}>
          <button type="button" onClick={() => setEnd(Math.max(windowSize, last - 1))} disabled={last <= windowSize} aria-label={t("channels.chartEarlier")} className="rounded-md border border-lyx-border p-1.5 disabled:opacity-35"><ChevronLeft size={16} /></button>
          <button type="button" onClick={() => { setZoom(Math.max(1, zoom / 2)); setHover(null); }} disabled={!canZoomOut} aria-label={t("channels.chartZoomOut")} className="rounded-md border border-lyx-border p-1.5 disabled:opacity-35"><Minus size={16} /></button>
          <span className="w-9 text-center text-xs tabular-nums">{zoom}×</span>
          <button type="button" onClick={() => { setZoom(Math.min(8, zoom * 2)); setHover(null); }} disabled={!canZoomIn} aria-label={t("channels.chartZoomIn")} className="rounded-md border border-lyx-border p-1.5 disabled:opacity-35"><Plus size={16} /></button>
          <button type="button" onClick={() => setEnd(Math.min(points.length, last + 1))} disabled={last >= points.length} aria-label={t("channels.chartLater")} className="rounded-md border border-lyx-border p-1.5 disabled:opacity-35"><ChevronRight size={16} /></button>
        </div>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-[280px] w-full" role="img" aria-label={`${label}: ${t(`channels.chart.${type}`)}`} onPointerLeave={() => setHover(null)} onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const svgX = x * WIDTH / rect.width;
        setHover(Math.max(0, Math.min(count - 1, Math.round((svgX - LEFT) / innerW * (count - 1)))));
      }}>
        {[0, 1, 2, 3, 4].map((tick) => {
          const value = yMin + (yMax - yMin) * tick / 4;
          const y = yAt(value);
          return <g key={tick}><line x1={LEFT} x2={WIDTH - RIGHT} y1={y} y2={y} stroke="var(--lyx-border)" /><text x={LEFT - 8} y={y + 4} textAnchor="end" fill="var(--lyx-fg-muted)" fontSize="11">{formatValue(value)}</text></g>;
        })}
        {type === "area" ? <path d={area} fill={color} opacity="0.14" /> : null}
        {type !== "bar" ? <path d={line} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /> : plotted.map((point, index) => {
          const y0 = yAt(0); const y = yAt(point.v);
          return <rect key={point.t} x={xAt(index) - Math.min(16, innerW / count / 3)} y={Math.min(y, y0)} width={Math.min(32, innerW / count * 0.65)} height={Math.max(2, Math.abs(y0 - y))} rx="3" fill={point.v < 0 ? "var(--lyx-danger)" : color} />;
        })}
        {selected ? <><line x1={xAt(hover!)} x2={xAt(hover!)} y1={TOP} y2={HEIGHT - BOTTOM} stroke={color} strokeDasharray="4 4" /><circle cx={xAt(hover!)} cy={yAt(selected.v)} r="5" fill={color} stroke="white" strokeWidth="2" /></> : null}
        <text x={LEFT} y={HEIGHT - 8} fill="var(--lyx-fg-muted)" fontSize="11">{dateLabel(plotted[0]!.t)}</text>
        <text x={WIDTH - RIGHT} y={HEIGHT - 8} textAnchor="end" fill="var(--lyx-fg-muted)" fontSize="11">{dateLabel(plotted.at(-1)!.t)}</text>
      </svg>
      <p className="min-h-5 text-center text-xs text-lyx-fg-muted" aria-live="polite">{selected ? `${new Date(selected.t).toLocaleString("vi-VN")}: ${selected.v > 0 && type === "bar" ? "+" : ""}${formatValue(selected.v)}` : t(type === "bar" ? "channels.chartBarHint" : "channels.chartHoverHint")}</p>
    </section>
  );
}
