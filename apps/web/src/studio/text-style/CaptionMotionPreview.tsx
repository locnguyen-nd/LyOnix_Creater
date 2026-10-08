import { useEffect, useState } from "react";
import type { CaptionStyleEngine } from "@lyonix/domain/caption-style-capabilities";
import type { CaptionTextStyle } from "@lyonix/domain/caption-style";
import { CaptionPreview, layoutCaptionPage, showsWordHighlight } from "./CaptionPreview";

const CUE_MS = 1800;
const HIGHLIGHT_STEP_MS = 85;

const prefersReducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A 9:16 caption preview in motion, honest to the render: captions change page like real subtitles, and the per-word highlight runs only
 * where the final render draws it (karaoke on LyOnix). Laid out by the VE2E-93 preview (the render's own line breaker); the backdrop pans
 * slowly to stand for the video. Static when the user prefers reduced motion, and in a static render.
 */
export function CaptionMotionPreview({ style, engine, samples, scene, accent, playing = true, className = "", testId = "caption-motion-preview" }: {
  style: CaptionTextStyle;
  /** Caption lines shown in turn (the preset's own sample lines). */
  samples: readonly string[];
  engine: CaptionStyleEngine | null;
  scene: string;
  accent: string;
  playing?: boolean;
  className?: string;
  testId?: string;
}) {
  const drawEngine = engine === "creatomate" ? "creatomate" : "lyonix";
  const highlight = showsWordHighlight(style, drawEngine);
  const [cue, setCue] = useState(0);
  const page = layoutCaptionPage(samples[cue % samples.length]!, style, drawEngine);
  const total = page ? page.lines.join("").length : 0;
  const [spoken, setSpoken] = useState<number | null>(null);
  // a stable key: the style object is rebuilt on every render of the parent
  const styleKey = JSON.stringify(style);

  useEffect(() => {
    setSpoken(null);
    if (!playing || prefersReducedMotion()) return undefined;
    if (!highlight) {
      const timer = setInterval(() => setCue((value) => value + 1), CUE_MS);
      return () => clearInterval(timer);
    }
    // karaoke: the highlight runs through the page, holds a moment, then the next page comes
    let chars = 0;
    const timer = setInterval(() => {
      chars += 1;
      if (chars > total + 8) {
        chars = 0;
        setCue((value) => value + 1);
      }
      setSpoken(Math.min(chars, total));
    }, HIGHLIGHT_STEP_MS);
    return () => clearInterval(timer);
  }, [playing, highlight, total, styleKey]);

  const stillSpoken = highlight ? Math.ceil(total * 0.4) : null;
  return (
    <div
      className={`relative overflow-hidden rounded-[12px] ring-1 ring-white/10 ${className}`}
      style={{ aspectRatio: "9 / 16", containerType: "inline-size", boxShadow: `0 18px 40px -18px ${accent}` }}
      data-testid={testId}
    >
      <div className="lyx-anim-scene-pan absolute inset-0" style={{ backgroundImage: scene, backgroundSize: "220% 220%" }} aria-hidden />
      <div className="absolute inset-0 bg-[radial-gradient(120%_70%_at_50%_0%,rgba(255,255,255,0.14),transparent_60%)]" aria-hidden />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/45 to-transparent" aria-hidden />
      {page ? (
        <div key={cue} className="lyx-anim-cue absolute inset-0">
          <CaptionPreview page={page} style={style} engine={drawEngine} sceneIndex={0} spokenChars={highlight ? spoken ?? stillSpoken : null} testId="scene-caption-preview" />
        </div>
      ) : null}
      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white/90">
        <span className="lyx-anim-soft-pulse inline-block h-1.5 w-1.5 rounded-full" style={{ background: accent }} aria-hidden />
        9:16
      </span>
    </div>
  );
}
