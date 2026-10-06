import { buildCaptionAss } from "@lyonix/domain/caption-ass";
import { captionFontById, cssFontStackForFamily } from "@lyonix/domain/caption-fonts";
import { captionLayoutOptions, type CaptionTextStyle } from "@lyonix/domain/caption-style";
import type { CaptionStyleEngine } from "@lyonix/domain/caption-style-capabilities";

/**
 * VE2E-93: the caption drawn over a Studio preview with the scene's EFFECTIVE style (font, size after the engine's shrink, colour, stroke,
 * position, lines, word highlight) - the same values the final render receives, laid out by the render's own line breaker. Only effects
 * the target engine really draws are shown. Purely local: no API call, no render job.
 */

const CANVAS = { width: 1080, height: 1920 } as const;
const LINE_HEIGHT = 1.28;

export type CaptionPage = { lines: string[]; fontSizePx: number };

/** First page of a static caption text, laid out like the engine does (LyOnix exactly, Creatomate approximately). */
export function layoutCaptionPage(text: string, style: CaptionTextStyle, engine: CaptionStyleEngine, durationMs = 4000): CaptionPage | null {
  if (!text.trim()) return null;
  const first = buildCaptionAss([{ text, startMs: 0, endMs: durationMs }], captionLayoutOptions(style, engine)).cues[0];
  return first ? { lines: first.lines, fontSizePx: first.fontSizePx } : null;
}

export const captionCssFont = (style: CaptionTextStyle): string => captionFontById(style.font.id)?.css ?? cssFontStackForFamily(style.font.family);

/** Text colour of a scene: the recipe's per-scene colour cycle applies only while the user has not set a colour (D3) and without highlight. */
export function captionTextColor(style: CaptionTextStyle, engine: CaptionStyleEngine, sceneIndex: number): string {
  const cycle = engine === "lyonix" && style.animation === "none" && !style.fillColorFromUser ? style.colorCycle : null;
  return cycle?.length ? cycle[Math.max(0, sceneIndex) % cycle.length]! : style.fillColor;
}

/** Whether the final render draws the per-word highlight for this style. */
export const showsWordHighlight = (style: CaptionTextStyle, engine: CaptionStyleEngine): boolean => engine === "lyonix" && style.animation === "word_highlight";

/** Top of the caption block on the 1080x1920 canvas, kept inside the frame. */
export function captionBlockTop(style: CaptionTextStyle, lineCount: number, fontSizePx: number): number {
  const block = lineCount * fontSizePx * LINE_HEIGHT;
  const { anchor, percent } = style.position;
  const top = anchor === "top" ? (CANVAS.height * percent) / 100 : anchor === "bottom" ? CANVAS.height * (1 - percent / 100) - block : (CANVAS.height * percent) / 100 - block / 2;
  return Math.min(Math.max(0, top), Math.max(0, CANVAS.height - block));
}

/**
 * The scene board's caption: the first page of the scene's text with its effective style; with the word highlight (LyOnix only) a still
 * of the karaoke the render draws (the first part of the page already spoken).
 */
export function SceneCaptionPreview({ text, style, engine, sceneIndex, durationMs }: { text: string; style: CaptionTextStyle; engine: CaptionStyleEngine; sceneIndex: number; durationMs: number }) {
  const page = layoutCaptionPage(text, style, engine, durationMs || 4000);
  if (!page) return null;
  const spoken = showsWordHighlight(style, engine) ? Math.ceil(page.lines.join("").length * 0.4) : null;
  return <CaptionPreview page={page} style={style} engine={engine} sceneIndex={sceneIndex} spokenChars={spoken} testId="scene-caption-preview" />;
}

export function CaptionPreview({
  page,
  style,
  engine,
  sceneIndex = 0,
  spokenChars = null,
  testId = "caption-preview",
}: {
  page: CaptionPage;
  style: CaptionTextStyle;
  engine: CaptionStyleEngine;
  sceneIndex?: number;
  /** Characters already spoken (word highlight); null = none. Ignored when the engine draws no highlight. */
  spokenChars?: number | null;
  testId?: string;
}) {
  const lineHeight = page.fontSizePx * LINE_HEIGHT;
  const top = captionBlockTop(style, page.lines.length, page.fontSizePx);
  const highlight = showsWordHighlight(style, engine) && spokenChars !== null;
  const fill = captionTextColor(style, engine, sceneIndex);
  let consumed = 0;
  return (
    <svg
      viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
      data-testid={testId}
      data-font-px={page.fontSizePx}
      data-anchor={style.position.anchor}
    >
      {page.lines.map((line, index) => {
        const chars = [...line];
        const spoken = highlight ? Math.max(0, Math.min(chars.length, spokenChars! - consumed)) : null;
        consumed += chars.length;
        return (
          <text
            key={`${index}-${line}`}
            x={CANVAS.width / 2}
            y={top + lineHeight * (index + 0.8)}
            textAnchor="middle"
            fontFamily={captionCssFont(style)}
            fontSize={page.fontSizePx}
            fontWeight={style.bold ? 700 : 400}
            fill={fill}
            stroke={style.stroke.enabled ? style.stroke.color : "none"}
            strokeWidth={style.stroke.enabled ? style.stroke.widthPx * 2 : 0}
            paintOrder="stroke"
            strokeLinejoin="round"
          >
            {spoken === null ? line : (
              <>
                <tspan fill={style.highlightColor ?? fill}>{chars.slice(0, spoken).join("")}</tspan>
                <tspan>{chars.slice(spoken).join("")}</tspan>
              </>
            )}
          </text>
        );
      })}
    </svg>
  );
}
