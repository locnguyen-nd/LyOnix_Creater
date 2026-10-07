/**
 * VE2E-67 (CR-SUBJECT-REFRAME-2026-10-02 §3): API-side decision "should this source be reframed, and with which crop plan?".
 * Asks `apps/media-worker` (the only process with FFmpeg + the local detectors) for a `reframe.analyze` plan through the gateway
 * and returns a tagged outcome. Nothing is silent: an analysis that cannot run (MODEL_NOT_AVAILABLE, worker down, timeout) is logged
 * as a WARNING and returned as `legacy_fallback` (old centre crop, allowed by `REFRAME_LEGACY_FALLBACK`, default on) or as `failed`
 * (fallback switched off). No DB access, no provider call.
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  buildReframeAnalyzeJobKey,
  cropPlanDigest,
  MediaJobClientError,
  type ReframeAnalyzeSuccess,
  type ReframeCropPlan,
  type ReframeSubjectPreference,
} from "@lyonix/media-jobs";
import { MediaJobsGateway, type ReframeAnalyzer } from "./media-jobs.gateway.js";
import { reframeEnabledForOrigin, reframePolicyFromEnv, type ReframePolicy } from "./reframe-policy.js";

export type ReframeSourceRef = {
  id: string;
  kind: "video" | "image";
  /** `MediaAssetVersion.origin`. */
  origin: string;
  relativePath: string;
  checksumSha256?: string | null;
};

export type ReframeWindow = { startMs: number; durationMs: number };

export type ReframePlanned = {
  status: "planned";
  cropPlan: ReframeCropPlan;
  cropPlanSha256: string;
  overlayUnavoidable: boolean;
  residualOverlayPct: number;
  subjectCoveragePct: number;
  zoomPermille: number;
  confidenceLevel: "high" | "medium" | "low";
  warnings: string[];
  analysisJobKey: string;
  analysisReused: boolean;
  tool: ReframeAnalyzeSuccess["tool"];
};
export type ReframeSkipped = { status: "skipped"; reason: "disabled" | "origin_not_enabled" };
/** Analysis could not run; the OLD blind centre crop is used (policy allows it). Always accompanied by a logged warning. */
export type ReframeLegacyFallback = { status: "legacy_fallback"; code: string; message: string };
/** Analysis could not run and the policy forbids the legacy crop: the caller must fail. */
export type ReframeFailed = { status: "failed"; code: string; message: string; retryable: boolean };
export type ReframeDecision = ReframePlanned | ReframeSkipped | ReframeLegacyFallback | ReframeFailed;

const SHA256_RE = /^[0-9a-f]{64}$/;

/** VE2E-134: a window within this distance of an already-analysed one reuses its plan (early cut estimate vs. real post-TTS range). */
export const REFRAME_WINDOW_TOLERANCE_MS = 300;
const REFRAME_CACHE_TTL_MS = 30 * 60_000;
const REFRAME_CACHE_MAX_SOURCES = 500;

type ReframeCacheEntry = { startMs: number | null; durationMs: number | null; subject: string; at: number; pending: Promise<ReframeDecision> };

@Injectable()
export class ReframeService {
  constructor(@Inject(MediaJobsGateway) private readonly analyzer: ReframeAnalyzer) {}

  /** Test seam (not DI-injected); production reads the env on each call. */
  fixedPolicy: ReframePolicy | undefined;

  /** Overridable in tests (not DI-injected). */
  now: () => number = () => Date.now();

  /**
   * VE2E-134: in-process cache of analysis decisions keyed by source identity (checksum, else asset id) + origin + subject, then by window
   * (tolerance 300 ms). Only successful `planned` decisions stay cached; in-flight analyses are shared (no duplicate worker job).
   */
  private readonly cache = new Map<string, ReframeCacheEntry[]>();
  /** Number of analyses that actually reached the worker (tests/diagnostics). */
  analyzeCalls = 0;

  log: (message: string) => void = (message) => console.info(message);
  warn: (message: string) => void = (message) => console.warn(message);

  policy(): ReframePolicy {
    return this.fixedPolicy ?? reframePolicyFromEnv();
  }

  enabledFor(origin: string): boolean {
    return reframeEnabledForOrigin(this.policy(), origin);
  }

