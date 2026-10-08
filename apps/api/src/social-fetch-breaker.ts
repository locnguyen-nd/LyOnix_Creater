/**
 * VE2E-146 (CR-MEDIA-OSS-FETCH §3.2): per-platform circuit breaker for the open-source download tools. When too many recent downloads of a
 * platform end in an ACCESS failure (403 / bot check / cookies / 429 - i.e. the platform is blocking this server), the tools are skipped for
 * a cool-down so segments go straight to the fallback (Apify / next candidate) instead of burning their deadline. After the cool-down ONE
 * probe request is let through (half-open): success closes the breaker, another access failure re-opens it.
 *
 * Process-local (each API/worker process learns on its own; no DB write on the hot path). Failures that say nothing about blocking
 * (deleted post, too large, tool missing) are not recorded.
 */

export type BreakerConfig = { windowMs: number; ratio: number; minSamples: number; cooldownMs: number };

export const breakerConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): BreakerConfig => {
  const num = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    windowMs: num("MEDIA_FETCH_BREAKER_WINDOW_MS", 10 * 60_000, 10_000, 24 * 60 * 60_000),
    ratio: num("MEDIA_FETCH_BREAKER_RATIO", 0.5, 0.05, 1),
    minSamples: Math.floor(num("MEDIA_FETCH_BREAKER_MIN_SAMPLES", 4, 1, 1000)),
    cooldownMs: num("MEDIA_FETCH_BREAKER_COOLDOWN_MS", 15 * 60_000, 10_000, 24 * 60 * 60_000),
  };
};

type State = { samples: Array<{ at: number; blocked: boolean }>; openUntil: number; probing: boolean };

export class PlatformBreaker {
  private readonly states = new Map<string, State>();

  constructor(private readonly config: BreakerConfig = breakerConfigFromEnv(), private readonly now: () => number = Date.now) {}

  private state(platform: string): State {
    let s = this.states.get(platform);
    if (!s) {
      s = { samples: [], openUntil: 0, probing: false };
      this.states.set(platform, s);
    }
    return s;
  }

  /**
   * May this platform's tools be used now? `false` while open. After the cool-down the first caller gets the half-open probe slot
   * (`true`) and later callers are refused until that probe is recorded.
   */
  allow(platform: string): boolean {
    const s = this.state(platform);
    if (s.openUntil === 0) return true;
    if (this.now() < s.openUntil || s.probing) return false;
    s.probing = true;
    return true;
  }

  /** Records the outcome of one download: `blocked` = an access failure, `false` = success. */
  record(platform: string, blocked: boolean): void {
    const s = this.state(platform);
    const at = this.now();
    if (s.probing || (s.openUntil !== 0 && at >= s.openUntil)) {
      s.probing = false;
      s.samples = [];
      s.openUntil = blocked ? at + this.config.cooldownMs : 0;
      return;
    }
    s.samples = s.samples.filter((x) => at - x.at <= this.config.windowMs);
    s.samples.push({ at, blocked });
    const blockedCount = s.samples.filter((x) => x.blocked).length;
    if (s.samples.length >= this.config.minSamples && blockedCount / s.samples.length >= this.config.ratio) {
      s.openUntil = at + this.config.cooldownMs;
      s.samples = [];
    }
  }

  /** For diagnostics / report:failures. */
  snapshot(): Record<string, { open: boolean; openUntil: string | null; recent: number; blocked: number }> {
    const out: Record<string, { open: boolean; openUntil: string | null; recent: number; blocked: number }> = {};
    for (const [platform, s] of this.states) {
      out[platform] = { open: s.openUntil > this.now(), openUntil: s.openUntil ? new Date(s.openUntil).toISOString() : null, recent: s.samples.length, blocked: s.samples.filter((x) => x.blocked).length };
    }
    return out;
  }
}
