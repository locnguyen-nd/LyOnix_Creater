import { useState } from "react";
import { useTranslation } from "react-i18next";
import { browserApiUrl } from "../studio/media-url";

/**
 * The finished video of an Auto run, with "open" and "download" links. An internal (LyOnix) render is stored with the server's
 * PUBLIC_BASE_URL - often a quick tunnel that has since expired - so it is re-pointed at the API origin the app already talks
 * to (a provider's own CDN link is left as is). When the browser cannot play it, the page says so instead of a blank player.
 */
export function RunResultPlayer({ resultUrl }: { resultUrl: string }) {
  const { t } = useTranslation();
  const url = browserApiUrl(resultUrl);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <>
      {failedUrl === url ? (
        <p className="mb-3 flex h-[240px] w-full items-center justify-center rounded-[6px] bg-lyx-bg-muted px-4 text-center text-[12.5px] text-lyx-fg-muted" role="alert" data-testid="run-result-error">{t("videoGallery.playbackError")}</p>
      ) : (
        <video key={url} className="mb-3 max-h-[420px] w-full rounded-[6px] bg-black" src={url} controls playsInline preload="metadata" onError={() => setFailedUrl(url)} data-testid="run-result-video" />
      )}
      <div className="flex gap-3">
        <a className="underline text-[12.5px]" href={url} target="_blank" rel="noreferrer">{t("videoProduction.openResult")}</a>
        <a className="underline text-[12.5px]" href={url} download>{t("videoProduction.download")}</a>
      </div>
    </>
  );
}
