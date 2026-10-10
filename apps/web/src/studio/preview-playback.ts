/**
 * Studio preview playback (Space = Play/Pause): a sequential preview of the scenes with the media and voice already in the Studio -
 * no render, no provider call. Framework-free so every rule runs in a plain test:
 *
 * - `PreviewPlaybackController`: the clock. One running offset inside the current scene, advanced by `requestFrame` (wall time); at a
 *   scene's end it enters the next scene, at the timeline's end it stops on the last frame (`ended`), and Play after that restarts from
 *   the start. Pause keeps the offset (Play resumes from there). While the scene's media / voice is still loading (`isBuffering`) the
 *   clock waits instead of running ahead of the picture.
 * - `previewShortcutAction` / `bindPreviewShortcuts`: Space / Left / Right / Home / Esc, never while typing (input, textarea, select,
 *   contenteditable, textbox, search), inside a dialog / modal, with a modifier key, or on a key repeat; Left / Right / Esc are left to
 *   the timeline track when the focus is inside it (it already uses them to move / close).
 * - `syncPreviewMedia` / `releasePreviewMedia`: put the scene's video (muted, its source range) and voice at the clock's offset and play /
 *   pause them together; release pauses the previous scene's elements so an old voice never keeps talking under a new scene.
 * Reduced motion only changes how the playhead is drawn (no easing), never the playback itself.
 */

export type PreviewSceneTiming = { sceneId: string; durationMs: number };

export type PreviewPlaybackSnapshot = {
  playing: boolean;
  sceneIndex: number;
  sceneId: string | null;
  /** ms inside the current scene. */
  offsetMs: number;
  /** 0..1 inside the current scene (drives the playhead). */
  progress: number;
  /** ms since the start of the whole preview. */
  globalMs: number;
  totalMs: number;
  /** The last scene played to its end; the next Play restarts from the start. */
  ended: boolean;
  /** Waiting for the scene's media / voice to load (the clock does not advance). */
  buffering: boolean;
};

export type PreviewPlaybackDeps = {
  now: () => number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  /** True while the current scene's media / voice cannot play yet. */
  isBuffering?: () => boolean;
  onChange?: (snapshot: PreviewPlaybackSnapshot) => void;
  /** A scene starts playing (by the clock, a manual pick, prev / next / home): the caller points the media at it. */
  onSceneEnter?: (sceneId: string, offsetMs: number) => void;
};

export class PreviewPlaybackController {
  private scenes: PreviewSceneTiming[] = [];
  private playing = false;
  private sceneIndex = 0;
  private offsetMs = 0;
  private ended = false;
  private buffering = false;
  private frame: number | null = null;
  private lastTick = 0;

  constructor(private readonly deps: PreviewPlaybackDeps) {}

  /** New / reordered / re-timed scenes; the current scene is kept by id when it still exists. */
  setScenes(scenes: readonly PreviewSceneTiming[]): void {
    const currentId = this.scenes[this.sceneIndex]?.sceneId;
    this.scenes = scenes.filter((scene) => scene.durationMs > 0).map((scene) => ({ ...scene }));
    const kept = currentId ? this.scenes.findIndex((scene) => scene.sceneId === currentId) : -1;
    this.sceneIndex = kept >= 0 ? kept : Math.min(this.sceneIndex, Math.max(0, this.scenes.length - 1));
    this.offsetMs = Math.min(this.offsetMs, this.scenes[this.sceneIndex]?.durationMs ?? 0);
    if (this.scenes.length === 0) this.pause();
    this.emit();
  }

