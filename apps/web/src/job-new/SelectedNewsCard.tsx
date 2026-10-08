import { useTranslation } from "react-i18next";
import { ExternalLink, X } from "lucide-react";
import type { NewsItemResponse } from "@lyonix/contracts";
import { NewsMeta, NewsThumb } from "../news/NewsCard";

/** VE2E-96: the news item the video is made from, shown in the form above its topic (only while one is picked). */
export function SelectedNewsCard({ item, onClear }: { item: NewsItemResponse; onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-muted/40 p-2.5" data-testid="selected-news">
      <p className="text-[10.5px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("news.selectedTitle")}</p>
      <div className="flex gap-2.5">
        <NewsThumb url={item.thumbnailUrl} className="h-[54px] w-[96px] flex-none rounded-[6px]" />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[12.5px] font-semibold leading-snug" title={item.title}>{item.title}</p>
          <NewsMeta item={item} now={Date.now()} />
        </div>
        <button type="button" className="h-7 w-7 flex-none rounded-[6px] text-lyx-fg-muted hover:bg-lyx-muted hover:text-lyx-fg" aria-label={t("news.clearSelected")} title={t("news.clearSelected")} onClick={onClear} data-testid="selected-news-clear">
          <X size={15} className="mx-auto" aria-hidden />
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-lyx-fg-muted">
        <span>{t("news.topicFromNews")}</span>
        <a className="inline-flex items-center gap-1 underline" href={item.sourceUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} aria-hidden /> {t("news.openOriginal")}</a>
      </div>
    </div>
  );
}
