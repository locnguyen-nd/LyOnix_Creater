import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { mergeTemplateEntries, type TemplateEntry } from "../studio/template-gallery";
import { PageHeader, Banner } from "../components/chrome";
import { Button } from "../components/ui";
import { api, ApiError } from "../api";
import type { ApiProvider } from "../jobs-api";
import { listCreatomateTemplates, pinTemplateSnapshot } from "../studio/timeline-api";
import { engineNameKey } from "../studio/render-engine";
import { TemplatePreviewButton, TemplatePreviewModal, TemplateThumb } from "../components/TemplatePreviewModal";
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
  const filtered = useMemo(() => (tag === "all" ? byEngine : byEngine.filter((entry) => entry.template.tags.includes(tag))), [byEngine, tag]);
  // V04-XX: the preview browses the filtered list; it never pins - only "Dùng template" does.
  const previewTemplates = useMemo(() => filtered.map((entry) => ({ ...entry.template, engine: entry.engine })), [filtered]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const useTemplate = async (entry: TemplateEntry) => {
    if (!id) return;
    const tpl = entry.template;
    setPinning(entry.key);
    try {
      const snapshot = await pinTemplateSnapshot(entry.accountId, tpl.externalTemplateId);
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
          onSelect={() => void useTemplate(filtered[previewIndex]!)}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}

      {entries.length === 0 && !loading ? <p className="mb-4 text-[12px] text-lyx-fg-muted">{t("studioPro.noAccountForRole", { role: "LyOnix / Creatomate / Orshot" })}</p> : null}
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("renderEngine.galleryEngineFilter")}>
        <span className="text-[11px] text-lyx-fg-muted">{t("renderEngine.galleryEngineFilter")}</span>
        <Chip active={engine === "all"} onClick={() => { setEngine("all"); setTag("all"); }}>{t("renderEngine.galleryAllEngines")}</Chip>
        {engines.map((item) => (
          <Chip key={item} active={engine === item} onClick={() => { setEngine(item); setTag("all"); }}>{t(engineNameKey(item))}</Chip>
        ))}
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
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((entry, index) => {
              const tpl = entry.template;
              return (
              <div key={entry.key} className="overflow-hidden rounded-[6px] border border-lyx-border" data-engine={entry.engine}>
                {/* V04-XX: the picture opens the 9:16 preview; "Dùng template" (here or in the preview) is what pins it. */}
                <button type="button" onClick={() => setPreviewIndex(index)} title={t("templates.previewOpen")} className="block w-full">
                  <div className="flex items-center justify-center overflow-hidden bg-lyx-muted text-[11px] text-lyx-fg-subtle" style={{ aspectRatio: "9 / 16" }}>
                    <TemplateThumb template={previewTemplates[index]!} fallbackLabel={t("templates.preview")} />
                  </div>
                </button>
                <div className="p-2.5">
                  <span className="mb-1 inline-block rounded-[4px] border border-lyx-border bg-lyx-muted px-1.5 py-0.5 text-[10px] text-lyx-fg-muted" data-testid="engine-badge">{t(engineNameKey(entry.engine))}</span>
                  <div className="text-[12px] font-medium">{tpl.name}</div>
                  <div className="mt-0.5 text-[11px] text-lyx-fg-muted">{tpl.tags.join(", ") || tpl.externalTemplateId}</div>
                  <div className="mt-2 flex gap-1.5">
                    <TemplatePreviewButton onClick={() => setPreviewIndex(index)} label={t("templates.previewOpen")} className="justify-center px-2.5" />
                    <Button
                      variant="primary"
                      className="flex-1"
                      disabled={pinning === entry.key}
                      onClick={() => void useTemplate(entry)}
                    >
                      {pinning === entry.key ? t("common.loading") : t("templates.useTemplate")}
                    </Button>
                  </div>
                </div>
              </div>
              );
            })}
          </div>

          <p className="mt-5 rounded-[6px] border border-lyx-border bg-lyx-muted p-3 text-[12px] text-lyx-fg-muted">
            {t("templates.pinNote")}
          </p>
        </div>
      </div>
    </>
  );
}