  getSnapshot(): PreviewPlaybackSnapshot {
    const current = this.scenes[this.sceneIndex];
    const before = this.scenes.slice(0, this.sceneIndex).reduce((sum, scene) => sum + scene.durationMs, 0);
    const totalMs = this.scenes.reduce((sum, scene) => sum + scene.durationMs, 0);
    return {
      playing: this.playing,
      sceneIndex: this.sceneIndex,
      sceneId: current?.sceneId ?? null,
      offsetMs: this.offsetMs,
      progress: current && current.durationMs > 0 ? Math.min(1, this.offsetMs / current.durationMs) : 0,
      globalMs: before + this.offsetMs,
      totalMs,
      ended: this.ended,
      buffering: this.buffering,
    };
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.scenes.length === 0 || this.playing) return;
    if (this.ended) {
      // Space after the end: from the start again.
      this.ended = false;
      this.sceneIndex = 0;
      this.offsetMs = 0;
    }
    this.playing = true;
    this.lastTick = this.deps.now();
    this.enterScene();
    this.schedule();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.buffering = false;
    this.unschedule();
    this.emit();
  }

  /** Esc: stop and go back to the start of the current scene. */
  stop(): void {
    this.pause();
    this.offsetMs = 0;
    this.ended = false;
    this.emit();
  }

  next(): void {
    this.jumpTo(Math.min(this.scenes.length - 1, this.sceneIndex + 1));
  }

  prev(): void {
    this.jumpTo(Math.max(0, this.sceneIndex - 1));
  }

  home(): void {
    this.jumpTo(0);
  }

  /** A scene picked by hand (timeline / list): the preview moves there and keeps its play state. */
  seekToScene(sceneId: string): void {
    const index = this.scenes.findIndex((scene) => scene.sceneId === sceneId);
    if (index < 0 || (index === this.sceneIndex && this.offsetMs === 0)) return;
    this.jumpTo(index);
  }

  /** Stops everything (unmount / another project): no frame is left scheduled. Safe to call more than once (React Strict Mode). */
  dispose(): void {
    this.pause();
    this.unschedule();
  }

  private jumpTo(index: number): void {
    if (this.scenes.length === 0) return;
    this.sceneIndex = index;
    this.offsetMs = 0;
    this.ended = false;
    this.lastTick = this.deps.now();
    if (this.playing) this.enterScene();
    this.emit();
  }

  private enterScene(): void {
    const scene = this.scenes[this.sceneIndex];
    if (scene) this.deps.onSceneEnter?.(scene.sceneId, this.offsetMs);
  }

  private schedule(): void {
    if (this.frame !== null || !this.playing) return;
    this.frame = this.deps.requestFrame(() => {
      this.frame = null;
      this.tick();
    });
  }

  private unschedule(): void {
    if (this.frame !== null) this.deps.cancelFrame(this.frame);
    this.frame = null;
  }

  /** One clock step: wall time since the last step, unless the scene is still loading. */
  tick(): void {
    if (!this.playing) return;
    const now = this.deps.now();
    const delta = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const waiting = Boolean(this.deps.isBuffering?.());
    if (waiting !== this.buffering) this.buffering = waiting;
    if (!waiting) this.advance(delta);
    this.emit();
    this.schedule();
  }

  private advance(deltaMs: number): void {
    let remaining = deltaMs;
    while (this.playing && remaining > 0) {
      const scene = this.scenes[this.sceneIndex];
      if (!scene) return;
      const left = scene.durationMs - this.offsetMs;
      if (remaining < left) {
        this.offsetMs += remaining;
        return;
      }
      remaining -= left;
      if (this.sceneIndex >= this.scenes.length - 1) {
        // End of the timeline: stay on the last frame; the next Play restarts.
        this.offsetMs = scene.durationMs;
        this.ended = true;
        this.playing = false;
        this.unschedule();
        return;
      }
      this.sceneIndex += 1;
      this.offsetMs = 0;
      this.enterScene();
    }
  }

  private emit(): void {
    this.deps.onChange?.(this.getSnapshot());
  }
}

// --- keyboard ---------------------------------------------------------------------------------------------------------------

export type PreviewShortcut = "toggle" | "next" | "prev" | "home" | "stop";

type ShortcutTarget = { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null; closest?: (selector: string) => unknown } | null;
export type ShortcutEventLike = {
  key: string;
  code?: string;
  target?: unknown;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
};

/** Typing / form / dialog targets: no preview shortcut there (the key belongs to the field or the dialog). */
const TYPING_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='searchbox'], [role='combobox'], [role='spinbutton']";
const DIALOG_SELECTOR = "[role='dialog'], [role='alertdialog'], [aria-modal='true'], dialog";
const OPT_OUT_SELECTOR = "[data-preview-shortcuts='off']";
/** The timeline track already uses Left / Right / Esc (move the selection / close the split): those stay with it. */
const TRACK_SELECTOR = "[data-timeline-track]";
/** Space on a focused button / link activates it (standard keyboard navigation) unless the button sits in the preview area. */
const INTERACTIVE_SELECTOR = "button, a[href], [role='button'], [role='tab'], [role='menuitem'], [role='option'], [role='checkbox'], [role='switch'], summary";
const PREVIEW_AREA_SELECTOR = "[data-preview-shortcuts='on']";

const matches = (target: ShortcutTarget, selector: string): boolean => {
  if (!target || typeof target.closest !== "function") return false;
  try {
    return Boolean(target.closest(selector));
  } catch {
    return false;
  }
};

