import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, Link2, Loader2, Search, Video } from "lucide-react";
import { Button } from "../components/ui";
import type { IntakeState, IntakeTarget } from "./url-intake";

/**
 * VE2E-96: "Nguồn nội dung" above the create-video form - a URL to analyse (TikTok transcript / article, then an original script) and a
 * news search that opens the news drawer. The result is a preview card; the form changes only through its two buttons.
 */
export function ContentSourceBar({ state, onAnalyze, onSearchNews, onApply, onRetryRewrite }: {
  state: IntakeState;
  onAnalyze: (url: string) => void;
  onSearchNews: (query: string) => void;
  onApply: (target: IntakeTarget) => void;
  onRetryRewrite: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const busy = state.kind === "loading" || (state.kind === "ready" && state.rewrite.status === "pending");
  const inputClass = "h-10 w-full min-w-0 rounded-[4px] border border-lyx-border bg-lyx-muted pl-9 pr-3 text-[13px] text-lyx-fg placeholder:text-lyx-fg-subtle";

  return (
    <section className="mb-5 flex flex-col gap-2.5 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4" aria-labelledby="content-source-title" data-testid="content-source">
      <p id="content-source-title" className="text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("intake.title")}</p>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (url.trim() && !busy) onAnalyze(url.trim()); }} data-testid="intake-url-form">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t("intake.urlLabel")}</span>
          <Link2 size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lyx-fg-subtle" aria-hidden />
          <input type="text" inputMode="url" value={url} maxLength={2000} onChange={(event) => setUrl(event.target.value)} placeholder={t("intake.urlPlaceholder")} className={inputClass} data-testid="intake-url" />
        </label>
        <Button type="submit" className="sm:w-[132px]" disabled={busy || !url.trim()}>{state.kind === "loading" ? t("intake.analyzing") : t("intake.analyze")}</Button>
      </form>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); onSearchNews(query.trim()); }} data-testid="intake-news-form">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t("intake.newsLabel")}</span>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lyx-fg-subtle" aria-hidden />
          <input type="search" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder={t("intake.newsPlaceholder")} className={inputClass} data-testid="intake-news-query" />
        </label>
        <Button type="submit" variant="secondary" className="sm:w-[132px]">{t("intake.search")}</Button>
      </form>

      {state.kind === "loading" ? (
        <p role="status" className="flex items-center gap-2 text-[12.5px] text-lyx-fg-muted" data-testid="intake-loading">
          <Loader2 size={14} className="animate-spin" aria-hidden /> {t("intake.stageReading")}
        </p>
      ) : null}

      {state.kind === "error" ? (
        <p role="alert" className="flex items-start gap-2 rounded-[var(--lyx-radius)] border border-lyx-danger/60 px-3 py-2 text-[12.5px] text-lyx-danger" data-testid="intake-error" data-code={state.code}>
          <AlertTriangle size={15} className="mt-[2px] shrink-0" aria-hidden />
          <span>{i18n.exists(`intake.error.${state.code}`) ? t(`intake.error.${state.code}`) : t("intake.error.request_failed", { message: state.message })}</span>
        </p>
      ) : null}

      {state.kind === "ready" ? (
        <article className="flex flex-col gap-2.5 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-muted/40 p-3" data-testid="intake-preview" data-source-type={state.source.sourceType} data-method={state.source.method}>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-lyx-fg-muted">
            <span className="inline-flex items-center gap-1 rounded-full bg-lyx-bg px-2 py-0.5 font-semibold text-lyx-fg">
              {state.source.sourceType === "tiktok" ? <Video size={12} aria-hidden /> : <FileText size={12} aria-hidden />}
              {t(`intake.type.${state.source.sourceType}`)}
            </span>
            {state.source.sourceName ? <span>{state.source.sourceName}</span> : null}
            <span>· {t("intake.chars", { count: state.source.characterCount })}</span>
            <span>· {t(`intake.method.${state.source.method}`)}</span>
            <span>· {t("intake.provider", { name: state.source.providerUsed })}</span>
            {state.source.publishedAt ? <span>· {t("intake.published", { date: new Date(state.source.publishedAt).toLocaleDateString(i18n.language) })}</span> : null}
            <a className="ml-auto inline-flex items-center gap-1 underline" href={state.source.sourceUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} aria-hidden /> {t("intake.openSource")}</a>
          </div>
          {state.source.title ? <p className="text-[13.5px] font-semibold leading-snug" data-testid="intake-title">{state.source.title}</p> : null}
          <div>
            <p className="text-[10.5px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("intake.sourceText")}{state.source.truncated ? ` ${t("intake.truncated")}` : ""}</p>
            <p className="line-clamp-3 whitespace-pre-line text-[12px] leading-5 text-lyx-fg-muted" data-testid="intake-source-text">{state.source.cleanedText}</p>
          </div>
          <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-2.5" data-testid="intake-rewrite" data-status={state.rewrite.status}>
            <p className="mb-1 text-[10.5px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("intake.scriptTitle")}</p>
            {state.rewrite.status === "pending" ? (
              <p role="status" className="flex items-center gap-2 text-[12px] text-lyx-fg-muted"><Loader2 size={13} className="animate-spin" aria-hidden /> {t("intake.stageRewriting")}</p>
            ) : state.rewrite.status === "done" ? (
              <>
                <p className="line-clamp-4 whitespace-pre-line text-[12.5px] leading-5" data-testid="intake-script">{state.rewrite.script}</p>
                <p className="mt-1 text-[11px] text-lyx-fg-subtle">{t("intake.chars", { count: state.rewrite.characterCount })} · {t("intake.provider", { name: state.rewrite.providerUsed })}</p>
                {state.rewrite.overlapHigh ? <p className="mt-1 text-[11.5px] text-lyx-warn">{t("intake.overlapHigh")}</p> : null}
              </>
            ) : state.rewrite.status === "skipped" ? (
              <p className="text-[12px] text-lyx-fg-muted">{state.rewrite.reason === "no_content_account" ? t("intake.rewriteNoAccount") : t("intake.rewriteNotRequested")}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-lyx-danger">
                <span>{t("intake.rewriteFailed", { message: i18n.exists(`intake.rewriteError.${state.rewrite.code}`) ? t(`intake.rewriteError.${state.rewrite.code}`) : state.rewrite.message })}</span>
                <Button type="button" variant="ghost" className="h-7 px-2 text-[12px]" onClick={onRetryRewrite}>{t("intake.rewriteRetry")}</Button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => onApply("topic")} disabled={state.rewrite.status === "pending"} data-testid="intake-to-topic">{t("intake.toTopic")}</Button>
            <Button type="button" onClick={() => onApply("script")} disabled={state.rewrite.status !== "done"} data-testid="intake-to-script">{t("intake.toScript")}</Button>
            {state.applied ? <span role="status" className="inline-flex items-center gap-1 text-[12px] text-lyx-ok"><CheckCircle2 size={14} aria-hidden /> {t(`intake.applied.${state.applied}`)}</span> : null}
          </div>
        </article>
      ) : null}
    </section>
  );
}
