import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { CATEGORY_SAMPLES, PREVIEW_PRESETS, recipeCatalogEntry, type RenderRecipe, type TemplateCategory } from "@lyonix/render-recipes";
import { buildCaptionAss } from "@lyonix/domain/caption-ass";
import { buildSimulationPlan, overlayMotion, posterTimeMs, simulationFrame, type SimulationFrame } from "../studio/template-simulation";

/** The recipes name the Debian CJK font; the browser has Google's Noto Sans JP (same family). */
const cssFont = (family: string) => `"${family}", "Noto Sans JP", "Noto Sans CJK JP", sans-serif`;

const slotDefault = (recipe: RenderRecipe, key: string): string => recipe.slots.find((slot) => slot.key === key)?.default ?? "";
const resolveColor = (recipe: RenderRecipe, color: string): string => (color.startsWith("slot:") ? slotDefault(recipe, color.slice(5)) || "#888888" : color);

/** V04-01: sample content and pacing of a recipe's preview (catalog group; a recipe without an entry previews as news). */
export function previewSampleFor(recipe: RenderRecipe) {
  const entry = recipeCatalogEntry(recipe.id);
  const category: TemplateCategory = entry?.category ?? "news";
  return { category, preset: PREVIEW_PRESETS[entry?.previewPreset ?? "news-clean"], sample: CATEGORY_SAMPLES[category] };
}

/** Picture area: the whole canvas, or the recipe's band (even sizes, like the engine's `pictureArea`). */
function pictureBand(recipe: RenderRecipe): { y: number; height: number; canvasColor: string | null } {
  const frame = recipe.background.frame;
  if (!frame) return { y: 0, height: recipe.canvas.height, canvasColor: null };
  const even = (value: number) => Math.round(value / 2) * 2;
  const height = even((recipe.canvas.height * frame.heightPct) / 100);
  return { y: Math.max(0, even((recipe.canvas.height * frame.centerYPct) / 100 - height / 2)), height, canvasColor: frame.canvasColor };
}

