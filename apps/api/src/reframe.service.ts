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

@Injectable()
export class ReframeService {
  constructor(@Inject(MediaJobsGateway) private readonly analyzer: ReframeAnalyzer) {}

  /** Test seam (not DI-injected); production reads the env on each call. */
  fixedPolicy: ReframePolicy | undefined;

  log: (message: string) => void = (message) => console.info(message);
  warn: (message: string) => void = (message) => console.warn(message);

  policy(): ReframePolicy {
    return this.fixedPolicy ?? reframePolicyFromEnv();
  }

  enabledFor(origin: string): boolean {
    return reframeEnabledForOrigin(this.policy(), origin);
  }

  /** Plans the crop for `source` (video: the window that will be cut; image: omit the window). */
  async plan(source: ReframeSourceRef, window: ReframeWindow | null, options: { preferredSubject?: ReframeSubjectPreference } = {}): Promise<ReframeDecision> {
    const policy = this.policy();
    if (!policy.enabled) return { status: "skipped", reason: "disabled" };
    if (!reframeEnabledForOrigin(policy, source.origin)) return { status: "skipped", reason: "origin_not_enabled" };
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
