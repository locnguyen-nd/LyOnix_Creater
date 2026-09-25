import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

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
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[20px] leading-7 font-bold tracking-tight">{title}</h1>
        {breadcrumb ? <p className="mt-1 text-[12.5px] leading-4 text-lyx-fg-muted">{breadcrumb}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Banner({
  variant = "info",
  children,
}: {
  variant?: "info" | "warn" | "danger";
  children: ReactNode;
}) {
  const style =
    variant === "danger"
      ? "border-lyx-danger/40 bg-lyx-danger-bg text-lyx-danger"
      : variant === "warn"
        ? "border-lyx-warn/40 bg-lyx-warn-bg text-lyx-warn"
        : "border-lyx-border text-lyx-fg";
  return <div className={`mb-4 rounded-[var(--lyx-radius)] border px-3 py-2 text-[12.5px] ${style}`}>{children}</div>;
}

export function EmptyState({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[var(--lyx-radius)] border border-dashed border-lyx-border px-4 py-10">
      <Inbox size={20} strokeWidth={1.75} aria-hidden />
      <p className="text-lyx-fg-muted">{title}</p>
      {action}
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
    <span className={`inline-flex h-[22px] items-center rounded-full px-2.5 text-[11px] font-bold tracking-wide ${style}`}>
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

export function Sparkline({ values }: { values: number[] }) {
  return <TrendChart points={values.map((v, i) => ({ t: i, v }))} />;
}

export function TrendChart({
  points,
  label,
}: {
  points: Array<{ t: number; v: number }>;
  label?: string;
}) {
  if (points.length === 0) {
    return <p className="py-10 text-center text-[12px] text-lyx-fg-muted">Không đủ mốc để vẽ biểu đồ</p>;
  }
  const w = 1000;
  const h = 220;
  const pad = { l: 0, r: 0, t: 8, b: 26 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const values = points.map((p) => p.v);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const yMin = min === max ? (min === 0 ? 0 : min * 0.95) : min;
  const yMax = min === max ? max * 1.1 || 1 : max;
  const ySpan = yMax - yMin || 1;
  const xAt = (index: number) => pad.l + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const yAt = (value: number) => pad.t + innerH - ((value - yMin) / ySpan) * innerH;
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"} ${xAt(index)} ${yAt(point.v)}`).join(" ");
  const area = `${line} L ${xAt(points.length - 1)} ${pad.t + innerH} L ${xAt(0)} ${pad.t + innerH} Z`;
  const gridLines = 4;
  const formatTime = (ms: number) => {
    const date = new Date(ms);
    if (Number.isNaN(date.getTime()) || (points.length <= 24 && (points.at(-1)?.t ?? 0) - (points[0]?.t ?? 0) <= 36 * 3600 * 1000)) {
      return Number.isNaN(date.getTime()) ? String(ms) : date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  };
  const labelCount = Math.min(points.length, 7);
  const labelIdx = Array.from({ length: labelCount }, (_, i) => Math.round((i * (points.length - 1)) / Math.max(labelCount - 1, 1)));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[220px] w-full text-lyx-fg" role="img" aria-label={label ?? "trend"} preserveAspectRatio="none">
      {Array.from({ length: gridLines + 1 }, (_, i) => (pad.t + innerH * i) / gridLines).map((y) => (
        <line key={y} x1="0" x2={w} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" />
      ))}
      <path d={area} fill="currentColor" fillOpacity="0.06" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point, index) => (
        <circle key={`${point.t}-${index}`} cx={xAt(index)} cy={yAt(point.v)} r={points.length > 40 ? 0 : 3} fill="var(--lyx-bg)" stroke="currentColor" strokeWidth="2" />
      ))}
      {labelIdx.map((idx) => {
        const point = points[idx];
        if (!point) return null;
        const anchor = idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle";
        return (
          <text key={idx} x={xAt(idx)} y={h - 6} textAnchor={anchor} fontSize="11" fill="currentColor" fillOpacity="0.5">
            {formatTime(point.t)}
          </text>
        );
      })}
    </svg>
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
      className={`flex flex-col rounded-[var(--lyx-radius)] border bg-lyx-bg p-3.5 text-left transition-colors ${active ? "border-lyx-fg" : "border-lyx-border"}`}
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
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-lyx-fg text-[12px] font-bold text-lyx-bg"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {label}
    </span>
  );
}
