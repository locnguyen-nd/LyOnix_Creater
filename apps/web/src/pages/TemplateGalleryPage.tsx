import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { mergeTemplateEntries, type TemplateEntry } from "../studio/template-gallery";
import { toLibraryTemplates, type LibraryTemplate } from "../studio/template-catalog";
import { PageHeader, Banner } from "../components/chrome";
import { Button } from "../components/ui";
import { api, ApiError } from "../api";
import type { ApiProvider } from "../jobs-api";
import { listCreatomateTemplates, pinTemplateSnapshot } from "../studio/timeline-api";
import { TemplateBrowser } from "../components/TemplateBrowser";

/**
 * Studio template gallery. ONE gallery over every usable render account (internal LyOnix recipes + Creatomate + Orshot), shown with
 * the same compact browser as the Auto drawer: search, engine and group filters, a dense grid and a details pane. Looking never pins;
 * only "Dùng template" pins the snapshot, and the API refuses a template that is not ready to render (same rule as Auto).
 */
export function TemplateGalleryPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TemplateEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinning, setPinning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await api<ApiProvider[]>("/provider-accounts");
        const accounts = rows.filter((row) => row.role === "render" && row.enabled !== false && (row.isFake || row.status === "verified"));
        const results = await Promise.allSettled(accounts.map((account) => listCreatomateTemplates(account.id)));
        if (cancelled) return;
        setEntries(mergeTemplateEntries(accounts, results.map((result) => (result.status === "fulfilled" ? result.value : []))));
        const failed = results.findIndex((result) => result.status === "rejected");
        if (failed >= 0) {
          const reason = (results[failed] as PromiseRejectedResult).reason;
          setError(reason instanceof ApiError ? reason.message : t("common.error"));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t("common.error"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  const library = useMemo(() => toLibraryTemplates(entries), [entries]);

  const useTemplate = async (entry: LibraryTemplate) => {
    if (!id) return;
    setPinning(entry.key);
    try {
      const snapshot = await pinTemplateSnapshot(entry.accountId, entry.externalTemplateId);
      navigate(`/jobs/${id}/studio`, { state: { templateSnapshotId: snapshot.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setPinning(null);
    }
  };

  return (
    <>
      <PageHeader
        title={t("templates.title")}
        breadcrumb={t("templates.matchCount", { count: library.length })}
        actions={<Button variant="secondary" onClick={() => navigate(`/jobs/${id}/studio`)}>{t("templates.back")}</Button>}
      />
      <p className="mb-4 text-[12px] text-lyx-fg-muted">{t("templates.subtitle")}</p>
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {entries.length === 0 && !loading ? <p className="mb-4 text-[12px] text-lyx-fg-muted">{t("studioPro.noAccountForRole", { role: "LyOnix / Creatomate / Orshot" })}</p> : null}
      {loading ? <p className="mb-2 text-[12px] text-lyx-fg-muted">{t("common.loading")}</p> : null}
      <TemplateBrowser templates={library} chooseLabel={t("templates.useTemplate")} choosing={pinning !== null} onChoose={(entry) => void useTemplate(entry)} />
      <p className="mt-5 rounded-[6px] border border-lyx-border bg-lyx-muted p-3 text-[12px] text-lyx-fg-muted">{t("templates.pinNote")}</p>
    </>
  );
}