const prefersReducedMotion = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Loop clock (~30 fps) while `playing`; the still poster time otherwise (and with reduced motion). */
function useLoopClock(playing: boolean, posterMs: number): number {
  const [tMs, setTMs] = useState(posterMs);
  useEffect(() => {
    if (!playing || prefersReducedMotion()) {
      setTMs(posterMs);
      return;
    }
    let handle = 0;
    let last = -Infinity;
    const origin = performance.now();
    const tick = (now: number) => {
      if (now - last >= 33) {
        last = now;
        setTMs(now - origin);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, posterMs]);
  return tMs;
}

/**
 * V04-01: a LyOnix (internal engine) template simulated from its recipe, in the recipe's 1080x1920 canvas (scales to any 9:16 box).
 * Still = poster frame (or the frame at `atMs`); `playing` = the 5-8 s loop of `template-simulation.ts` (zoom, the recipe's transition, voice captions with
 * word highlight / per-scene colour) - only effects the engine renders, never anything else. Text layers and captions use the same
 * line breaker as the render (`buildCaptionAss`). Sample pictures are neutral SVG illustrations drawn here (no asset, no network).
 * An approximation - the caller labels it "Mô phỏng". No audio, no cost, nothing stored.
 */
export function RecipePreview({ recipe, playing = false, atMs, className = "" }: { recipe: RenderRecipe; playing?: boolean; atMs?: number; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { category, preset, sample } = useMemo(() => previewSampleFor(recipe), [recipe]);
  const plan = useMemo(() => buildSimulationPlan(recipe, preset, sample), [recipe, preset, sample]);
  const tMs = useLoopClock(playing, atMs ?? posterTimeMs(plan));
  const frame = simulationFrame(recipe, plan, tMs);
  const textLayers = useMemo(() => layoutTextLayers(recipe, sample.headline), [recipe, sample.headline]);
  const { width, height } = recipe.canvas;
  const band = pictureBand(recipe);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={`block h-full w-full ${className}`} role="img" aria-label={recipe.name} data-testid="recipe-preview" data-scene={frame.sceneIndex} data-transition={frame.transition?.kind ?? "none"}>
      <defs>
        <clipPath id={`band-${uid}`}>
          <rect x="0" y={band.y} width={width} height={band.height} />
        </clipPath>
      </defs>
      <rect width={width} height={height} fill={band.canvasColor ?? "#000000"} />
      <g clipPath={`url(#band-${uid})`}>
        <Pictures frame={frame} category={category} band={band} width={width} uid={uid} />
      </g>
      {recipe.background.tint ? <rect width={width} height={height} fill={recipe.background.tint.color} opacity={recipe.background.tint.opacity} /> : null}
      <OverlayLayers recipe={recipe} frame={frame} nodes={textLayers} />
      <Caption recipe={recipe} frame={frame} />
    </svg>
  );
}

function Pictures({ frame, category, band, width, uid }: { frame: SimulationFrame; category: TemplateCategory; band: { y: number; height: number }; width: number; uid: string }) {
  const cy = band.y + band.height / 2;
  const transition = frame.transition;
  return (
    <>
      {frame.layers.map((layer, index) => {
        const incoming = transition !== null && index === frame.layers.length - 1;
        const outgoing = transition !== null && index === 0 && frame.layers.length > 1;
        const p = transition?.progress ?? 1;
        let wrapper: { clipPath?: string; opacity?: number; transform?: string } = {};
        let clip: ReactNode = null;
        if (incoming && transition) {
          if (transition.kind === "fade") wrapper = { opacity: p };
          else if (transition.kind === "slide") wrapper = { transform: `translate(${width * (1 - p)} 0)` };
          else if (transition.kind === "wipe") {
            // xfade `wipeleft`: the new picture is revealed from the right edge towards the left
            clip = <clipPath id={`reveal-${uid}`}><rect x={width * (1 - p)} y={band.y} width={width * p} height={band.height} /></clipPath>;
            wrapper = { clipPath: `url(#reveal-${uid})` };
          } else if (transition.kind === "circle") {
            // xfade `circleopen`: the new picture grows from the centre in a circle
            clip = <clipPath id={`reveal-${uid}`}><circle cx={width / 2} cy={cy} r={p * Math.hypot(width / 2, band.height / 2)} /></clipPath>;
            wrapper = { clipPath: `url(#reveal-${uid})` };
          }
        } else if (outgoing && transition?.kind === "slide") {
          wrapper = { transform: `translate(${-width * p} 0)` };
        }
        return (
          <g key={layer.scene.index} {...wrapper}>
            {clip ? <defs>{clip}</defs> : null}
            <g transform={`translate(${width / 2} ${cy}) scale(${layer.scale.toFixed(4)}) translate(${-width / 2} ${-cy})`}>
              <svg x="0" y={band.y} width={width} height={band.height} viewBox="0 0 1080 1920" preserveAspectRatio="xMidYMid slice">
                <SampleScene category={category} variant={layer.scene.index} gid={`${uid}s${layer.scene.index}`} />
              </svg>
            </g>
          </g>
        );
      })}
    </>
  );
}

/**
 * VE2E-157: each recipe layer moves with the engine's shared motion preset (same numbers as the libass tags of the render): panels are revealed
 * from the left, rules grow from their start edge, the badge pops around its centre, the headline rises 28 px while fading in.
 */
function OverlayLayers({ recipe, frame, nodes }: { recipe: RenderRecipe; frame: SimulationFrame; nodes: ReactNode[] }) {
  return (
    <>
      {recipe.layers.map((layer, index) => {
        const node = nodes[index];
        if (!node) return null;
        const state = overlayMotion(layer, frame);
        const cx = layer.x + layer.w / 2;
        const cy = layer.y + layer.h / 2;
        const transforms: string[] = [];
        if (state.dy !== 0) transforms.push(`translate(0 ${state.dy.toFixed(2)})`);
        if (state.growScale !== 1) {
          const vertical = layer.type === "box" && layer.w <= 16 && layer.h > 16;
          transforms.push(vertical ? `translate(${cx} ${layer.y}) scale(1 ${state.growScale.toFixed(4)}) translate(${-cx} ${-layer.y})` : `translate(${layer.x} ${layer.y}) scale(${state.growScale.toFixed(4)} 1) translate(${-layer.x} ${-layer.y})`);
        }
        if (state.scale !== 1) transforms.push(`translate(${cx} ${cy}) scale(${state.scale.toFixed(4)}) translate(${-cx} ${-cy})`);
        return (
          <g key={layer.id} opacity={state.opacity.toFixed(3)} {...(transforms.length ? { transform: transforms.join(" ") } : {})} data-testid="recipe-preview-layer" data-layer={layer.id}>
            {node}
          </g>
        );
      })}
    </>
  );
}

function Caption({ recipe, frame }: { recipe: RenderRecipe; frame: SimulationFrame }) {
  const caption = frame.caption;
  if (!caption) return null;
  const { height, width } = recipe.canvas;
  const lineHeight = caption.fontSizePx * 1.28;
  const placement = recipe.captions.placement ?? { anchor: "bottom" as const, marginPct: 20 };
  const blockHeight = caption.lines.length * lineHeight;
  const top = placement.anchor === "top" ? (height * placement.marginPct) / 100 : height * (1 - placement.marginPct / 100) - blockHeight;
  // VE2E-157: the phrase pops around its anchor edge (top-centre / bottom-centre, like libass alignment 8 / 2) while fading in
  const anchorY = placement.anchor === "top" ? top : top + blockHeight;
  const { opacity, scale } = caption.entrance;
  let consumed = 0;
  return (
    <g opacity={opacity.toFixed(3)} transform={`translate(${width / 2} ${anchorY}) scale(${scale.toFixed(4)}) translate(${-width / 2} ${-anchorY})`} data-testid="recipe-preview-caption-block">
      {caption.lines.map((line, index) => {
        const chars = [...line];
        const spoken = caption.spokenChars === null ? null : Math.max(0, Math.min(chars.length, caption.spokenChars - consumed));
        consumed += chars.length;
        return (
          <text
            key={`${index}-${line}`}
            x={width / 2}
            y={top + lineHeight * (index + 0.8)}
            textAnchor="middle"
            fontFamily={cssFont(recipe.captions.fontFamily)}
            fontSize={caption.fontSizePx}
            fontWeight={recipe.captions.bold ? 700 : 400}
            fill={caption.color}
            stroke={recipe.captions.outlinePx > 0 ? recipe.captions.outlineColor : "none"}
            strokeWidth={recipe.captions.outlinePx * 2}
            paintOrder="stroke"
            strokeLinejoin="round"
            data-testid="recipe-preview-caption"
          >
            {spoken === null ? line : (
              <>
                <tspan fill={caption.highlightColor}>{chars.slice(0, spoken).join("")}</tspan>
                <tspan>{chars.slice(spoken).join("")}</tspan>
              </>
            )}
          </text>
        );
      })}
    </g>
  );
}

/** Boxes / text layers of the recipe with the sample headline (laid out by the engine's line breaker: shrink, then maxLines); moved by `OverlayLayers`. */
function layoutTextLayers(recipe: RenderRecipe, headline: string): ReactNode[] {
  const textForSlot = (slot: string) => (slot === "headline" ? headline : slotDefault(recipe, slot));
  return recipe.layers.map((layer) => {
    if (layer.visibleIfSlot && !textForSlot(layer.visibleIfSlot)) return null;
    if (layer.type === "box") return <rect key={layer.id} x={layer.x} y={layer.y} width={layer.w} height={layer.h} fill={resolveColor(recipe, layer.color)} opacity={layer.opacity} />;
    const text = textForSlot(layer.slot);
    if (!text) return null;
    const laid = buildCaptionAss([{ text, startMs: 0, endMs: 4000 }], {
      canvas: recipe.canvas,
      fontSizePx: layer.fontSizePx,
      minFontSizePx: layer.minFontSizePx,
      maxLines: layer.maxLines,
      highlight: "none",
      placement: { x: layer.x + layer.w / 2, y: layer.y + layer.h / 2, widthPx: layer.w },
    }).cues[0];
    if (!laid) return null;
    const size = laid.fontSizePx;
    const firstBaseline = layer.y + layer.h / 2 - (laid.lines.length * size * 1.2) / 2 + size * 0.95;
    return (
      <g key={layer.id}>
        {laid.lines.map((line, index) => (
          <text
            key={`${index}-${line}`}
            x={layer.x + layer.w / 2}
            y={firstBaseline + index * size * 1.2}
            textAnchor="middle"
            fontFamily={cssFont(layer.fontFamily)}
            fontSize={size}
            fontWeight={layer.bold ? 700 : 400}
            fill={resolveColor(recipe, layer.color)}
            stroke={layer.outlinePx > 0 ? layer.outlineColor : "none"}
            strokeWidth={layer.outlinePx * 2}
            paintOrder="stroke"
            data-testid="recipe-preview-layer-text"
          >
            {line}
          </text>
        ))}
      </g>
    );
  });
}

// ------------------------------------------------------------------------------------------------ neutral sample pictures (1080x1920)

function Sky({ id, stops }: { id: string; stops: readonly string[] }) {
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          {stops.map((color, index) => <stop key={color} offset={`${(index / Math.max(1, stops.length - 1)) * 100}%`} stopColor={color} />)}
        </linearGradient>
      </defs>
      <rect width="1080" height="1920" fill={`url(#${id})`} />
    </>
  );
}

const SKYLINES: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [[0, 170, 760], [150, 150, 980], [290, 180, 640], [460, 140, 1120], [590, 190, 820], [770, 150, 1020], [910, 170, 700]],
  [[0, 210, 900], [190, 130, 1180], [310, 200, 760], [500, 160, 980], [650, 210, 1240], [850, 230, 820]],
  [[0, 140, 1040], [130, 190, 820], [310, 150, 1260], [450, 200, 900], [640, 140, 1100], [770, 160, 760], [920, 160, 960]],
];

