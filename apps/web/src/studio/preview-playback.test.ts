import { afterEach, describe, expect, it, vi } from "vitest";
import { bindPreviewShortcuts, mediaBuffering, PreviewPlaybackController, previewSceneTimings, previewShortcutAction, releasePreviewMedia, syncPreviewMedia, type MediaLike } from "./preview-playback";

/** A fake animation-frame scheduler + wall clock: `advance(ms)` moves time and runs the pending frame. */
function harness(options: { buffering?: () => boolean } = {}) {
  let now = 0;
  let pending: (() => void) | null = null;
  let handles = 0;
  const cancelled: number[] = [];
  const entered: Array<[string, number]> = [];
  const controller = new PreviewPlaybackController({
    now: () => now,
    requestFrame: (callback) => {
      pending = callback;
      handles += 1;
      return handles;
    },
    cancelFrame: (handle) => {
      cancelled.push(handle);
      pending = null;
    },
    ...(options.buffering ? { isBuffering: options.buffering } : {}),
    onSceneEnter: (sceneId, offsetMs) => entered.push([sceneId, offsetMs]),
  });
  controller.setScenes([{ sceneId: "s1", durationMs: 2000 }, { sceneId: "s2", durationMs: 3000 }, { sceneId: "s3", durationMs: 1000 }]);
  const advance = (ms: number, step = 250) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      now += Math.min(step, ms - elapsed);
      const run = pending;
      pending = null;
      run?.();
    }
  };
  return { controller, advance, entered, cancelled, hasFrame: () => pending !== null };
}

// Element-like targets for the shortcut rules (no DOM in this test environment).
const el = (matching: string[], extra: Record<string, unknown> = {}) => ({ closest: (selector: string) => (matching.some((m) => selector.split(",").map((part) => part.trim()).includes(m)) ? {} : null), ...extra });
const key = (k: string, target: unknown, extra: Record<string, unknown> = {}) => ({ key: k, target, ...extra });
const body = el([]);

describe("Space play / pause", () => {
  it("Space 1 plays, Space 2 pauses, Play again resumes from the current time (no reset to the start)", () => {
    const { controller, advance } = harness();
    controller.toggle();
    expect(controller.getSnapshot()).toMatchObject({ playing: true, sceneId: "s1", offsetMs: 0 });
    advance(1200);
    controller.toggle();
    const paused = controller.getSnapshot();
    expect(paused).toMatchObject({ playing: false, sceneId: "s1" });
    expect(paused.offsetMs).toBe(1200);
    advance(5000); // time passes while paused: the clock does not move
    expect(controller.getSnapshot().offsetMs).toBe(1200);
    controller.toggle();
    advance(500);
    expect(controller.getSnapshot()).toMatchObject({ playing: true, sceneId: "s1", offsetMs: 1700 });
  });

  it("runs into the next scene at a scene's end, stops at the end of the timeline, and Space after the end restarts", () => {
    const { controller, advance, entered } = harness();
    controller.play();
    advance(2500);
    expect(controller.getSnapshot()).toMatchObject({ sceneId: "s2", offsetMs: 500, globalMs: 2500 });
    advance(4000);
    expect(controller.getSnapshot()).toMatchObject({ playing: false, ended: true, sceneId: "s3", offsetMs: 1000, globalMs: 6000, progress: 1 });
    expect(entered.map(([sceneId]) => sceneId)).toEqual(["s1", "s2", "s3"]);
    controller.toggle();
    expect(controller.getSnapshot()).toMatchObject({ playing: true, ended: false, sceneId: "s1", offsetMs: 0 });
  });

  it("Left / Right / Home / Esc: previous / next scene, start, stop", () => {
    const { controller } = harness();
    controller.next();
    expect(controller.getSnapshot().sceneId).toBe("s2");
    controller.next();
    controller.next();
    expect(controller.getSnapshot().sceneId).toBe("s3");
    controller.prev();
    expect(controller.getSnapshot().sceneId).toBe("s2");
    controller.home();
    expect(controller.getSnapshot().sceneId).toBe("s1");
    controller.play();
    controller.stop();
    expect(controller.getSnapshot()).toMatchObject({ playing: false, offsetMs: 0 });
  });

  it("media not loaded yet: the clock waits (buffering) and continues once loaded", () => {
    let loading = true;
    const { controller, advance } = harness({ buffering: () => loading });
    controller.play();
    advance(1000);
    expect(controller.getSnapshot()).toMatchObject({ playing: true, buffering: true, offsetMs: 0 });
    loading = false;
    advance(600);
    expect(controller.getSnapshot()).toMatchObject({ buffering: false, offsetMs: 600 });
  });

  it("reduced motion does not affect playback (the clock never reads it)", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", matchMedia);
    const { controller, advance } = harness();
    controller.play();
    advance(2500);
    expect(controller.getSnapshot()).toMatchObject({ sceneId: "s2", offsetMs: 500 });
    expect(matchMedia).not.toHaveBeenCalled();
  });
});

