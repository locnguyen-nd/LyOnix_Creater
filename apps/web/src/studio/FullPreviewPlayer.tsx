import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import {
  audioTimeSec,
  buildFullPreviewSequence,
  clampTime,
  formatClock,
  locateAt,
  sceneStartMs,
  summarizeReadiness,
  videoSourceTimeSec,
  type FullPreviewSceneInput,
} from "./full-preview";
import { buildPreviewPlan, pageAt } from "./full-preview-plan";
import { captionLayoutOptions, type CaptionTextStyle } from "@lyonix/domain/caption-style";
import type { CaptionStyleEngine } from "@lyonix/domain/caption-style-capabilities";
import { CaptionPreview } from "./text-style/CaptionPreview";

type Props = {
  /** Ordered timeline scenes (excluded ones are skipped by the sequencer). */
  scenes: FullPreviewSceneInput[];
  /** Scene to start from (e.g. the one selected on the scene board). */
  initialSceneId?: string | null;
  /** Fired when the playhead enters another scene, so the scene board can follow. */
  onSceneChange?: (sceneId: string) => void;
  onClose: () => void;
  /** VE2E-93: each scene's effective caption style and the engine that renders it (captions are then drawn with that style). */
  captionStyles?: ReadonlyMap<string, CaptionTextStyle>;
  captionEngine?: CaptionStyleEngine | null;
};

/**
 * VE2E-60: browser-side preview of the whole video. Image/video + voice + caption per scene,
 * driven by a wall-clock playhead so a scene that lacks media/voice never stalls playback.
 * It is an approximation of the Creatomate render (no template layout/fonts/transitions) and
 * is never render evidence. No FFmpeg, no backend call.
 */
