import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { activeItemBox, sameIndicatorBox, SegmentedTabs, TabIndicator } from "./motion";
import { Button } from "./ui";
import { SkeletonCards, SkeletonRows } from "./chrome";
import { TOAST_EXIT_MS } from "./feedback";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");
const motionBlock = css.slice(css.lastIndexOf("/*", css.indexOf("App motion system")));
/** The motion rules without their comments (which may say "no gradient"). */
const motionRules = motionBlock.replace(/\/\*[\s\S]*?\*\//g, "");

/** Minimal stand-in for the DOM bits activeItemBox reads (offsets + offsetParent chain). */
type FakeNode = { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number; offsetParent: FakeNode | null };
const fakeList = (active: FakeNode | null) => ({ querySelector: () => active }) as unknown as HTMLElement;

describe("sliding tab indicator", () => {
  it("measures the active item relative to its list, through nested offset parents", () => {
    const list = fakeList(null) as unknown as FakeNode;
    const wrapper: FakeNode = { offsetLeft: 10, offsetTop: 4, offsetWidth: 0, offsetHeight: 0, offsetParent: list };
    const active: FakeNode = { offsetLeft: 32, offsetTop: 2, offsetWidth: 80, offsetHeight: 28, offsetParent: wrapper };
    const listEl = Object.assign(list, { querySelector: () => active }) as unknown as HTMLElement;
    expect(activeItemBox(listEl)).toEqual({ x: 42, y: 6, width: 80, height: 28 });
  });

  it("has no box when nothing is active or the item sits outside the list", () => {
    expect(activeItemBox(fakeList(null))).toBeNull();
    const stray: FakeNode = { offsetLeft: 1, offsetTop: 1, offsetWidth: 1, offsetHeight: 1, offsetParent: null };
    expect(activeItemBox(fakeList(stray))).toBeNull();
  });

  it("compares boxes by value so an unchanged measure does not re-render", () => {
    expect(sameIndicatorBox({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
    expect(sameIndicatorBox({ x: 1, y: 2, width: 3, height: 4 }, { x: 2, y: 2, width: 3, height: 4 })).toBe(false);
    expect(sameIndicatorBox(null, null)).toBe(true);
    expect(sameIndicatorBox(null, { x: 0, y: 0, width: 0, height: 0 })).toBe(false);
  });

  it("places the indicator with a transform and hides it until measured", () => {
    expect(renderToStaticMarkup(<TabIndicator box={null} animated={false} />)).toContain("opacity:0");
    const placed = renderToStaticMarkup(<TabIndicator box={{ x: 12, y: 3, width: 90, height: 28 }} animated />);
    expect(placed).toContain("transform:translate(12px, 3px)");
    expect(placed).toContain('data-animated="true"');
  });

  it("SegmentedTabs marks the active segment and paints it itself until the indicator is measured", () => {
    const out = renderToStaticMarkup(
      <SegmentedTabs tone="solid" value="b" onChange={() => undefined} options={[{ id: "a", label: "A" }, { id: "b", label: "B" }]} />,
    );
    expect(out).toMatch(/<button[^>]*aria-pressed="true"[^>]*data-active="true"[^>]*class="[^"]*bg-lyx-cta[^"]*"[^>]*>B<\/button>/);
    expect(out).toMatch(/<button[^>]*aria-pressed="false"[^>]*>A<\/button>/);
    expect(out).toContain("lyx-tab-indicator");
  });
});

describe("shared motion primitives", () => {
  it("a loading Button spins, is disabled and announced as busy", () => {
    const out = renderToStaticMarkup(<Button loading>Lưu</Button>);
    expect(out).toContain("animate-spin");
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<Button>Lưu</Button>)).not.toContain("animate-spin");
  });

  it("skeletons are flat pulsing blocks announced once as busy", () => {
    const cards = renderToStaticMarkup(<SkeletonCards label="Đang tải" count={3} />);
    expect(cards).toContain('role="status"');
    expect(cards).toContain('aria-busy="true"');
    expect(cards.match(/lyx-skeleton aspect/g)).toHaveLength(3);
    expect(renderToStaticMarkup(<SkeletonRows label="Đang tải" count={2} />).match(/lyx-skeleton/g)).toHaveLength(2);
  });

  it("a dismissed toast slides out quickly", () => {
    expect(TOAST_EXIT_MS).toBeLessThanOrEqual(200);
    expect(css).toMatch(/\.lyx-anim-toast-out \{\s*animation: lyx-toast-out 160ms/);
  });
});

describe("motion stylesheet rules", () => {
  it("keeps durations short and shared as tokens", () => {
    for (const [name, max] of [["--lyx-dur-fast", 180], ["--lyx-dur-base", 240], ["--lyx-dur-slow", 300]] as const) {
      const ms = Number(new RegExp(`${name}: (\\d+)ms`).exec(tokens)?.[1]);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(max);
    }
    expect(tokens).toMatch(/--lyx-enter-y: [4-8]px/);
  });

  it("reduced motion also drops delays and loops, so staggered blocks never wait hidden", () => {
    const reduced = tokens.slice(tokens.indexOf("prefers-reduced-motion"));
    expect(reduced).toContain("animation-duration: 0.01ms !important");
    expect(reduced).toContain("animation-delay: 0ms !important");
    expect(reduced).toContain("animation-iteration-count: 1 !important");
    expect(reduced).toContain("transition-delay: 0ms !important");
  });

  it("uses no gradient or glow, and the skeleton no longer sweeps a gradient", () => {
    expect(motionRules).not.toMatch(/gradient/);
    expect(motionRules).not.toMatch(/drop-shadow|0 0 \d+px/);
    const skeleton = css.slice(css.indexOf(".lyx-skeleton {"), css.indexOf("}", css.indexOf(".lyx-skeleton {")));
    expect(skeleton).not.toContain("gradient");
  });

  it("enter animations fill backwards only, so no transform lingers on a page block after it lands", () => {
    expect(motionBlock).toMatch(/:where\(\.lyx-page > \*, \.lyx-stagger > \*\) \{\s*animation: lyx-enter [^;]* backwards;/);
    expect(motionBlock).not.toMatch(/lyx-enter [^;]* (both|forwards);/);
  });

  it("card hover lifts at most 2px and only on hover-capable pointers", () => {
    expect(motionBlock).toMatch(/@media \(hover: hover\) \{\s*\.lyx-card-hover:hover \{\s*transform: translateY\(-[12]px\);/);
  });
});