describe("shortcut rules", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("Space / arrows / Home / Esc map to actions on the page", () => {
    expect(previewShortcutAction(key(" ", body))).toBe("toggle");
    expect(previewShortcutAction({ key: "Unidentified", code: "Space", target: body })).toBe("toggle");
    expect(previewShortcutAction(key("ArrowRight", body))).toBe("next");
    expect(previewShortcutAction(key("ArrowLeft", body))).toBe("prev");
    expect(previewShortcutAction(key("Home", body))).toBe("home");
    expect(previewShortcutAction(key("Escape", body))).toBe("stop");
    expect(previewShortcutAction(key("a", body))).toBeNull();
  });

  it("never while typing: input, textarea, select, contenteditable, textbox / search, a subtitle / script editor", () => {
    for (const selector of ["input", "textarea", "select", "[contenteditable='true']", "[role='textbox']", "[role='searchbox']"]) {
      expect(previewShortcutAction(key(" ", el([selector])))).toBeNull();
    }
    expect(previewShortcutAction(key(" ", { ...el([]), isContentEditable: true }))).toBeNull();
  });

  it("never inside a dialog / modal, with a modifier, on a key repeat, or where the page opted out", () => {
    expect(previewShortcutAction(key(" ", el(["[role='dialog']"])))).toBeNull();
    expect(previewShortcutAction(key(" ", el(["[aria-modal='true']"])))).toBeNull();
    expect(previewShortcutAction(key(" ", body), { dialogOpen: true })).toBeNull();
    expect(previewShortcutAction(key(" ", body, { ctrlKey: true }))).toBeNull();
    expect(previewShortcutAction(key(" ", body, { repeat: true }))).toBeNull();
    expect(previewShortcutAction(key(" ", el(["[data-preview-shortcuts='off']"])))).toBeNull();
  });

  it("keyboard navigation keeps working: a button keeps its own Space, the timeline track keeps Left / Right / Esc", () => {
    expect(previewShortcutAction(key(" ", el(["button"])))).toBeNull(); // a nav / toolbar button elsewhere on the page
    expect(previewShortcutAction(key(" ", el(["button", "[data-preview-play]", "[data-preview-shortcuts='on']"])))).toBeNull(); // the Play button clicks itself
    expect(previewShortcutAction(key(" ", el(["button", "[data-preview-shortcuts='on']"])))).toBe("toggle"); // a scene clip of the timeline
    expect(previewShortcutAction(key("ArrowRight", el(["[data-timeline-track]", "[data-preview-shortcuts='on']"])))).toBeNull();
    expect(previewShortcutAction(key("Escape", el(["[data-timeline-track]"])))).toBeNull();
    expect(previewShortcutAction(key(" ", el(["[data-timeline-track]", "[data-preview-shortcuts='on']"])))).toBe("toggle");
  });

  it("the listener toggles, prevents the page scroll, and the cleanup removes exactly that listener", () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    const controller = { toggle: vi.fn(), next: vi.fn(), prev: vi.fn(), home: vi.fn(), stop: vi.fn() };
    const unbind = bindPreviewShortcuts(target as never, controller);
    const press = () => {
      const event = Object.assign(new Event("keydown"), { key: " ", preventDefault: vi.fn() });
      target.dispatchEvent(event);
      return event;
    };
    const first = press();
    expect(controller.toggle).toHaveBeenCalledTimes(1);
    expect(first.preventDefault).toHaveBeenCalled();
    unbind();
    press();
    expect(controller.toggle).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("keydown", add.mock.calls[0]![1]);
  });

  it("disposing the clock (closing Studio / another project) leaves no frame scheduled", () => {
    const { controller, hasFrame, cancelled } = harness();
    controller.play();
    expect(hasFrame()).toBe(true);
    controller.dispose();
    expect(hasFrame()).toBe(false);
    expect(cancelled.length).toBe(1);
    controller.dispose(); // twice is fine (React Strict Mode)
  });
});