/** The action of a keydown, or `null` when the key must be left alone (typing, dialog, modifier, repeat, a button's own Space...). */
export function previewShortcutAction(event: ShortcutEventLike, options: { dialogOpen?: boolean } = {}): PreviewShortcut | null {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = (event.target ?? null) as ShortcutTarget;
  if (options.dialogOpen) return null;
  if (target?.isContentEditable || matches(target, TYPING_SELECTOR) || matches(target, DIALOG_SELECTOR) || matches(target, OPT_OUT_SELECTOR)) return null;
  const isSpace = event.key === " " || event.key === "Spacebar" || event.code === "Space";
  if (isSpace) {
    if (event.repeat) return null; // holding Space must not flicker play / pause
    // The Play button handles its own Space (native click); any other button outside the preview area keeps its Space too.
    if (matches(target, "[data-preview-play]")) return null;
    if (matches(target, INTERACTIVE_SELECTOR) && !matches(target, PREVIEW_AREA_SELECTOR)) return null;
    return "toggle";
  }
  if (matches(target, TRACK_SELECTOR) && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Escape")) return null;
  if (matches(target, INTERACTIVE_SELECTOR) && !matches(target, PREVIEW_AREA_SELECTOR) && event.key !== "Escape") return null;
  if (event.key === "ArrowRight") return "next";
  if (event.key === "ArrowLeft") return "prev";
  if (event.key === "Home") return "home";
  if (event.key === "Escape") return "stop";
  return null;
}

type KeyTarget = { addEventListener: (type: "keydown", listener: (event: KeyboardEventLike) => void) => void; removeEventListener: (type: "keydown", listener: (event: KeyboardEventLike) => void) => void };
type KeyboardEventLike = ShortcutEventLike & { preventDefault?: () => void };

/** Binds the preview shortcuts on `target` (window); returns the cleanup that removes exactly that listener. */
export function bindPreviewShortcuts(target: KeyTarget, controller: Pick<PreviewPlaybackController, PreviewShortcut>, options: { dialogOpen?: () => boolean; enabled?: () => boolean } = {}): () => void {
  const listener = (event: KeyboardEventLike) => {
    if (options.enabled && !options.enabled()) return;
    const action = previewShortcutAction(event, { dialogOpen: options.dialogOpen?.() ?? false });
    if (!action) return;
    event.preventDefault?.(); // Space would otherwise scroll the page
    controller[action]();
  };
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener("keydown", listener);
}

// --- media sync -------------------------------------------------------------------------------------------------------------

export type MediaLike = { currentTime: number; paused?: boolean; readyState?: number; play: () => Promise<unknown> | unknown; pause: () => void };

/** HTMLMediaElement.HAVE_CURRENT_DATA: the current frame can be shown. */
const HAVE_CURRENT_DATA = 2;

export const mediaBuffering = (...elements: ReadonlyArray<MediaLike | null | undefined>): boolean =>
  elements.some((element) => element != null && (element.readyState ?? HAVE_CURRENT_DATA) < HAVE_CURRENT_DATA);

/**
 * Puts the scene's video (its source range, muted) and voice at the clock's `offsetMs` and plays / pauses both together. `seek` is
 * done on a scene entry and on resume, so the picture, the voice and the playhead start from the same instant.
 */
export function syncPreviewMedia(
  media: { video?: MediaLike | null; audio?: MediaLike | null },
  state: { playing: boolean; offsetMs: number; sourceStartMs?: number | null; sourceDurationMs?: number | null; seek: boolean },
): void {
  const { video, audio } = media;
  if (state.seek) {
    if (video) {
      const range = state.sourceDurationMs != null && state.sourceDurationMs > 0 ? state.sourceDurationMs : Number.POSITIVE_INFINITY;
      video.currentTime = ((state.sourceStartMs ?? 0) + Math.min(state.offsetMs, range)) / 1000;
    }
    if (audio) audio.currentTime = state.offsetMs / 1000;
  }
  for (const element of [video, audio]) {
    if (!element) continue;
    if (state.playing) void Promise.resolve(element.play()).catch(() => undefined);
    else element.pause();
  }
}

/** Pauses the elements of the scene that is being left (an old voice never keeps playing under the next scene). */
export function releasePreviewMedia(...elements: ReadonlyArray<MediaLike | null | undefined>): void {
  for (const element of elements) element?.pause();
}

/** Scene durations of the preview: the voice when there is one, else the video range, else the scene's hint. Excluded scenes are skipped. */
export function previewSceneTimings(
  scenes: ReadonlyArray<{ sceneId: string; excluded?: boolean; audioDurationMs?: number | null; sourceDurationMs?: number | null; durationHintMs: number }>,
): PreviewSceneTiming[] {
  return scenes
    .filter((scene) => !scene.excluded)
    .map((scene) => ({
      sceneId: scene.sceneId,
      durationMs: Math.max(500, Math.round(scene.audioDurationMs && scene.audioDurationMs > 0 ? scene.audioDurationMs : scene.sourceDurationMs && scene.sourceDurationMs > 0 ? scene.sourceDurationMs : scene.durationHintMs > 0 ? scene.durationHintMs : 3000)),
    }));
}
