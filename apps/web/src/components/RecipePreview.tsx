import { useId } from "react";
import type { RenderRecipe } from "@lyonix/render-recipes";
import { buildCaptionAss } from "@lyonix/domain/caption-ass";
import { layoutSceneCaption } from "../studio/full-preview-plan";

/** Sample content for the simulation (the released recipes are Japanese news templates). */
export const SAMPLE_HEADLINE = "東京の夜景、過去最多の観光客";
export const SAMPLE_CAPTION = "東京の夜景はとても美しく、毎晩たくさんの観光客が展望台に集まります。";

/** The recipes name the Debian CJK font; the browser has Google's Noto Sans JP (same family). */
const cssFont = (family: string) => `"${family}", "Noto Sans JP", "Noto Sans CJK JP", sans-serif`;

const slotDefault = (recipe: RenderRecipe, key: string): string => recipe.slots.find((slot) => slot.key === key)?.default ?? "";
const resolveColor = (recipe: RenderRecipe, color: string): string => (color.startsWith("slot:") ? slotDefault(recipe, color.slice(5)) || "#888888" : color);
const textForSlot = (recipe: RenderRecipe, slot: string): string => (slot === "headline" ? SAMPLE_HEADLINE : slotDefault(recipe, slot));

/**
 * V04-XX: a LyOnix (internal engine) template drawn from its recipe - background with the recipe's tint / band frame and a slow
 * zoom, its overlay boxes and text layers with the sample headline, and a voice caption laid out by the SAME line breaker the
 * render uses (`buildCaptionAss` via `layoutSceneCaption`, at most 2 lines). An approximation (sample picture, no FFmpeg, no
 * transitions, font metrics estimated) - the caller labels it "simulation". Pure SVG in the recipe's 1080x1920 canvas, so it
 * scales to any 9:16 box. No network, no cost.
 */
export function RecipePreview({ recipe, className = "" }: { recipe: RenderRecipe; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const { width, height } = recipe.canvas;
  const frame = recipe.background.frame;
  const bandHeight = frame ? (height * frame.heightPct) / 100 : height;
  const bandY = frame ? (height * frame.centerYPct) / 100 - bandHeight / 2 : 0;
  const zoom = recipe.background.image.motion === "none" ? 0 : recipe.background.image.intensity;
  const page = layoutSceneCaption(SAMPLE_CAPTION, 4000, recipe)[0];
  const captionLines = recipe.captions.enabled && page ? page.lines : [];
  const captionSize = page?.fontSizePx ?? recipe.captions.fontSizePx;
  const lineHeight = captionSize * 1.28;
  const placement = recipe.captions.placement ?? { anchor: "bottom" as const, marginPct: 20 };
  const blockHeight = captionLines.length * lineHeight;
  const captionTop = placement.anchor === "top" ? (height * placement.marginPct) / 100 : height * (1 - placement.marginPct / 100) - blockHeight;
  const captionColor = recipe.captions.colorCycle?.[0] ?? recipe.captions.textColor;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={`block h-full w-full ${className}`} role="img" aria-label={recipe.name} data-testid="recipe-preview">
      <defs>
        <linearGradient id={`sky-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1b2a4a" />
          <stop offset="55%" stopColor="#3b4f7a" />
          <stop offset="100%" stopColor="#f0a35e" />
        </linearGradient>
        <clipPath id={`band-${uid}`}>
          <rect x="0" y={bandY} width={width} height={bandHeight} />
        </clipPath>
      </defs>

      <rect width={width} height={height} fill={frame?.canvasColor ?? "#000000"} />
      {/* Sample picture: a stylised city at dusk, slowly zooming like the recipe's image motion. */}
      <g clipPath={`url(#band-${uid})`}>
        <g className="lyx-recipe-zoom" style={{ transformOrigin: "50% 50%", transformBox: "fill-box", ["--lyx-zoom" as string]: String(1 + zoom) }}>
          <rect x="0" y={bandY} width={width} height={bandHeight} fill={`url(#sky-${uid})`} />
          {[120, 300, 470, 640, 820, 960].map((x, index) => (
            <rect key={x} x={x - 70} y={bandY + bandHeight * (0.45 + (index % 3) * 0.08)} width={140} height={bandHeight} fill="#101828" opacity={0.85} />
          ))}
          <circle cx={width * 0.78} cy={bandY + bandHeight * 0.22} r={70} fill="#ffe6a3" opacity={0.85} />
        </g>
        {recipe.background.tint ? <rect x="0" y={bandY} width={width} height={bandHeight} fill={recipe.background.tint.color} opacity={recipe.background.tint.opacity} /> : null}
      </g>

      {recipe.layers.map((layer) => {
        if (layer.visibleIfSlot && !(layer.visibleIfSlot === "headline" ? SAMPLE_HEADLINE : slotDefault(recipe, layer.visibleIfSlot))) return null;
        if (layer.type === "box") return <rect key={layer.id} x={layer.x} y={layer.y} width={layer.w} height={layer.h} fill={resolveColor(recipe, layer.color)} opacity={layer.opacity} />;
        const text = textForSlot(recipe, layer.slot);
        if (!text) return null;
        // Same layout call as the engine (media-worker overlays.ts): shrink to minFontSizePx, then at most maxLines lines.
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
      })}

      {captionLines.map((line, index) => (
        <text
          key={`${index}-${line}`}
          x={width / 2}
          y={captionTop + lineHeight * (index + 0.8)}
          textAnchor="middle"
          fontFamily={cssFont(recipe.captions.fontFamily)}
          fontSize={captionSize}
          fontWeight={recipe.captions.bold ? 700 : 400}
          fill={recipe.captions.highlight === "word" && index === 0 ? recipe.captions.highlightColor : captionColor}
          stroke={recipe.captions.outlinePx > 0 ? recipe.captions.outlineColor : "none"}
          strokeWidth={recipe.captions.outlinePx * 2}
          paintOrder="stroke"
          strokeLinejoin="round"
          data-testid="recipe-preview-caption"
        >
          {line}
        </text>
      ))}
    </svg>
  );
}
