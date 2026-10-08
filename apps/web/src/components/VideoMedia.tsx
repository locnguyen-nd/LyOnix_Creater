import { Film, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function VideoThumbnail({ snapshotUrl, resultUrl, className = "" }: {
  snapshotUrl?: string | null | undefined;
  resultUrl?: string | null | undefined;
  className?: string;
}) {
  const target = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  // An expired snapshot URL would show the browser's broken-image glyph: drop it and keep the placeholder.
  const [failedSnapshot, setFailedSnapshot] = useState<string | null>(null);

  useEffect(() => {
    if (snapshotUrl || !resultUrl || !target.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "120px" });
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [snapshotUrl, resultUrl]);

  return (
    <div ref={target} className={`relative overflow-hidden bg-lyx-neutral-bg ${className}`}>
      <Film className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-lyx-fg-subtle" size={28} aria-hidden />
      {snapshotUrl && snapshotUrl !== failedSnapshot ? <img src={snapshotUrl} loading="lazy" alt="" onError={() => setFailedSnapshot(snapshotUrl)} className="lyx-fade absolute inset-0 h-full w-full object-cover" /> : null}
      {!snapshotUrl && resultUrl && visible ? (
        <video src={`${resultUrl}#t=0.1`} preload="metadata" muted playsInline aria-hidden tabIndex={-1} className="absolute inset-0 h-full w-full object-cover" />
      ) : null}
      <span className="absolute bottom-2 left-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">9:16</span>
    </div>
  );
}

export function VideoPlayerDialog({ title, caption, url, onClose }: {
  title: string;
  caption?: string | null;
  url: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [onClose]);

  return (
    <div className="lyx-anim-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="lyx-anim-modal w-full max-w-3xl rounded-xl bg-lyx-bg p-4 shadow-2xl sm:p-5">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="line-clamp-2 text-lg font-bold">{title}</h2>
            {caption ? <p className="mt-1 line-clamp-2 text-sm text-lyx-fg-muted">{caption}</p> : null}
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded-lg p-2 hover:bg-lyx-muted"><X size={20} /></button>
        </div>
        <div className="flex min-h-[260px] items-center justify-center rounded-lg bg-black">
          {failed ? <p className="p-5 text-center text-sm text-white">{t("videoGallery.playbackError")}</p> : (
            <video key={url} src={url} controls autoPlay playsInline onError={() => setFailed(true)} className="max-h-[70vh] max-w-full" />
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-lyx-fg-muted">
          <span className="inline-flex items-center gap-1"><Play size={13} />{t("videoGallery.playerHint")}</span>
          <a href={url} target="_blank" rel="noreferrer" className="underline">{t("videoGallery.openSource")}</a>
        </div>
      </div>
    </div>
  );
}
