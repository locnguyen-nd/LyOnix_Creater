/**
 * VE2E-124: framework-free autosave of the new-job draft.
 *  - debounce: a save starts `delayMs` (default 1.5 s) after the last change, never one request per keystroke;
 *  - single flight: at most one save request at a time; changes made meanwhile are saved right after, with the version the previous
 *    save returned - so an older request can never land after a newer one;
 *  - the server additionally refuses a save based on an outdated version (`VERSION_CONFLICT`): another tab or machine saved first.
 *    That is reported as `conflict` and autosave pauses until the user decides (overwrite or reload) - never a silent overwrite;
 *  - a failed save never touches the form: the payload stays pending and is retried on the next change or on `retry()`.
 */
export type DraftSaveStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string }
  | { kind: "conflict" };

export type DraftSaveResult = { version: number; updatedAt: string };

export type DraftAutosaverOptions<P> = {
  save: (payload: P, baseVersion: number | null) => Promise<DraftSaveResult>;
  onStatus: (status: DraftSaveStatus) => void;
  delayMs?: number;
  /** Tells a version conflict apart from any other failure. */
  isConflict?: (error: unknown) => boolean;
};

export const DRAFT_AUTOSAVE_DELAY_MS = 1500;

export class DraftAutosaver<P> {
  private enabled = false;
  private version: number | null = null;
  private pending: P | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private paused = false;

  constructor(private readonly options: DraftAutosaverOptions<P>) {}

  /** Starts autosaving (only once the form is restored, so initial defaults can never overwrite a stored draft). */
  start(version: number | null): void {
    this.enabled = true;
    this.paused = false;
    this.version = version;
  }

  /** Stops everything and drops pending changes (after a successful submit or when the draft is deleted). */
  stop(): void {
    this.enabled = false;
    this.pending = null;
    this.clearTimer();
  }

  /** Resolves once no save request is in flight (so a delete that follows can never be undone by a late create). */
  async idle(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  get currentVersion(): number | null {
    return this.version;
  }

  /** Adopts the server's current version (after a conflict) - the next save then overwrites it, as the user asked. */
  adoptVersion(version: number | null): void {
    this.version = version;
    this.paused = false;
  }

  /** A change happened: save it after the debounce delay. */
  schedule(payload: P): void {
    if (!this.enabled) return;
    this.pending = payload;
    if (this.paused) return;
    this.clearTimer();
    this.options.onStatus({ kind: "pending" });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.options.delayMs ?? DRAFT_AUTOSAVE_DELAY_MS);
  }

  /** "Lưu bản nháp": save this payload now (enables autosave if it was not yet). Resolves once nothing is left to save. */
  async flush(payload: P): Promise<void> {
    this.enabled = true;
    this.paused = false;
    this.pending = payload;
    this.clearTimer();
    await this.drain();
  }

  /** Saves a change still waiting for its debounce right away (the page is being left); no-op when nothing is pending or autosave is stopped. */
  flushPending(): Promise<void> {
    if (!this.enabled || this.paused || this.pending === null) return Promise.resolve();
    this.clearTimer();
    return this.drain();
  }

  /** Retries the pending payload after an error. */
  retry(): Promise<void> {
    this.paused = false;
    this.clearTimer();
    return this.drain();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Saves pending payloads one at a time until none is left, or until a save fails. */
  private async drain(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      if (this.pending !== null && this.enabled && !this.paused) await this.drain();
      return;
    }
    if (this.pending === null || !this.enabled) return;
    const payload = this.pending;
    this.pending = null;
    this.options.onStatus({ kind: "saving" });
    let failed = false;
    this.inFlight = this.options
      .save(payload, this.version)
      .then((result) => {
        this.version = result.version;
        if (this.pending === null) this.options.onStatus({ kind: "saved", at: new Date(result.updatedAt) });
      })
      .catch((error: unknown) => {
        failed = true;
        // Keep what the user typed: the newest unsaved payload stays pending (a newer change wins over the failed one).
        this.pending = this.pending ?? payload;
        if (this.options.isConflict?.(error)) {
          this.paused = true;
          this.options.onStatus({ kind: "conflict" });
        } else {
          this.options.onStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
      })
      .finally(() => {
        this.inFlight = null;
      });
    await this.inFlight;
    if (!failed && this.pending !== null && this.enabled && !this.paused) await this.drain();
  }
}
