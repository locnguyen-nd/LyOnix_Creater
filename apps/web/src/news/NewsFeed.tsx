import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, RefreshCw, Search } from "lucide-react";
import type { NewsFeedFilter, NewsFeedResponse, NewsItemResponse } from "@lyonix/contracts";
import { NEWS_FILTERS, dedupeNewsItems } from "@lyonix/domain/news";
import { ApiError } from "../api";
import { Button } from "../components/ui";
import { getNewsFeed } from "./news-api";
import { NewsCard } from "./NewsCard";

export type NewsFeedState = { loading: boolean; data: NewsFeedResponse | null; error: string | null };

const SEARCH_DEBOUNCE_MS = 300;

/**
 * VE2E-96: the news column of the create-video page - search, filter chips, cards. Browsing only reads the server's cached feeds:
 * no AI, TTS, render or paid provider call. "Dùng tin này" hands the item to the page (`onUse`); nothing is created here.
 */
export function NewsFeed({ selectedId, initialQuery = "", autoFocus = false, onUse }: { selectedId: string | null; initialQuery?: string; autoFocus?: boolean; onUse: (item: NewsItemResponse) => void }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<NewsFeedFilter>("all");
  const [input, setInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim());
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<NewsFeedState>({ loading: true, data: null, error: null });

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    getNewsFeed(filter, query, controller.signal)
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({ loading: false, data: prev.data, error: error instanceof ApiError ? error.message : t("news.error") }));
      });
    return () => controller.abort();
  }, [filter, query, attempt, t]);

  return (
    <NewsFeedView
      autoFocus={autoFocus}
      filter={filter}
      input={input}
      state={state}
      selectedId={selectedId}
      onFilter={setFilter}
      onInput={setInput}
      onClearSearch={() => { setInput(""); setQuery(""); }}
      onRetry={() => setAttempt((value) => value + 1)}
      onUse={onUse}
    />
  );
}

