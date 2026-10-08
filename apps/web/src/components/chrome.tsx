import { AlertTriangle, CheckCircle2, Inbox, Info, XCircle } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

export function PageHeader({
  title,
  breadcrumb,
  actions,
}: {
  title: string;
  breadcrumb?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[20px] leading-7 font-bold tracking-tight">{title}</h1>
        {breadcrumb ? <p className="mt-1 text-[12.5px] leading-4 text-lyx-fg-muted">{breadcrumb}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

const BANNER_STYLE = {
  info: { box: "border-lyx-border bg-lyx-muted/40 text-lyx-fg", bar: "bg-lyx-fg-subtle", Icon: Info },
  success: { box: "border-lyx-ok/30 bg-lyx-ok-bg text-lyx-fg", bar: "bg-lyx-ok", Icon: CheckCircle2 },
  warn: { box: "border-lyx-warn/40 bg-lyx-warn-bg text-lyx-fg", bar: "bg-lyx-warn", Icon: AlertTriangle },
  danger: { box: "border-lyx-danger/40 bg-lyx-danger-bg text-lyx-fg", bar: "bg-lyx-danger", Icon: XCircle },
} as const;

/** Inline notice: tone bar + icon + readable text. Warnings and errors are announced to assistive tech (role="alert"). */
export function Banner({
  variant = "info",
  children,
}: {
  variant?: "info" | "success" | "warn" | "danger";
  children: ReactNode;
}) {
  const style = BANNER_STYLE[variant];
  const iconTone = variant === "danger" ? "text-lyx-danger" : variant === "warn" ? "text-lyx-warn" : variant === "success" ? "text-lyx-ok" : "text-lyx-fg-muted";
  return (
    <div role={variant === "danger" || variant === "warn" ? "alert" : "status"} data-variant={variant} className={`lyx-enter relative mb-4 flex items-start gap-2.5 overflow-hidden rounded-[var(--lyx-radius)] border py-2.5 pl-4 pr-3 text-[12.5px] leading-5 ${style.box}`}>
      <span className={`absolute inset-y-0 left-0 w-1 ${style.bar}`} aria-hidden="true" />
      <style.Icon size={16} className={`mt-[2px] shrink-0 ${iconTone}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="lyx-fade flex flex-col items-start gap-3 rounded-[var(--lyx-radius)] border border-dashed border-lyx-border px-4 py-10">
      <Inbox size={20} strokeWidth={1.75} aria-hidden />
      <p className="text-lyx-fg-muted">{title}</p>
      {action}
    </div>
  );
}

/** Loading placeholder grid: flat blocks pulsing softly (.lyx-skeleton), announced once as busy. `className` lays the grid out. */
export function SkeletonCards({ count = 6, label, className = "", media = true }: { count?: number; label: string; className?: string; media?: boolean }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} data-testid="skeleton" className={className}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} aria-hidden="true" className="min-w-0 overflow-hidden rounded-xl border border-lyx-border bg-lyx-bg">
          {media ? <div className="lyx-skeleton aspect-[3/2] w-full" /> : null}
          <div className="flex flex-col gap-2 p-2.5">
            <div className="lyx-skeleton h-3.5 w-3/4 rounded-[4px]" />
            <div className="lyx-skeleton h-3 w-1/2 rounded-[4px]" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Loading placeholder rows (lists, timelines, tables). */
export function SkeletonRows({ count = 4, label, rowClassName = "h-10" }: { count?: number; label: string; rowClassName?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} data-testid="skeleton" className="flex flex-col gap-2">
      {Array.from({ length: count }, (_, index) => <div key={index} aria-hidden="true" className={`lyx-skeleton rounded-[var(--lyx-radius)] ${rowClassName}`} />)}
    </div>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "danger" | "neutral";
  children: ReactNode;
}) {
  const style =
    tone === "ok"
      ? "text-lyx-ok bg-lyx-ok-bg"
      : tone === "warn"
        ? "text-lyx-warn bg-lyx-warn-bg"
        : tone === "danger"
          ? "text-lyx-danger bg-lyx-danger-bg"
          : "text-lyx-fg-muted bg-lyx-neutral-bg";
  return (
    <span className={`inline-flex h-[22px] items-center rounded-full px-2.5 text-[11px] font-bold tracking-wide transition-colors duration-200 ${style}`}>
      {children}
    </span>
  );
}

export function PreviewFrame({ caption }: { caption: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex items-center justify-center border border-lyx-border bg-lyx-muted text-[12px] text-lyx-fg-muted"
        style={{ aspectRatio: "1080 / 1920", maxHeight: 420, width: "min(100%, 236px)" }}
      >
        {caption}
      </div>
    </div>
  );
}

export type TrendSeries = {
  id: string;
  label: string;
  color: string;
  points: Array<{ t: number; v: number }>;
};

const DEFAULT_SERIES_COLOR = "var(--lyx-fg)";

export function Sparkline({ values }: { values: number[] }) {
  return <TrendChart points={values.map((v, i) => ({ t: i, v }))} />;
}

/**
 * Growth chart: draws every series as a continuous line (overview), with hover tooltip
 * showing the timestamp and each metric's value at that point — not a single click-to-swap value.
 */
export function TrendChart({
  points,
  series,
  label,
  emphasisId,
  valueFormatter = (v) => v.toLocaleString("vi-VN"),
}: {
  points?: Array<{ t: number; v: number }>;
  series?: TrendSeries[];
  label?: string;
  /** Optional thicker stroke for the focused KPI; other lines stay visible. */
  emphasisId?: string;
  valueFormatter?: (value: number) => string;
}) {
  const lines = useMemo<TrendSeries[]>(() => {
    if (series && series.length > 0) return series.filter((item) => item.points.length > 0);
    if (points && points.length > 0) return [{ id: "value", label: label ?? "Giá trị", color: DEFAULT_SERIES_COLOR, points }];
    return [];
  }, [series, points, label]);

  const [hover, setHover] = useState<{ index: number; xPct: number } | null>(null);

  const timeline = useMemo(() => {
    const stamps = new Set<number>();
    for (const line of lines) for (const point of line.points) stamps.add(point.t);
    return [...stamps].sort((a, b) => a - b);
  }, [lines]);

  if (lines.length === 0 || timeline.length === 0) {
    return <p className="py-10 text-center text-[12px] text-lyx-fg-muted">Không đủ mốc để vẽ biểu đồ</p>;
  }

  const w = 1000;
  const h = 240;
  const pad = { l: 8, r: 8, t: 12, b: 28 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const allValues = lines.flatMap((line) => line.points.map((p) => p.v));
  const max = Math.max(...allValues);
  const min = Math.min(...allValues);
  const yMin = min === max ? (min === 0 ? 0 : min * 0.95) : min;
  const yMax = min === max ? max * 1.1 || 1 : max;
  const ySpan = yMax - yMin || 1;
  const xAt = (index: number) => pad.l + (timeline.length === 1 ? innerW / 2 : (index / (timeline.length - 1)) * innerW);
  const yAt = (value: number) => pad.t + innerH - ((value - yMin) / ySpan) * innerH;
  const valueAt = (line: TrendSeries, t: number) => {
    const exact = line.points.find((p) => p.t === t);
    if (exact) return exact.v;
    let best: number | null = null;
    for (const point of line.points) {
      if (point.t <= t) best = point.v;
      else break;
    }
    return best;
  };
  const pathFor = (line: TrendSeries) => {
    const coords = timeline
      .map((t, index) => {
        const v = valueAt(line, t);
        return v === null ? null : { index, v };
      })
      .filter((item): item is { index: number; v: number } => item !== null);
    return coords.map((item, i) => `${i === 0 ? "M" : "L"} ${xAt(item.index)} ${yAt(item.v)}`).join(" ");
  };
  const formatTime = (ms: number) => {
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return String(ms);
    const span = (timeline.at(-1) ?? 0) - (timeline[0] ?? 0);
    if (timeline.length <= 24 && span <= 36 * 3600 * 1000) {
      return date.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  };
  const labelCount = Math.min(timeline.length, 7);
  const labelIdx = Array.from({ length: labelCount }, (_, i) => Math.round((i * (timeline.length - 1)) / Math.max(labelCount - 1, 1)));
  const hoverStamp = hover ? timeline[hover.index] : undefined;
  const hoverRows =
    hoverStamp === undefined
      ? []
      : lines
          .map((line) => ({ line, value: valueAt(line, hoverStamp) }))
          .filter((row): row is { line: TrendSeries; value: number } => row.value !== null);

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-[240px] w-full text-lyx-fg"
        role="img"
        aria-label={label ?? "trend"}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / Math.max(rect.width, 1);
          const index = Math.min(timeline.length - 1, Math.max(0, Math.round(ratio * (timeline.length - 1))));
          setHover({ index, xPct: (xAt(index) / w) * 100 });
        }}
      >
        {Array.from({ length: 5 }, (_, i) => pad.t + (innerH * i) / 4).map((y) => (
          <line key={y} x1="0" x2={w} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" />
        ))}
        {lines.map((line) => (
          <path
            key={line.id}
            d={pathFor(line)}
            fill="none"
            stroke={line.color}
            strokeWidth={emphasisId && line.id === emphasisId ? 3 : 2}
            strokeOpacity={emphasisId && line.id !== emphasisId ? 0.55 : 1}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover ? (
          <line x1={xAt(hover.index)} x2={xAt(hover.index)} y1={pad.t} y2={pad.t + innerH} stroke="currentColor" strokeOpacity="0.35" strokeDasharray="4 4" />
        ) : null}
        {hover && hoverStamp !== undefined
          ? hoverRows.map(({ line, value }) => (
              <circle key={line.id} cx={xAt(hover.index)} cy={yAt(value)} r={4} fill="var(--lyx-bg)" stroke={line.color} strokeWidth="2" />
            ))
          : null}
        {labelIdx.map((idx) => {
          const stamp = timeline[idx];
          if (stamp === undefined) return null;
          const anchor = idx === 0 ? "start" : idx === timeline.length - 1 ? "end" : "middle";
          return (
            <text key={idx} x={xAt(idx)} y={h - 6} textAnchor={anchor} fontSize="11" fill="currentColor" fillOpacity="0.5">
              {formatTime(stamp)}
            </text>
          );
        })}
      </svg>
      {hover && hoverStamp !== undefined && hoverRows.length > 0 ? (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[160px] max-w-[240px] rounded-[8px] border border-lyx-border bg-lyx-bg px-2.5 py-2 text-[11px] shadow-sm"
          style={{ left: `min(max(${hover.xPct}%, 8%), 92%)`, transform: "translateX(-50%)" }}
        >
          <p className="mb-1.5 font-semibold text-lyx-fg">{formatTime(hoverStamp)}</p>
          <ul className="flex flex-col gap-1">
            {hoverRows.map(({ line, value }) => (
              <li key={line.id} className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-lyx-fg-muted">
                  <span className="h-2 w-2 rounded-full" style={{ background: line.color }} />
                  {line.label}
                </span>
                <span className="font-semibold tabular-nums text-lyx-fg">{valueFormatter(value)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Legend dot used above multi-series charts to label each line's color. */
export function LegendDot({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-lyx-fg-muted">
      <span className="h-[8px] w-[8px] rounded-[2px]" style={{ background: color }} />
      {children}
    </span>
  );
}

/** Compact axis-less sparkline for KPI cards / table rows (TrendChart is the full labeled chart). */
export function MiniSpark({ values, tone = "neutral", width = 72, height = 24 }: { values: number[]; tone?: "ok" | "danger" | "neutral"; width?: number; height?: number }) {
  if (values.length < 2) return <span className="text-[11px] text-lyx-fg-subtle">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (width - pad * 2) + pad;
      const y = height - pad - ((v - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const color = tone === "ok" ? "var(--lyx-ok)" : tone === "danger" ? "var(--lyx-danger)" : "currentColor";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="presentation">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** KPI stat card used on Dashboard/Channel detail: label, big value, optional delta + sparkline. */
export function KpiCard({
  label,
  value,
  delta,
  positive,
  spark,
  tag,
  active,
  onClick,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  positive?: boolean | undefined;
  spark?: number[] | undefined;
  tag?: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`flex flex-col rounded-[var(--lyx-radius)] border bg-lyx-bg p-3.5 text-left ${onClick ? "lyx-card-hover" : "lyx-panel-hover"} ${active ? "!border-lyx-fg" : "border-lyx-border"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-lyx-fg-subtle">{label}</span>
        {tag}
      </div>
      <span className="mt-2 text-[20px] font-bold leading-none">{value}</span>
      <div className="mt-2 flex items-center justify-between gap-2">
        {delta ? (
          <span className={`text-[12px] font-semibold ${positive === undefined ? "text-lyx-fg-muted" : positive ? "text-lyx-ok" : "text-lyx-danger"}`}>
            {delta}
          </span>
        ) : <span />}
        {spark ? <MiniSpark values={spark} tone={positive === undefined ? "neutral" : positive ? "ok" : "danger"} /> : null}
      </div>
    </Comp>
  );
}

export function ChannelAvatar({ name, src, size = 40 }: { name: string; src?: string | null; size?: number }) {
  const label = name.trim().slice(0, 2).toUpperCase() || "?";
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="rounded-full border border-lyx-border object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-full border border-lyx-border bg-lyx-muted text-[11px] font-bold text-lyx-fg-muted"
      style={{ width: size, height: size }}
    >
      {label}
    </span>
  );
}
