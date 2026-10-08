import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink, Newspaper } from "lucide-react";
import type { NewsItemResponse } from "@lyonix/contracts";
import { Button } from "../components/ui";
import { relativeNewsTime } from "./news-format";

/** Picture of a news item, or a neutral placeholder when it has none / it fails to load (the feed's own image URL, never re-hosted). */
export function NewsThumb({ url, className = "" }: { url: string | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`overflow-hidden bg-lyx-muted ${className}`}>
      {url && !broken ? (
        <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-lyx-fg-subtle"><Newspaper size={20} strokeWidth={1.75} aria-hidden /></div>
      )}
    </div>
  );
}

/** "スポーツ報知 · Yahoo!ニュース · 5 phút trước". */
export function NewsMeta({ item, now }: { item: NewsItemResponse; now: number }) {
  const { t, i18n } = useTranslation();
  const when = relativeNewsTime(item.publishedAt, now, i18n.language, t("news.justNow"));
  return (
    <p className="truncate text-[11px] text-lyx-fg-muted">
      {[item.publisher, item.source].filter(Boolean).join(" · ")}
      {when && item.publishedAt ? <> · <time dateTime={item.publishedAt}>{when}</time></> : null}
    </p>
  );
}

export function NewsCard({ item, selected, now, onUse }: { item: NewsItemResponse; selected: boolean; now: number; onUse: (item: NewsItemResponse) => void }) {
  const { t } = useTranslation();
  return (
    <article
      className={`flex min-w-0 flex-col overflow-hidden rounded-[var(--lyx-radius)] border bg-lyx-bg transition-colors ${selected ? "border-lyx-fg ring-1 ring-lyx-fg" : "border-lyx-border hover:border-lyx-fg-subtle"}`}
      data-testid="news-card"
      data-news-id={item.id}
    >
      <div className="relative">
        <NewsThumb url={item.thumbnailUrl} className="aspect-[16/9] w-full" />
        <span className="absolute left-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[10.5px] font-semibold text-white">{t(`news.filter.${item.category}`)}</span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <h3 className="line-clamp-2 text-[13.5px] font-semibold leading-snug" title={item.title}>{item.title}</h3>
        <NewsMeta item={item} now={now} />
        {item.excerpt ? <p className="line-clamp-3 text-[12px] leading-[1.45] text-lyx-fg-muted">{item.excerpt}</p> : null}
        <div className="mt-auto flex items-center gap-2 pt-2">
          <Button variant={selected ? "secondary" : "primary"} className="h-8 flex-1 gap-1 px-2 text-[12px]" aria-pressed={selected} onClick={() => onUse(item)} data-testid="news-use">
            {selected ? <><Check size={14} aria-hidden /> {t("news.inUse")}</> : t("news.useItem")}
          </Button>
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="lyx-btn lyx-btn-ghost h-8 gap-1 px-2 text-[12px]"
            aria-label={t("news.openOriginalLabel", { source: item.publisher ?? item.source })}
            data-testid="news-open-original"
          >
            <ExternalLink size={14} aria-hidden /> {t("news.openOriginal")}
          </a>
        </div>
      </div>
    </article>
  );
}
