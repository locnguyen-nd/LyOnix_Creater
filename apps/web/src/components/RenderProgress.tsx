import { useTranslation } from "react-i18next";
import type { RenderJobResponse } from "@lyonix/contracts";
import { summarizeRenderEngine, engineNameKey, routeReasonKey } from "../studio/render-engine";
import { Banner } from "./chrome";

/** VE2E-52b: true when Creatomate's actual output is smaller than the template canvas (e.g. 270x480 of 1080x1920). Old jobs without the fields -> false. */
export function isOutputBelowCanvas(job: Pick<RenderJobResponse, "outputWidth" | "outputHeight" | "canvasWidth" | "canvasHeight">): boolean {
  const { outputWidth: w, outputHeight: h, canvasWidth: cw, canvasHeight: ch } = job;
  if (!w || !h || !cw || !ch) return false;
  return w < cw || h < ch;
}

/** Status from the persisted render job. Polling remains in StudioProPage. */
export function RenderProgress({ job }: { job: RenderJobResponse }) {
  const { t } = useTranslation();
  const clips = job.clipPreparation;
  const showResolution = Boolean(job.outputWidth && job.outputHeight);
  const engine = summarizeRenderEngine(job);
  return (
    <Banner variant={job.status === "failed" ? "danger" : "info"}>
      <div>{t("studioPro.renderStatusLabel", { status: job.status === "preparing_clips" ? t("studioPro.renderPreparing") : job.status })}</div>
      {job.status === "preparing_clips" && clips.clipsTotal > 0 ? (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={clips.clipsTotal} aria-valuenow={clips.clipsReady}>
          {t("studioPro.renderClipsProgress", { ready: clips.clipsReady, total: clips.clipsTotal })}
        </div>
      ) : null}
      {engine ? (
        <div data-testid="render-engine">
          <div>{t("renderEngine.engineLine", { engine: t(engineNameKey(engine.engine)) })}</div>
          {engine.reason ? <div>{t("renderEngine.reasonLine", { reason: t(routeReasonKey(engine.reason)) })}</div> : null}
          {engine.isFallback && engine.fallbackOfJobId ? <div>{t("renderEngine.fallbackOf", { id: engine.fallbackOfJobId.slice(0, 8) })}</div> : null}
          {engine.internalProgress !== null ? <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={engine.internalProgress}>{t("renderEngine.internalProgress", { percent: engine.internalProgress })}</div> : null}
          {engine.qcFailedCodes.length > 0 ? <div role="alert">{t("renderEngine.qcFailed", { codes: engine.qcFailedCodes.join(", ") })}</div> : null}
        </div>
      ) : null}
      {job.queuePosition ? (
        <div role="status">{t(job.queueKind === "render" ? "studioPro.renderQueueProvider" : "studioPro.renderQueueMedia", { position: job.queuePosition })}</div>
      ) : null}
      {clips.failed.map((failure, index) => (
        <div key={`${failure.sceneId}-${index}`} role="alert">
          {t("studioPro.renderClipFailure", { scene: failure.sceneId || "—", code: failure.code, message: failure.message })}
        </div>
      ))}
      {showResolution ? <div>{t("studioPro.renderOutputResolution", { width: job.outputWidth, height: job.outputHeight, scale: job.outputRenderScale ?? "?" })}</div> : null}
      {isOutputBelowCanvas(job) ? <div role="alert">{t("studioPro.renderOutputBelowCanvas", { canvasWidth: job.canvasWidth, canvasHeight: job.canvasHeight })}</div> : null}
      {job.status === "failed" && job.lastError && clips.failed.length === 0 ? <div role="alert">{job.lastError.code}: {job.lastError.message}</div> : null}
    </Banner>
  );
}
