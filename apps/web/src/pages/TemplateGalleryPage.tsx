import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { mergeTemplateEntries, type TemplateEntry } from "../studio/template-gallery";
import { CATEGORY_FILTERS, categoryCounts, filterByCategory, toLibraryTemplates, type CategoryFilter, type LibraryTemplate } from "../studio/template-catalog";
import { PageHeader, Banner } from "../components/chrome";
import { Button } from "../components/ui";
import { api, ApiError } from "../api";
import type { ApiProvider } from "../jobs-api";
import { listCreatomateTemplates, pinTemplateSnapshot } from "../studio/timeline-api";
import { engineNameKey } from "../studio/render-engine";
import { TemplatePreviewModal } from "../components/TemplatePreviewModal";
import { CategoryChips, TemplateCard } from "../components/TemplateCard";
import type { RenderEngine } from "@lyonix/contracts";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[6px] border px-3 py-1.5 text-left text-[12px] ${
        active ? "border-lyx-strong bg-lyx-muted font-medium text-lyx-fg" : "border-lyx-border text-lyx-fg-muted"
      }`}
    >
      {children}
    </button>
  );
}

export function TemplateGalleryPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TemplateEntry[]>([]);
  const [engine, setEngine] = useState<RenderEngine | "all">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinning, setPinning] = useState<string | null>(null);
  const [tag, setTag] = useState<string | "all">("all");
  // V04-01: group filter (display only).
  const [category, setCategory] = useState<CategoryFilter>("all");

  // VE2E-113: ONE gallery over every usable render account (internal LyOnix recipes + Creatomate + Orshot templates), each card labelled with its engine.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await api<ApiProvider[]>("/provider-accounts");
        const accounts = rows.filter((row) => row.role === "render" && (row.isFake || row.status === "verified"));
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

  const byEngine = useMemo(() => (engine === "all" ? entries : entries.filter((entry) => entry.engine === engine)), [entries, engine]);
  const engines = useMemo(() => [...new Set(entries.map((entry) => entry.engine))], [entries]);
  const tags = useMemo(() => [...new Set(byEngine.flatMap((entry) => entry.template.tags))], [byEngine]);
  const byTag = useMemo(() => (tag === "all" ? byEngine : byEngine.filter((entry) => entry.template.tags.includes(tag))), [byEngine, tag]);
  const library = useMemo(() => toLibraryTemplates(byTag), [byTag]);
  const counts = useMemo(() => categoryCounts(library), [library]);
  // V04-XX / V04-01: the cards and the preview browse the filtered list; previewing never pins - only "Dùng template" in the preview
  // does, and the API refuses a template that is not ready to render (same rule as Auto).
  const filtered = useMemo(() => filterByCategory(library, category), [library, category]);
  const previewTemplates = filtered;
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

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
        breadcrumb={t("templates.matchCount", { count: filtered.length })}
        actions={<Button variant="secondary" onClick={() => navigate(`/jobs/${id}/studio`)}>{t("templates.back")}</Button>}
      />
      <p className="mb-4 text-[12px] text-lyx-fg-muted">{t("templates.subtitle")}</p>
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {previewIndex !== null && filtered[previewIndex] ? (
        <TemplatePreviewModal
          templates={previewTemplates}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          selectedId={null}
          selecting={pinning === filtered[previewIndex]!.key}
          selectLabel={t("templates.useTemplate")}
          onSelect={() => void useTemplate(filtered[previewIndex]!)}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}

      {entries.length === 0 && !loading ? <p className="mb-4 text-[12px] text-lyx-fg-muted">{t("studioPro.noAccountForRole", { role: "LyOnix / Creatomate / Orshot" })}</p> : null}
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("renderEngine.galleryEngineFilter")}>
        <span className="text-[11px] text-lyx-fg-muted">{t("renderEngine.galleryEngineFilter")}</span>
        <Chip active={engine === "all"} onClick={() => { setEngine("all"); setTag("all"); setPreviewIndex(null); }}>{t("renderEngine.galleryAllEngines")}</Chip>
        {engines.map((item) => (
          <Chip key={item} active={engine === item} onClick={() => { setEngine(item); setTag("all"); setPreviewIndex(null); }}>{t(engineNameKey(item))}</Chip>
        ))}
      </div>
      <div className="mb-4">
        <CategoryChips filters={CATEGORY_FILTERS} value={category} counts={counts} onChange={(value) => { setCategory(value); setPreviewIndex(null); }} label={t("templates.library.categoryFilter")} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[180px_1fr]">
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-2 text-[11px] text-lyx-fg-muted">{t("templates.styleLabel")}</p>
            <div className="flex flex-col gap-1.5">
              <Chip active={tag === "all"} onClick={() => setTag("all")}>
                {t("templates.allStyles")}
              </Chip>
              {tags.map((item) => (
                <Chip key={item} active={tag === item} onClick={() => setTag(item)}>
                  {item}
                </Chip>
              ))}
            </div>
          </div>
        </div>

        <div>
          {loading ? <p className="text-[12px] text-lyx-fg-muted">{t("common.loading")}</p> : null}
          {/* 63f9d66 made this gallery denser (up to 6 columns); V04-01 cards keep 2 columns on phones so names stay readable. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {filtered.map((entry, index) => (
              <TemplateCard key={entry.key} template={entry} selected={false} onPreview={() => setPreviewIndex(index)} />
            ))}
          </div>
          {filtered.length === 0 && entries.length > 0 && !loading ? <p className="text-[12px] text-lyx-fg-muted">{t("templates.library.emptyCategory")}</p> : null}

          <p className="mt-5 rounded-[6px] border border-lyx-border bg-lyx-muted p-3 text-[12px] text-lyx-fg-muted">
            {t("templates.pinNote")}
          </p>
        </div>
      </div>
    </>
  );
}
