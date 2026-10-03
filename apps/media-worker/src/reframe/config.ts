import { availableParallelism } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { reframeOptionsFromEnv, type PlanReframeOptions } from "@lyonix/domain";
import { MediaWorkerConfigError } from "../config.js";
import { DEFAULT_PRESET_MARGINS, type PresetMargins } from "./overlays.js";

export type ReframeConfig = {
  modelsDir: string;
  /** Long side of the analysis frames (DEC-2026-10-02-CAPACITY-250: ~320-480 px). */
  analysisLongSide: number;
  /** Frame sampling: ~1 frame / 1.5 s, at least 4 and at least 6 for clips >= 8 s, at most `maxFrames`. */
  maxFrames: number;
  /** OCR only on the top/bottom bands and on at most this many frames. */
  textMaxFrames: number;
  textTopPct: number;
  textBottomPct: number;
  presetMargins: PresetMargins;
  /** Reference logo JPEG paths (optional, may be empty) + how wide the logo is in the frame (% of frame width) + NCC threshold. */
  logoTemplates: string[];
  logoTemplateWidthPct: number;
  logoTemplateThreshold: number;
  /** Max reframe.analyze jobs doing detector work at once in this process (the rest wait), default floor(cpus / 4) >= 1. */
  concurrency: number;
  /** onnxruntime intra-op threads per session. */
  ortThreads: number;
  /** Planner options (REFRAME_MAX_ZOOM, ...). */
  plan: PlanReframeOptions & { maxZoomPermille: number };
};

const readInt = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new MediaWorkerConfigError(`${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
  return value;
};
const readFloat = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new MediaWorkerConfigError(`${name} must be a number in [${min}, ${max}] (got "${raw}")`);
  return value;
};

/**
 * Env (all optional): REFRAME_MODELS_DIR (default ./data/models), REFRAME_ANALYSIS_LONG_SIDE (448, 240..960), REFRAME_MAX_FRAMES (12, 4..24),
 * REFRAME_TEXT_MAX_FRAMES (4, 1..12), REFRAME_TEXT_TOP_PCT (25), REFRAME_TEXT_BOTTOM_PCT (60), REFRAME_LOGO_CORNER_WIDTH_PCT (30) /
 * REFRAME_LOGO_CORNER_HEIGHT_PCT (10), REFRAME_LOGO_TEMPLATES (comma separated JPEG paths), REFRAME_LOGO_TEMPLATE_WIDTH_PCT (12),
 * REFRAME_LOGO_TEMPLATE_THRESHOLD (0.8), REFRAME_CONCURRENCY (floor(cpus/4), 1..32), REFRAME_ORT_THREADS (1, 1..16),
 * REFRAME_MAX_ZOOM (1.35) / REFRAME_MAX_PAN_PX_PER_SEC / REFRAME_SMOOTHING_MS (planner).
 */
export function loadReframeConfig(env: NodeJS.ProcessEnv, repoRoot: string, cpuCount: number = availableParallelism()): ReframeConfig {
  const modelsRaw = env.REFRAME_MODELS_DIR?.trim() || "./data/models";
  const cpus = Math.max(1, Math.floor(cpuCount) || 1);
  return {
    modelsDir: isAbsolute(modelsRaw) ? modelsRaw : resolve(repoRoot, modelsRaw),
    analysisLongSide: readInt(env, "REFRAME_ANALYSIS_LONG_SIDE", 448, 240, 960),
    maxFrames: readInt(env, "REFRAME_MAX_FRAMES", 12, 4, 24),
    textMaxFrames: readInt(env, "REFRAME_TEXT_MAX_FRAMES", 4, 1, 12),
    textTopPct: readInt(env, "REFRAME_TEXT_TOP_PCT", 25, 0, 100),
    textBottomPct: readInt(env, "REFRAME_TEXT_BOTTOM_PCT", 60, 0, 100),
    presetMargins: {
      widthPct: readFloat(env, "REFRAME_LOGO_CORNER_WIDTH_PCT", DEFAULT_PRESET_MARGINS.widthPct, 0, 50),
      heightPct: readFloat(env, "REFRAME_LOGO_CORNER_HEIGHT_PCT", DEFAULT_PRESET_MARGINS.heightPct, 0, 50),
    },
    logoTemplates: (env.REFRAME_LOGO_TEMPLATES ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => (isAbsolute(p) ? p : resolve(repoRoot, p))),
    logoTemplateWidthPct: readFloat(env, "REFRAME_LOGO_TEMPLATE_WIDTH_PCT", 12, 2, 60),
    logoTemplateThreshold: readFloat(env, "REFRAME_LOGO_TEMPLATE_THRESHOLD", 0.8, 0.3, 0.99),
    concurrency: readInt(env, "REFRAME_CONCURRENCY", Math.max(1, Math.floor(cpus / 4)), 1, 32),
    ortThreads: readInt(env, "REFRAME_ORT_THREADS", 1, 1, 16),
    plan: reframeOptionsFromEnv(env),
  };
}