export function FullPreviewPlayer({ scenes, initialSceneId, onSceneChange, onClose, captionStyles, captionEngine }: Props) {
  const { t } = useTranslation();
  const sequence = useMemo(() => buildFullPreviewSequence(scenes), [scenes]);
  const readiness = useMemo(() => summarizeReadiness(sequence), [sequence]);
  const engine = captionEngine ?? "lyonix";
  // VE2E-114: the render engine's own plan + caption layout, so the preview wraps captions where the render will.
  // VE2E-93: laid out with each scene's effective caption style.
  const previewPlan = useMemo(
    () => buildPreviewPlan(sequence.segments, undefined, (sceneId) => {
      const style = captionStyles?.get(sceneId);
      return style ? captionLayoutOptions(style, engine) : undefined;
    }),
    [sequence, captionStyles, engine],
  );
  const total = sequence.totalDurationMs;

  const [globalMs, setGlobalMs] = useState(() => {
    const start = initialSceneId ? sceneStartMs(sequence, initialSceneId) : null;
    return start ?? 0;
  });
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const globalRef = useRef(globalMs);
  globalRef.current = globalMs;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence;

  const located = locateAt(sequence, globalMs);
  const current = located ? sequence.segments[located.index]! : null;
  const next = located ? sequence.segments[located.index + 1] ?? null : null;
  const currentSceneId = current?.sceneId ?? null;

  useEffect(() => {
    if (currentSceneId) onSceneChange?.(currentSceneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSceneId]);

  const syncMedia = useCallback(() => {
    const loc = locateAt(sequenceRef.current, globalRef.current);
    if (!loc) return;
    const seg = sequenceRef.current.segments[loc.index]!;
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video && seg.mediaKind === "video") {
      try {
        video.currentTime = videoSourceTimeSec(seg, loc.offsetMs);
      } catch {
        /* metadata not ready yet - onLoadedMetadata calls sync again */
      }
      if (playingRef.current) void video.play().catch(() => undefined);
      else video.pause();
    }
    if (audio && seg.audioUrl) {
      try {
        audio.currentTime = audioTimeSec(loc.offsetMs);
      } catch {
        /* same as above */
      }
      if (playingRef.current && loc.offsetMs < seg.durationMs) void audio.play().catch(() => undefined);
      else audio.pause();
    }
  }, []);

  // Re-sync media when the scene changes or play/pause toggles (not on every tick).
  useEffect(() => {
    syncMedia();
  }, [currentSceneId, playing, syncMedia]);

  // Wall-clock playhead.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      const nextMs = globalRef.current + delta;
      const end = sequenceRef.current.totalDurationMs;
      if (nextMs >= end) {
        setGlobalMs(end);
        setPlaying(false);
        return;
      }
      setGlobalMs(nextMs);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = volume;
      audio.muted = muted;
    }
  }, [volume, muted, currentSceneId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const seek = (ms: number) => {
    const clamped = clampTime(sequenceRef.current, ms);
    globalRef.current = clamped;
    setGlobalMs(clamped);
    syncMedia();
  };

  const togglePlay = () => {
    if (total <= 0) return;
    if (!playing && globalRef.current >= total) seek(0);
    setPlaying((prev) => !prev);
  };

  const jumpTo = (sceneId: string) => {
    const start = sceneStartMs(sequence, sceneId);
    if (start !== null) seek(start);
  };

  const sceneNumber = (sceneId: string) => sequence.segments.findIndex((s) => s.sceneId === sceneId) + 1;

  return (
    <div className="lyx-anim-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={t("studioPro.fullPreviewTitle")} data-testid="full-preview">
      <div className="lyx-anim-modal flex max-h-full w-full max-w-[980px] flex-col overflow-hidden rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg shadow-2xl">
        <div className="flex items-center justify-between border-b border-lyx-border px-4 py-2">
          <p className="text-[13px] font-semibold">{t("studioPro.fullPreviewTitle")}</p>
          <button type="button" className="lyx-btn lyx-btn-ghost h-8 px-2" onClick={onClose} aria-label={t("studioPro.fullPreviewClose")} title={t("studioPro.fullPreviewClose")}>
            <X size={15} />
          </button>
        </div>
        <p className="border-b border-lyx-border bg-lyx-muted px-4 py-1.5 text-[11px] text-lyx-warn" data-testid="full-preview-approx">
          {t("studioPro.fullPreviewApprox")}
        </p>
        {previewPlan.expectedRenderDurationMs !== null ? (
          <p className="border-b border-lyx-border px-4 py-1.5 text-[11px] text-lyx-fg-muted" data-testid="full-preview-render-duration">
            {t("studioPro.fullPreviewRenderDuration", { duration: formatClock(previewPlan.expectedRenderDurationMs), fps: previewPlan.renderPlan?.fps ?? 60 })}
            {previewPlan.skippedSceneIds.length > 0 ? ` ${t("studioPro.fullPreviewRenderSkipped", { count: previewPlan.skippedSceneIds.length })}` : ""}
          </p>
        ) : null}

        {sequence.segments.length === 0 ? (
          <p className="px-4 py-10 text-center text-[12px] text-lyx-fg-muted">{t("studioPro.fullPreviewEmpty")}</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 md:flex-row">
            <div className="flex shrink-0 flex-col items-center gap-2 md:w-[300px]">
              <div className="relative w-[240px] overflow-hidden rounded-[12px] bg-[#161616]" style={{ aspectRatio: "1080 / 1920", containerType: "inline-size" }}>
                {current?.mediaKind === "video" && current.mediaUrl ? (
                  <video
                    key={`v-${current.sceneId}`}
                    ref={videoRef}
                    src={current.mediaUrl}
                    muted
                    playsInline
                    preload="auto"
                    onLoadedMetadata={syncMedia}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : current?.mediaKind === "image" && current.mediaUrl ? (
                  <img key={`i-${current.sceneId}`} src={current.mediaUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-[11px] text-white/60" data-testid="full-preview-placeholder">
                    <AlertTriangle size={18} />
                    {t("studioPro.fullPreviewNoMedia")}
                  </div>
                )}
                {current?.audioUrl ? (
                  <audio key={`a-${current.sceneId}`} ref={audioRef} src={current.audioUrl} preload="auto" onLoadedMetadata={syncMedia} className="hidden" />
                ) : null}
                {/* Preload the next scene so the cut is as gapless as the browser cache allows. */}
                {next?.mediaKind === "video" && next.mediaUrl ? <video key={`nv-${next.sceneId}`} src={next.mediaUrl} muted preload="auto" className="hidden" /> : null}
                {next?.mediaKind === "image" && next.mediaUrl ? <img key={`ni-${next.sceneId}`} src={next.mediaUrl} alt="" className="hidden" /> : null}
                {next?.audioUrl ? <audio key={`na-${next.sceneId}`} src={next.audioUrl} preload="auto" className="hidden" /> : null}
                {current ? (() => {
                  const offsetMs = located?.offsetMs ?? 0;
                  const page = pageAt(previewPlan.captionPages.get(current.sceneId) ?? [], offsetMs);
                  const style = captionStyles?.get(current.sceneId);
                  if (page && style) {
                    // estimated per-character progress through the page (the render uses the real TTS timing when it has it)
                    const chars = page.lines.join("").length;
                    const progress = page.endMs > page.startMs ? (offsetMs - page.startMs) / (page.endMs - page.startMs) : 1;
                    return <CaptionPreview page={page} style={style} engine={engine} sceneIndex={current.index} spokenChars={Math.round(Math.min(1, Math.max(0, progress)) * chars)} testId="full-preview-caption" />;
                  }
                  return page ? (
                    <p
                      className="absolute inset-x-0 text-center font-bold text-white"
                      style={{ bottom: "20%", paddingInline: "12%", fontSize: `${(page.fontSizePx / 1080) * 100}cqw`, lineHeight: 1.25, textShadow: "0 0 4px #000, 0 0 2px #000" }}
                      data-testid="full-preview-caption"
                      data-font-px={page.fontSizePx}
                    >
                      {page.lines.map((line, index) => (
                        <span key={index} className="block">{line}</span>
                      ))}
                    </p>
                  ) : null;
                })() : null}
                {current && (current.missingMedia || current.missingVoice) ? (
                  <div className="absolute left-1.5 top-1.5 flex flex-col gap-1">
                    {current.missingMedia ? <span className="rounded bg-lyx-warn px-1.5 py-0.5 text-[9px] font-semibold text-white">{t("studioPro.fullPreviewFlagMedia")}</span> : null}
                    {current.missingVoice ? <span className="rounded bg-lyx-warn px-1.5 py-0.5 text-[9px] font-semibold text-white">{t("studioPro.fullPreviewFlagVoice")}</span> : null}
                  </div>
                ) : null}
              </div>

              <div className="flex w-full items-center gap-2">
                <button type="button" className="lyx-btn lyx-btn-primary flex h-8 w-8 items-center justify-center" onClick={togglePlay} aria-label={playing ? t("studioPro.fullPreviewPause") : t("studioPro.fullPreviewPlay")} data-testid="full-preview-play">
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <span className="w-[84px] text-[11px] tabular-nums text-lyx-fg-muted" data-testid="full-preview-time">
                  {formatClock(globalMs)} / {formatClock(total)}
                </span>
                <button type="button" className="text-lyx-fg-muted" onClick={() => setMuted((prev) => !prev)} aria-label={muted ? t("studioPro.fullPreviewUnmute") : t("studioPro.fullPreviewMute")}>
                  {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(event) => {
                    setVolume(Number(event.target.value));
                    setMuted(false);
                  }}
                  className="min-w-0 flex-1"
                  aria-label={t("studioPro.fullPreviewVolume")}
                />
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(1, total)}
                step={50}
                value={Math.min(globalMs, total)}
                onChange={(event) => seek(Number(event.target.value))}
                className="w-full"
                aria-label={t("studioPro.fullPreviewScrub")}
                data-testid="full-preview-scrub"
              />
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {readiness.notReady.length > 0 ? (
                <div className="rounded-[6px] border border-lyx-border bg-lyx-muted p-2 text-[11px]" data-testid="full-preview-not-ready">
                  <p className="font-semibold text-lyx-warn">{t("studioPro.fullPreviewNotReady", { count: readiness.notReady.length })}</p>
                  <p className="text-lyx-fg-muted">
                    {t("studioPro.fullPreviewNotReadyDetail", { media: readiness.missingMedia.length, voice: readiness.missingVoice.length })}
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-lyx-fg-muted">{t("studioPro.fullPreviewAllReady")}</p>
              )}
              <ul className="max-h-[420px] overflow-y-auto rounded-[6px] border border-lyx-border" aria-label={t("studioPro.fullPreviewScenes")}>
                {sequence.segments.map((seg) => (
                  <li key={seg.sceneId}>
                    <button
                      type="button"
                      onClick={() => jumpTo(seg.sceneId)}
                      data-testid="full-preview-scene"
                      data-current={seg.sceneId === currentSceneId ? "true" : "false"}
                      className={`flex w-full items-center gap-2 border-b border-lyx-border px-2 py-1.5 text-left text-[11.5px] last:border-b-0 ${seg.sceneId === currentSceneId ? "bg-lyx-muted font-semibold" : ""}`}
                    >
                      <span className="w-6 shrink-0 text-lyx-fg-subtle">#{sceneNumber(seg.sceneId)}</span>
                      <span className="min-w-0 flex-1 truncate">{seg.caption || "…"}</span>
                      {seg.missingMedia ? <span className="shrink-0 rounded bg-lyx-warn px-1 text-[9px] text-white">{t("studioPro.fullPreviewFlagMedia")}</span> : null}
                      {seg.missingVoice ? <span className="shrink-0 rounded bg-lyx-warn px-1 text-[9px] text-white">{t("studioPro.fullPreviewFlagVoice")}</span> : null}
                      <span className="shrink-0 tabular-nums text-lyx-fg-subtle">{formatClock(seg.startMs)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
