import { useTranslation } from "react-i18next";
import type { RenderJobResponse } from "@lyonix/contracts";
import { Banner } from "./chrome";

/** Status from the persisted render job. Polling remains in StudioProPage. */
export function RenderProgress({ job }: { job: RenderJobResponse }) {
  const { t } = useTranslation();
  const clips = job.clipPreparation;
  return (
    <Banner variant={job.status === "failed" ? "danger" : "info"}>
      <div>{t("studioPro.renderStatusLabel", { status: job.status === "preparing_clips" ? t("studioPro.renderPreparing") : job.status })}</div>
      {job.status === "preparing_clips" && clips.clipsTotal > 0 ? (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={clips.clipsTotal} aria-valuenow={clips.clipsReady}>
          {t("studioPro.renderClipsProgress", { ready: clips.clipsReady, total: clips.clipsTotal })}
        </div>
      ) : null}
      {clips.failed.map((failure, index) => (
        <div key={`${failure.sceneId}-${index}`} role="alert">
          {t("studioPro.renderClipFailure", { scene: failure.sceneId || "—", code: failure.code, message: failure.message })}
        </div>
      ))}
      {job.status === "failed" && job.lastError && clips.failed.length === 0 ? <div role="alert">{job.lastError.code}: {job.lastError.message}</div> : null}
    </Banner>
  );
}