  /**
   * Plans the crop for `source` (video: the window that will be cut; image: omit the window). VE2E-134: the same source (checksum) +
   * window (within 300 ms) is analysed once; call this only for sources that were actually chosen, never for rejected candidates.
   */
  async plan(source: ReframeSourceRef, window: ReframeWindow | null, options: { preferredSubject?: ReframeSubjectPreference } = {}): Promise<ReframeDecision> {
    const policy = this.policy();
    if (!policy.enabled) return { status: "skipped", reason: "disabled" };
    if (!reframeEnabledForOrigin(policy, source.origin)) return { status: "skipped", reason: "origin_not_enabled" };
    const checksum = source.checksumSha256 && SHA256_RE.test(source.checksumSha256) ? source.checksumSha256 : null;
    const startMs = source.kind === "video" && window ? window.startMs : null;
    const durationMs = source.kind === "video" && window ? window.durationMs : null;
    const cacheKey = `${checksum ?? `id:${source.id}`}|${source.kind}|${source.origin}`;
    const subject = options.preferredSubject ?? "";
    const nowMs = this.now();
    const entries = (this.cache.get(cacheKey) ?? []).filter((e) => nowMs - e.at < REFRAME_CACHE_TTL_MS);
    const hit = entries.find(
      (e) =>
        e.subject === subject &&
        (startMs === null || durationMs === null
          ? e.startMs === null
          : e.startMs !== null && e.durationMs !== null && Math.abs(e.startMs - startMs) <= REFRAME_WINDOW_TOLERANCE_MS && Math.abs(e.durationMs - durationMs) <= REFRAME_WINDOW_TOLERANCE_MS),
    );
    if (hit) return hit.pending;
    const pending = this.analyze(source, window, options, policy);
    const entry: ReframeCacheEntry = { startMs, durationMs, subject, at: nowMs, pending };
    entries.push(entry);
    this.cache.set(cacheKey, entries);
    if (this.cache.size > REFRAME_CACHE_MAX_SOURCES) this.cache.delete(this.cache.keys().next().value as string);
    void pending.then(
      (decision) => {
        if (decision.status !== "planned") this.evict(cacheKey, entry); // fallbacks/failures may be transient: retry next time
      },
      () => this.evict(cacheKey, entry),
    );
    return pending;
  }

  private evict(cacheKey: string, entry: ReframeCacheEntry): void {
    const rest = (this.cache.get(cacheKey) ?? []).filter((e) => e !== entry);
    if (rest.length > 0) this.cache.set(cacheKey, rest);
    else this.cache.delete(cacheKey);
  }

  private async analyze(source: ReframeSourceRef, window: ReframeWindow | null, options: { preferredSubject?: ReframeSubjectPreference }, policy: ReframePolicy): Promise<ReframeDecision> {
    this.analyzeCalls += 1;
    const sourceSha256 = source.checksumSha256 && SHA256_RE.test(source.checksumSha256) ? source.checksumSha256 : null;
    const startMs = source.kind === "video" && window ? window.startMs : null;
    const durationMs = source.kind === "video" && window ? window.durationMs : null;
    const jobKey = buildReframeAnalyzeJobKey({
      ...(sourceSha256 ? { sourceSha256 } : { sourceMediaAssetVersionId: source.id }),
      startMs,
      durationMs,
      origin: source.origin,
      preferredSubject: options.preferredSubject ?? null,
    });
    const failure = (code: string, message: string, retryable: boolean): ReframeLegacyFallback | ReframeFailed => {
      if (policy.legacyFallback) {
        this.warn(`[reframe] WARNING analysis unavailable for asset=${source.id} (${code}): ${message} - using the legacy centre crop (REFRAME_LEGACY_FALLBACK=1)`);
        return { status: "legacy_fallback", code, message };
      }
      this.warn(`[reframe] analysis failed for asset=${source.id} (${code}): ${message} - legacy fallback is disabled, the caller fails`);
      return { status: "failed", code, message, retryable };
    };
    let result;
    try {
      result = await this.analyzer.analyzeReframe(
        {
          jobKey,
          source: { relativePath: source.relativePath, mediaAssetVersionId: source.id, kind: source.kind, ...(sourceSha256 ? { sourceSha256 } : {}) },
          startMs,
          durationMs,
          origin: source.origin,
          preferredSubject: options.preferredSubject ?? null,
        },
        { timeoutMs: policy.analyzeTimeoutMs },
      );
    } catch (error) {
      const code = error instanceof MediaJobClientError ? error.code : "REFRAME_ANALYZE_ERROR";
      return failure(code, error instanceof Error ? error.message : "reframe analysis error", true);
    }
    if (!result.ok) return failure(result.error.code, result.error.message, result.error.retryable);
    const cropPlan = result.cropPlan;
    const decision: ReframePlanned = {
      status: "planned",
      cropPlan,
      cropPlanSha256: cropPlanDigest(cropPlan),
      overlayUnavoidable: result.overlayUnavoidable,
      residualOverlayPct: cropPlan.residualOverlayPct,
      subjectCoveragePct: cropPlan.subjectCoveragePct,
      zoomPermille: cropPlan.zoomPermille,
      confidenceLevel: result.confidence.level,
      warnings: [...result.analysis.warnings],
      analysisJobKey: result.jobKey,
      analysisReused: result.reused,
      tool: result.tool,
    };
    if (decision.overlayUnavoidable) {
      this.warn(`[reframe] WARNING overlay_unavoidable asset=${source.id}: ~${decision.residualOverlayPct}% of the overlay area stays in the frame at zoom ${decision.zoomPermille}/1000`);
    }
    return decision;
  }
}
