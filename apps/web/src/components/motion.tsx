import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Shared motion helpers (the CSS side is the "App motion system" block in styles.css).
 * Sliding indicator: the list is `position: relative`, its active item carries `data-active="true"` (or is the current
 * NavLink, `aria-current="page"`), and <TabIndicator> slides under it with a transform.
 */
export const ACTIVE_ITEM_SELECTOR = '[data-active="true"], [aria-current="page"]';

export type IndicatorBox = { x: number; y: number; width: number; height: number };

export const sameIndicatorBox = (a: IndicatorBox | null, b: IndicatorBox | null) =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/** Layout box (offsets, so a pressed/scaled item does not skew it) of the active item inside `list`; null when none is active. */
export function activeItemBox(list: HTMLElement): IndicatorBox | null {
  const active = list.querySelector<HTMLElement>(ACTIVE_ITEM_SELECTOR);
  if (!active) return null;
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = active;
  while (node && node !== list) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (node !== list) return null;
  return { x, y, width: active.offsetWidth, height: active.offsetHeight };
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Measures the active item of a tab list and re-measures when it, the list or any item resizes (font load, language switch,
 * collapsing sidebar). `deps` re-runs the measure: pass the active value (plus the item ids when the items can change).
 * The first placement does not animate; only later moves slide.
 */
export function useTabIndicator<T extends HTMLElement = HTMLDivElement>(deps: string) {
  const listRef = useRef<T | null>(null);
  const [box, setBox] = useState<IndicatorBox | null>(null);
  const [animated, setAnimated] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = () => setBox((prev) => {
      const next = activeItemBox(list);
      return sameIndicatorBox(prev, next) ? prev : next;
    });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const child of Array.from(list.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [deps]);

  useEffect(() => {
    if (!box || animated) return undefined;
    const frame = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(frame);
  }, [box, animated]);

  return { listRef, indicator: { box, animated } };
}

export function TabIndicator({ box, animated, className = "" }: { box: IndicatorBox | null; animated: boolean; className?: string }) {
  const style: CSSProperties = box
    ? { width: box.width, height: box.height, transform: `translate(${box.x}px, ${box.y}px)` }
    : { opacity: 0 };
  return <span aria-hidden="true" data-animated={animated ? "true" : undefined} className={`lyx-tab-indicator ${className}`} style={style} />;
}

export type SegmentOption<T extends string> = { id: T; label: ReactNode; icon?: ReactNode; testId?: string };

/**
 * `soft`: grey track, white raised segment (create-video mode switches). `solid`: bordered group, black segment (list filters,
 * view switches). Until the indicator is measured the active segment paints its own background, so it is never unreadable.
 */
const SEGMENT_LOOK = {
  soft: {
    list: "gap-0.5 rounded-[8px] bg-lyx-muted p-1",
    indicator: "rounded-[6px] bg-lyx-bg shadow-sm",
    item: "rounded-[6px] px-3 py-1.5 sm:px-4",
    active: "text-lyx-fg",
    fallback: "bg-lyx-bg shadow-sm",
    idle: "text-lyx-fg-muted hover:text-lyx-fg",
  },
  solid: {
    list: "gap-0.5 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-[3px]",
    indicator: "rounded-[4px] bg-lyx-cta",
    item: "h-7 rounded-[4px] px-3",
    active: "text-lyx-cta-fg",
    fallback: "bg-lyx-cta",
    idle: "text-lyx-fg-muted hover:text-lyx-fg",
  },
} as const;

export function SegmentedTabs<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  tone = "soft",
  className = "",
  testId,
}: {
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (id: T) => void;
  ariaLabel?: string;
  tone?: keyof typeof SEGMENT_LOOK;
  className?: string;
  testId?: string;
}) {
  const { listRef, indicator } = useTabIndicator<HTMLDivElement>(`${value}|${options.map((option) => option.id).join(",")}`);
  const look = SEGMENT_LOOK[tone];
  return (
    <div ref={listRef} role="group" aria-label={ariaLabel} data-testid={testId} className={`lyx-seg-${tone} relative inline-flex w-fit max-w-full flex-wrap ${look.list} ${className}`}>
      <TabIndicator {...indicator} className={look.indicator} />
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            data-active={active ? "true" : undefined}
            data-testid={option.testId}
            onClick={() => onChange(option.id)}
            className={`relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-[12.5px] font-semibold ${look.item} ${active ? `${look.active} ${indicator.box ? "" : look.fallback}` : look.idle}`}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
