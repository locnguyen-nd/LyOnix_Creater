import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { NewsItemResponse } from "@lyonix/contracts";
import { NewsFeed } from "./NewsFeed";

/**
 * VE2E-96: the news search, opened from "Tìm tin tức" above the create-video form (never shown permanently). A right-hand drawer like
 * the template library; on a phone it takes the whole screen. "Dùng tin này" hands the item to the page, which closes the drawer.
 */
export function NewsDrawer({ initialQuery, selectedId, onUse, onClose }: { initialQuery: string; selectedId: string | null; onUse: (item: NewsItemResponse) => void; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[var(--lyx-overlay)]" role="presentation" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t("news.title")} onClick={(event) => event.stopPropagation()} className="flex h-full w-full max-w-[960px] flex-col bg-lyx-bg shadow-xl" data-testid="news-drawer">
        <div className="flex items-center justify-between border-b border-lyx-border px-4 py-3">
          <h2 className="text-[15px] font-semibold">{t("news.title")}</h2>
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-[6px] text-lyx-fg-muted hover:bg-lyx-muted hover:text-lyx-fg" aria-label={t("common.close")} onClick={onClose} data-testid="news-drawer-close">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <NewsFeed selectedId={selectedId} initialQuery={initialQuery} autoFocus onUse={onUse} />
        </div>
      </div>
    </div>
  );
}