describe("media sync", () => {
  const media = (readyState = 4): MediaLike & { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> } => ({ currentTime: 0, readyState, play: vi.fn(async () => undefined), pause: vi.fn() });

  it("video (its source range) and voice start at the clock's offset and play / pause together", () => {
    const video = media();
    const audio = media();
    syncPreviewMedia({ video, audio }, { playing: true, offsetMs: 1500, sourceStartMs: 4000, sourceDurationMs: 6000, seek: true });
    expect(video.currentTime).toBe(5.5);
    expect(audio.currentTime).toBe(1.5);
    expect(video.play).toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalled();
    syncPreviewMedia({ video, audio }, { playing: false, offsetMs: 1500, sourceStartMs: 4000, sourceDurationMs: 6000, seek: true });
    expect(video.pause).toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
  });

  it("an offset past the video range holds its last frame; a missing voice / video is fine", () => {
    const video = media();
    syncPreviewMedia({ video, audio: null }, { playing: true, offsetMs: 9000, sourceStartMs: 1000, sourceDurationMs: 3000, seek: true });
    expect(video.currentTime).toBe(4);
    expect(() => syncPreviewMedia({}, { playing: true, offsetMs: 0, seek: true })).not.toThrow();
  });

  it("switching scenes pauses the previous scene's voice + video; a manual pick while playing keeps playing there", () => {
    const oldVideo = media();
    const oldAudio = media();
    releasePreviewMedia(oldVideo, oldAudio, null);
    expect(oldVideo.pause).toHaveBeenCalled();
    expect(oldAudio.pause).toHaveBeenCalled();
    const { controller, entered } = harness();
    controller.play();
    controller.seekToScene("s3");
    expect(controller.getSnapshot()).toMatchObject({ playing: true, sceneId: "s3", offsetMs: 0 });
    expect(entered.at(-1)).toEqual(["s3", 0]);
  });

  it("buffering = an element that cannot show its current frame yet", () => {
    expect(mediaBuffering(media(1), null)).toBe(true);
    expect(mediaBuffering(media(4), media(2))).toBe(false);
    expect(mediaBuffering(null, undefined)).toBe(false);
  });

  it("scene timings: voice > video range > hint; excluded scenes are skipped", () => {
    expect(previewSceneTimings([
      { sceneId: "a", audioDurationMs: 2400, sourceDurationMs: 5000, durationHintMs: 3000 },
      { sceneId: "b", audioDurationMs: null, sourceDurationMs: 5000, durationHintMs: 3000 },
      { sceneId: "c", excluded: true, durationHintMs: 3000 },
      { sceneId: "d", durationHintMs: 0 },
    ])).toEqual([{ sceneId: "a", durationMs: 2400 }, { sceneId: "b", durationMs: 5000 }, { sceneId: "d", durationMs: 3000 }]);
  });
});
