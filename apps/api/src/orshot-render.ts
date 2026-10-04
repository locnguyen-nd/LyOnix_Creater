/**
 * Orshot-specific render planning (pure, no I/O): option validation, narration-fit duration and cost estimate.
 *
 * Orshot bills a video at 1 credit per second (rounded up) and a credit costs a plan-dependent amount
 * (Launch $39/1500, Grow $160/20000, Scale $349/75000), so the USD figure is an ESTIMATE driven by
 * `ORSHOT_CREDIT_USD` (default = Grow plan). Orshot exposes no balance/usage endpoint, so nothing here claims
 * to know the account's remaining credits.
 */
import type { OrshotRenderOptions } from "@lyonix/contracts";

export const ORSHOT_FORMATS = ["mp4", "webm", "mov", "gif"] as const;
export const ORSHOT_FPS = [24, 30, 60] as const;
/** Orshot size presets that make sense for short vertical/social video (smart-resize re-lays the template out). */
export const ORSHOT_SIZE_PRESETS = ["tiktok-video", "youtube-short", "instagram-story", "facebook-story", "whatsapp-status", "instagram-post-portrait", "instagram-post", "presentation-16-9"] as const;

const DEFAULT_CREDIT_USD = 160 / 20_000; // Grow plan
const DEFAULT_MAX_VIDEO_SECONDS = 180; // Free/Launch plan ceiling (Grow 300, Scale 600)

export type OrshotPricing = { creditUsd: number; maxVideoSeconds: number };

const positive = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return raw?.trim() && Number.isFinite(value) && value > 0 ? value : fallback;
};

export const resolveOrshotPricing = (env: Record<string, string | undefined> = process.env): OrshotPricing => ({
  creditUsd: positive(env.ORSHOT_CREDIT_USD, DEFAULT_CREDIT_USD),
  maxVideoSeconds: positive(env.ORSHOT_MAX_VIDEO_SECONDS, DEFAULT_MAX_VIDEO_SECONDS),
});

/** Whitelists client-supplied options; returns the cleaned set or an error message (never forwards arbitrary keys to Orshot). */
export function sanitizeOrshotOptions(raw: unknown): { ok: true; data: OrshotRenderOptions } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, data: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "orshot options không hợp lệ" };
  const input = raw as Record<string, unknown>;
  const out: OrshotRenderOptions = {};
  if (input.format !== undefined) {
    if (!(ORSHOT_FORMATS as readonly unknown[]).includes(input.format)) return { ok: false, message: `Định dạng Orshot không hỗ trợ: ${String(input.format)}` };
    out.format = input.format as NonNullable<OrshotRenderOptions["format"]>;
  }
  if (input.fps !== undefined) {
    if (!(ORSHOT_FPS as readonly unknown[]).includes(input.fps)) return { ok: false, message: `FPS Orshot không hỗ trợ: ${String(input.fps)}` };
    out.fps = input.fps as NonNullable<OrshotRenderOptions["fps"]>;
  }
  if (input.size !== undefined && input.size !== "") {
    if (!(ORSHOT_SIZE_PRESETS as readonly unknown[]).includes(input.size)) return { ok: false, message: `Kích thước Orshot không hỗ trợ: ${String(input.size)}` };
    out.size = input.size as string;
  }
  if (input.fitDurationToNarration !== undefined) out.fitDurationToNarration = input.fitDurationToNarration === true;
  return { ok: true, data: out };
}

export type OrshotCostEstimate = {
  durationSec: number;
  credits: number;
  creditUsd: number;
  amountUsd: string;
  maxVideoSeconds: number;
  exceedsPlanLimit: boolean;
};

/** Credits = whole seconds of video (rounded up); GIF/other formats bill the same per-second way for video templates. */
export function estimateOrshotCost(durationMs: number, pricing: OrshotPricing = resolveOrshotPricing()): OrshotCostEstimate {
  const durationSec = Math.max(0, Math.ceil(durationMs / 1000));
  const credits = durationSec;
  return {
    durationSec,
    credits,
    creditUsd: pricing.creditUsd,
    amountUsd: (credits * pricing.creditUsd).toFixed(4),
    maxVideoSeconds: pricing.maxVideoSeconds,
    exceedsPlanLimit: durationSec > pricing.maxVideoSeconds,
  };
}

/** Sum of non-excluded scenes' narration length: the video should be as long as the voice-over, not as long as the template's fixed timeline. */
export const narrationDurationMs = (scenes: Array<{ excluded?: boolean; audioDurationMs?: number | null }>): number =>
  scenes.reduce((sum, scene) => sum + (scene.excluded ? 0 : Math.max(0, scene.audioDurationMs ?? 0)), 0);
