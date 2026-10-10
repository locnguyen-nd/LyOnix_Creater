import { useEffect, useMemo, useRef, useState } from "react";
import { bindPreviewShortcuts, PreviewPlaybackController, type PreviewPlaybackSnapshot, type PreviewSceneTiming } from "./preview-playback";

/** The playhead moves on screen about this often (the clock itself runs every animation frame). */
const SNAPSHOT_INTERVAL_MS = 100;

const sameDiscrete = (a: PreviewPlaybackSnapshot, b: PreviewPlaybackSnapshot) =>
  a.playing === b.playing && a.sceneIndex === b.sceneIndex && a.sceneId === b.sceneId && a.ended === b.ended && a.buffering === b.buffering && a.totalMs === b.totalMs;

/**
 * React wrapper of `PreviewPlaybackController` for the Studio preview: Space / Left / Right / Home / Esc on `window`, the clock on
 * `requestAnimationFrame`, a snapshot for the UI (re-rendered at most every 100 ms while playing, immediately on play / pause / scene
 * change). Unmount (closing Studio, another project) stops the clock and removes the listener.
 */
export function usePreviewPlayback(options: {
  timings: readonly PreviewSceneTiming[];
  isBuffering: () => boolean;
  onSceneEnter: (sceneId: string, offsetMs: number) => void;
  /** Shortcuts on/off (e.g. off while the full-preview player is open). */
  enabled: boolean;
}): { snapshot: PreviewPlaybackSnapshot; controller: PreviewPlaybackController } {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const lastEmit = useRef(0);
  const [snapshot, setSnapshot] = useState<PreviewPlaybackSnapshot>({ playing: false, sceneIndex: 0, sceneId: null, offsetMs: 0, progress: 0, globalMs: 0, totalMs: 0, ended: false, buffering: false });
  const snapshotRef = useRef(snapshot);

  const controller = useMemo(
    () =>
      new PreviewPlaybackController({
        now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
        isBuffering: () => optionsRef.current.isBuffering(),
        onSceneEnter: (sceneId, offsetMs) => optionsRef.current.onSceneEnter(sceneId, offsetMs),
        onChange: (next) => {
          const now = typeof performance !== "undefined" ? performance.now() : Date.now();
          if (sameDiscrete(next, snapshotRef.current) && next.playing && now - lastEmit.current < SNAPSHOT_INTERVAL_MS) return;
          lastEmit.current = now;
          snapshotRef.current = next;
          setSnapshot(next);
        },
      }),
    [],
  );

  const timingsKey = options.timings.map((timing) => `${timing.sceneId}:${timing.durationMs}`).join("|");
  useEffect(() => {
    controller.setScenes(optionsRef.current.timings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, timingsKey]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const unbind = bindPreviewShortcuts(window, controller, {
      enabled: () => optionsRef.current.enabled,
      dialogOpen: () => Boolean(document.querySelector("[aria-modal='true'], [role='alertdialog']")),
    });
    return () => {
      unbind();
      controller.dispose();
    };
  }, [controller]);

  return { snapshot, controller };
}