export function NewsFeedView({
  autoFocus = false,
  filter,
  input,
  state,
  selectedId,
  now = Date.now(),
  onFilter,
  onInput,
  onClearSearch,
  onRetry,
  onUse,
}: {
  autoFocus?: boolean;
  filter: NewsFeedFilter;
  input: string;
  state: NewsFeedState;
  selectedId: string | null;
  now?: number;
  onFilter: (filter: NewsFeedFilter) => void;
  onInput: (value: string) => void;
  onClearSearch: () => void;
  onRetry: () => void;
  onUse: (item: NewsItemResponse) => void;
}) {
  const { t } = useTranslation();
  const data = state.data;
  // the server already returns one item per story; a client-side pass keeps it true for any response
  const items = useMemo(() => (data ? (dedupeNewsItems(data.items) as NewsItemResponse[]) : []), [data]);
  const enabled = data?.sources.filter((source) => source.status !== "disabled") ?? [];
  const troubled = enabled.filter((source) => source.status === "error" || source.status === "partial");

  let body: React.ReactNode;
  if (!data && state.loading) {
    body = (
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" aria-busy="true" aria-label={t("news.loading")} data-testid="news-skeleton">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex animate-pulse flex-col overflow-hidden rounded-[var(--lyx-radius)] border border-lyx-border">
            <div className="aspect-[16/9] bg-lyx-muted" />
            <div className="flex flex-col gap-2 p-3">
              <div className="h-3.5 w-11/12 rounded bg-lyx-muted" />
              <div className="h-3.5 w-2/3 rounded bg-lyx-muted" />
              <div className="h-2.5 w-1/3 rounded bg-lyx-muted" />
              <div className="mt-2 h-8 rounded bg-lyx-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (!data) {
    body = (
      <div className="flex flex-col items-start gap-3 rounded-[var(--lyx-radius)] border border-dashed border-lyx-border px-4 py-10" role="alert" data-testid="news-error">
        <AlertTriangle size={20} className="text-lyx-danger" aria-hidden />
        <p className="text-[13px]">{t("news.error")}{state.error && state.error !== t("news.error") ? <span className="text-lyx-fg-muted"> · {state.error}</span> : null}</p>
        <Button variant="secondary" className="gap-1.5" onClick={onRetry}><RefreshCw size={14} aria-hidden /> {t("news.retry")}</Button>
      </div>
    );
  } else if (enabled.length === 0) {
    body = (
      <div className="flex flex-col items-start gap-2 rounded-[var(--lyx-radius)] border border-dashed border-lyx-border px-4 py-8" data-testid="news-disabled">
        <p className="text-[13.5px] font-semibold">{t("news.disabledTitle")}</p>
        <p className="max-w-[60ch] text-[12.5px] leading-5 text-lyx-fg-muted">{t("news.disabledBody")}</p>
        <ul className="flex flex-wrap gap-3 text-[12px]">
          {data.sources.map((source) => (
            <li key={source.id}><a className="underline" href={source.termsUrl} target="_blank" rel="noopener noreferrer">{t("news.termsLink", { source: source.label })}</a></li>
          ))}
        </ul>
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="flex flex-col items-start gap-3 rounded-[var(--lyx-radius)] border border-dashed border-lyx-border px-4 py-10" data-testid="news-empty">
        <p className="text-lyx-fg-muted">{data.query ? t("news.emptyQuery", { query: data.query }) : t("news.empty")}</p>
        {data.query ? <Button variant="secondary" onClick={onClearSearch}>{t("news.clearSearch")}</Button> : null}
      </div>
    );
  } else {
    body = (
      <div className={`grid gap-3 sm:grid-cols-2 2xl:grid-cols-3 ${state.loading ? "opacity-60" : ""}`} aria-busy={state.loading} data-testid="news-grid">
        {items.map((item) => <NewsCard key={item.id} item={item} selected={item.id === selectedId} now={now} onUse={onUse} />)}
      </div>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="news-feed-title" data-testid="news-feed">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="news-feed-title" className="text-[16px] font-semibold">{t("news.title")}</h2>
          <p className="text-[12px] text-lyx-fg-muted">{t("news.subtitle")}</p>
        </div>
        <label className="relative w-full sm:w-[280px]">
          <span className="sr-only">{t("news.searchLabel")}</span>
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-lyx-fg-subtle" aria-hidden />
          <input
            type="search"
            autoFocus={autoFocus}
            value={input}
            maxLength={100}
            onChange={(event) => onInput(event.target.value)}
            placeholder={t("news.searchPlaceholder")}
            className="h-9 w-full rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-muted pl-8 pr-3 text-[13px] text-lyx-fg placeholder:text-lyx-fg-subtle"
            data-testid="news-search"
          />
        </label>
      </div>
      <div role="radiogroup" aria-label={t("news.filtersLabel")} className="flex flex-wrap gap-1.5" data-testid="news-filters">
        {NEWS_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={filter === value}
            onClick={() => onFilter(value)}
            className={`h-8 rounded-full border px-3 text-[12px] font-medium transition-colors ${filter === value ? "border-lyx-fg bg-lyx-fg text-lyx-bg" : "border-lyx-border text-lyx-fg-muted hover:text-lyx-fg"}`}
            data-filter={value}
          >
            {t(`news.filter.${value}`)}
          </button>
        ))}
      </div>
      {data && state.error ? <p role="alert" className="text-[12px] text-lyx-danger">{t("news.error")} <button type="button" className="underline" onClick={onRetry}>{t("news.retry")}</button></p> : null}
      {troubled.map((source) => (
        <p key={source.id} role="status" className="text-[12px] text-lyx-warn" data-testid="news-source-warning">
          {t(source.status === "error" ? "news.sourceError" : "news.sourcePartial", { source: source.label })}
        </p>
      ))}
      {body}
    </section>
  );
}