function Skyline({ variant, fill, windows }: { variant: number; fill: string; windows?: string }) {
  const rows = SKYLINES[variant % SKYLINES.length]!;
  return (
    <>
      {rows.map(([x, w, h]) => (
        <g key={x}>
          <rect x={x} y={1920 - h} width={w} height={h} fill={fill} opacity={0.92} />
          {windows
            ? Array.from({ length: Math.floor((h - 80) / 90) }, (_, row) => (
                <rect key={row} x={x + 24} y={1920 - h + 50 + row * 90} width={w - 48} height={18} fill={windows} opacity={(row + variant) % 3 === 0 ? 0.25 : 0.6} />
              ))
            : null}
        </g>
      ))}
    </>
  );
}

function SampleScene({ category, variant, gid }: { category: TemplateCategory; variant: number; gid: string }) {
  const v = variant % 3;
  if (category === "sports") {
    if (v === 1) {
      return (
        <>
          <Sky id={`${gid}k`} stops={["#06142e", "#1b3a6b", "#2b4f86"]} />
          {[180, 900].map((x) => (
            <g key={x}>
              <circle cx={x} cy={330} r={170} fill="#fffbe0" opacity={0.12} />
              <circle cx={x} cy={330} r={44} fill="#fffbe0" />
            </g>
          ))}
          <polygon points="0,760 1080,760 1080,1180 0,1180" fill="#0d1b33" />
          {[0, 1, 2, 3].map((row) => <rect key={row} x="0" y={800 + row * 90} width="1080" height="10" fill="#1d3358" />)}
          <rect x="0" y="1180" width="1080" height="740" fill="#2f8f3a" />
          {[0, 1, 2, 3].map((row) => <rect key={row} x="0" y={1180 + row * 185} width="1080" height="92" fill="#37a043" />)}
          <line x1="540" y1="1180" x2="540" y2="1920" stroke="#ffffff" strokeWidth="8" opacity={0.75} />
        </>
      );
    }
    if (v === 2) {
      return (
        <>
          <rect width="1080" height="1920" fill="#b5452f" />
          <rect width="1080" height="620" fill="#3c8d40" />
          {[-300, -60, 180, 420, 660, 900, 1140, 1380].map((x) => <line key={x} x1={x} y1="1920" x2={540 + (x - 540) * 0.3} y2="620" stroke="#ffffff" strokeWidth="10" opacity={0.85} />)}
          <rect x="0" y="600" width="1080" height="24" fill="#ffffff" opacity={0.9} />
        </>
      );
    }
    return (
      <>
        <rect width="1080" height="1920" fill="#2e7d32" />
        {Array.from({ length: 10 }, (_, row) => <rect key={row} x="0" y={row * 192} width="1080" height="96" fill="#388e3c" />)}
        <rect x="90" y="170" width="900" height="1580" fill="none" stroke="#ffffff" strokeWidth="10" opacity={0.8} />
        <line x1="90" y1="960" x2="990" y2="960" stroke="#ffffff" strokeWidth="10" opacity={0.8} />
        <circle cx="540" cy="960" r="180" fill="none" stroke="#ffffff" strokeWidth="10" opacity={0.8} />
        <circle cx="640" cy="1210" r="52" fill="#ffffff" stroke="#9e9e9e" strokeWidth="6" />
      </>
    );
  }
  if (category === "faceless") {
    if (v === 1) {
      return (
        <>
          <Sky id={`${gid}k`} stops={["#87a8d0", "#c9b8c9", "#f5d6a8"]} />
          <circle cx="540" cy="1000" r="150" fill="#ffe2a8" opacity={0.95} />
          <rect x="0" y="1000" width="1080" height="920" fill="#1e4d6b" />
          {[0, 1, 2, 3, 4, 5].map((row) => <rect key={row} x={360 + row * 20} y={1040 + row * 110} width={360 - row * 40} height="10" fill="#ffe2a8" opacity={0.5} />)}
        </>
      );
    }
    if (v === 2) {
      return (
        <>
          <Sky id={`${gid}k`} stops={["#a8c9a1", "#5a8f5c", "#1d3b2a"]} />
          {[0, 1, 2].map((row) =>
            Array.from({ length: 7 }, (_, col) => {
              const x = col * 170 - 40 + row * 60;
              const base = 1100 + row * 300;
              return <polygon key={`${row}-${col}`} points={`${x},${base} ${x + 90},${base - 420 + row * 40} ${x + 180},${base}`} fill={["#2f5d3a", "#24492e", "#1a3622"][row]} />;
            }),
          )}
          <rect x="0" y="1700" width="1080" height="220" fill="#16301f" />
        </>
      );
    }
    return (
      <>
        <Sky id={`${gid}k`} stops={["#355c7d", "#6c5b7b", "#f8b195"]} />
        <polygon points="0,1240 260,780 520,1160 760,700 1080,1180 1080,1920 0,1920" fill="#3b4a5c" />
        <polygon points="0,1480 300,1080 600,1420 860,1120 1080,1360 1080,1920 0,1920" fill="#253241" />
        <polygon points="0,1700 360,1380 720,1660 1080,1460 1080,1920 0,1920" fill="#18212c" />
      </>
    );
  }
  if (category === "breaking_news") {
    if (v === 1) {
      return (
        <>
          <rect width="1080" height="1920" fill="#0b0f1c" />
          <circle cx="260" cy="760" r="260" fill="#d32f2f" opacity={0.35} />
          <circle cx="820" cy="820" r="240" fill="#1e5bd8" opacity={0.3} />
          <Skyline variant={1} fill="#06080f" />
        </>
      );
    }
    return (
      <>
        <Sky id={`${gid}k`} stops={v === 0 ? ["#1a0303", "#5c0b0b", "#b8341f"] : ["#14070a", "#3d0f14", "#6b1a1f"]} />
        <Skyline variant={v} fill="#0c0c10" {...(v === 2 ? { windows: "#ffb4a2" } : {})} />
      </>
    );
  }
  const skies = [["#1b2a4a", "#3b4f7a", "#f0a35e"], ["#0f3057", "#4f86c6", "#cfe3f5"], ["#0b1020", "#1f2a44", "#3a4a6b"]] as const;
  return (
    <>
      <Sky id={`${gid}k`} stops={skies[v]!} />
      {v === 0 ? <circle cx="820" cy="520" r="110" fill="#ffe6a3" opacity={0.85} /> : null}
      {v === 2 ? <circle cx="260" cy="420" r="70" fill="#e8eefc" opacity={0.8} /> : null}
      <Skyline variant={v} fill="#101828" {...(v === 2 ? { windows: "#ffd27a" } : {})} />
    </>
  );
}
