import { previewCacheKey, type PreviewTarget } from "./voice-picker";

/**
 * Voice Picker playback: ONE audio element for the whole picker, so only one voice plays at a time and pressing another voice
 * stops the old one. The provider's preview URL is played as is (free); a voice without one gets a short TTS sample from the
 * API - fetched only when Play is pressed, then cached (here per session, and 24 h on the server), so it is paid once.
 * Framework-free: the React hook in VoicePicker subscribes to it.
 */
export type PreviewStatus = "idle" | "loading" | "playing" | "paused" | "error" | "unavailable";
export type PreviewState = {
  /** The voice the player holds (loading, playing, paused or unavailable). */
  activeId: string | null;
  status: PreviewStatus;
  /** Last failure per voice (error code), shown on its card until it is played again. */
  errors: Readonly<Record<string, string>>;
};

/** The part of HTMLAudioElement the controller uses (tests pass a fake). */
export type AudioLike = {
  src: string;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
};

export type PreviewDeps = {
  createAudio: () => AudioLike;
  /** Synthesize the sample for a voice without a provider preview (the API call that may cost credits). */
  fetchTts: (target: PreviewTarget) => Promise<Blob>;
  toUrl: (blob: Blob) => string;
  /** Shared across picker instances so a remount does not pay again. */
  cache?: Map<string, Promise<string>>;
};

/** Session cache of synthesized previews: cache key -> object URL. */
const sessionCache = new Map<string, Promise<string>>();

const codeOf = (error: unknown): string =>
  error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "PREVIEW_FAILED";

export class VoicePreviewController {
  private state: PreviewState = { activeId: null, status: "idle", errors: {} };
  private readonly listeners = new Set<() => void>();
  private audio: AudioLike | null = null;
  /** Bumped by every stop / new play: a preview that finishes loading after the user moved on is not played. */
  private token = 0;
  private readonly cache: Map<string, Promise<string>>;

  constructor(private readonly deps: PreviewDeps) {
    this.cache = deps.cache ?? sessionCache;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = (): PreviewState => this.state;

  /** What a card shows for its voice. */
  statusOf = (voiceId: string): PreviewStatus =>
    this.state.activeId === voiceId ? this.state.status : this.state.errors[voiceId] ? "error" : "idle";

  /** Play / pause / resume this voice; any other voice that was playing stops first. */
  toggle = async (target: PreviewTarget): Promise<void> => {
    const { activeId, status } = this.state;
    if (activeId === target.voiceId) {
      if (status === "loading") return;
      if (status === "playing") {
        this.player().pause();
        this.set({ status: "paused" });
        return;
      }
      if (status === "paused") {
        try {
          await this.player().play();
          this.set({ status: "playing" });
        } catch {
          this.fail(target.voiceId, "PLAYBACK_FAILED");
        }
        return;
      }
    }
    this.stop();
    if (!target.previewUrl && !target.accountId) {
      this.set({ activeId: target.voiceId, status: "unavailable" });
      return;
    }
    const token = ++this.token;
    const errors = { ...this.state.errors };
    delete errors[target.voiceId];
    this.set({ activeId: target.voiceId, status: "loading", errors });
    let src: string;
    try {
      src = target.previewUrl ?? (await this.synthesized(target));
    } catch (error) {
      if (token === this.token) this.fail(target.voiceId, codeOf(error));
      return;
    }
    if (token !== this.token) return;
    const audio = this.player();
    audio.src = src;
    audio.currentTime = 0;
    try {
      await audio.play();
    } catch {
      if (token === this.token) this.fail(target.voiceId, "PLAYBACK_FAILED");
      return;
    }
    if (token === this.token) this.set({ status: "playing" });
  };

  /** Stops whatever plays (another voice pressed, the voice list changed, the page left). */
  stop = () => {
    this.token += 1;
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    if (this.state.activeId !== null) this.set({ activeId: null, status: "idle" });
  };

  /** A synthesized preview, fetched once per cache key; a failed fetch is forgotten so it can be retried. */
  private synthesized(target: PreviewTarget): Promise<string> {
    const key = previewCacheKey(target);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.deps.fetchTts(target).then((blob) => this.deps.toUrl(blob));
      this.cache.set(key, pending);
      pending.catch(() => { if (this.cache.get(key) === pending) this.cache.delete(key); });
    }
    return pending;
  }

  private player(): AudioLike {
    if (!this.audio) {
      const audio = this.deps.createAudio();
      audio.onended = () => { if (this.state.status === "playing") this.set({ activeId: null, status: "idle" }); };
      audio.onerror = () => { const id = this.state.activeId; if (id && (this.state.status === "playing" || this.state.status === "loading")) this.fail(id, "PLAYBACK_FAILED"); };
      this.audio = audio;
    }
    return this.audio;
  }

  private fail(voiceId: string, code: string) {
    this.set({ activeId: null, status: "idle", errors: { ...this.state.errors, [voiceId]: code } });
  }

  private set(patch: Partial<PreviewState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
