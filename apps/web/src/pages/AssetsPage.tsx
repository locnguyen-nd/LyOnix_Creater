import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MediaAssetVersionSummary, ProjectSummary, SourceVersionSummary } from "@lyonix/contracts";
import { Banner, EmptyState, PageHeader, SkeletonCards } from "../components/chrome";
import { TabIndicator, useTabIndicator } from "../components/motion";
import { Modal } from "../components/Modal";
import { Button } from "../components/ui";
import { api, ApiError } from "../api";
import { listProjectMedia } from "../studio/timeline-api";
import { createMediaPreviewUrl, isInlinePreviewableMediaKind } from "../studio/media-preview-api";
import { listProjectSources } from "../studio/sources-api";

const KINDS = ["all", "video", "image", "audio", "document"] as const;
type KindFilter = (typeof KINDS)[number];

function FilterItem({ active, indicated, label, count, onClick }: { active: boolean; indicated: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-active={active ? "true" : undefined}
      className={`relative flex h-9 w-full items-center justify-between rounded-[var(--lyx-radius)] px-2.5 text-[12.5px] font-medium ${active ? `${indicated ? "" : "bg-lyx-bg"} text-lyx-fg font-semibold` : "text-lyx-fg-muted hover:text-lyx-fg"}`}
    >
      <span className="truncate">{label}</span>
      <span className="text-[11px] text-lyx-fg-subtle">{count}</span>
    </button>
  );
}

const formatBytes = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function SourceCard({ source }: { source: SourceVersionSummary }) {
  const { i18n } = useTranslation();
  const name = source.originRef || source.type;
  return (
    <article className="lyx-panel-hover flex min-w-0 flex-col gap-2 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-[12.5px] font-semibold">{name}</p>
        <span className="shrink-0 rounded-full bg-lyx-muted px-2 py-0.5 text-[10px]">{source.type}</span>
      </div>
      <p className="text-[11px] text-lyx-fg-muted">{source.fetchStatus}</p>
      <time className="text-[10.5px] text-lyx-fg-subtle" dateTime={source.createdAt}>
        {new Date(source.createdAt).toLocaleString(i18n.language)}
      </time>
    </article>
  );
}

function MediaCard({ asset, onPreview, previewing }: { asset: MediaAssetVersionSummary; onPreview: (asset: MediaAssetVersionSummary) => void; previewing: boolean }) {
  const { t, i18n } = useTranslation();
  return (
    <article className="lyx-card-hover flex min-w-0 flex-col gap-2 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-[12.5px] font-semibold">{asset.originalFileName}</p>
        <span className="shrink-0 rounded-full bg-lyx-muted px-2 py-0.5 text-[10px]">{t(`assets.kinds.${asset.kind === "document" ? "file" : asset.kind}`)}</span>
      </div>
      <p className="text-[11px] text-lyx-fg-muted">
        {formatBytes(asset.bytes)} · {asset.origin} · {asset.retentionClass}
        {asset.expiresAt ? ` · ${new Date(asset.expiresAt).toLocaleDateString(i18n.language)}` : ""}
      </p>
      {isInlinePreviewableMediaKind(asset.kind) ? (
        <Button variant="secondary" loading={previewing} onClick={() => onPreview(asset)}>
          {previewing ? t("assets.previewLoading") : t("assets.previewDirect")}
        </Button>
      ) : null}
      <time className="text-[10.5px] text-lyx-fg-subtle" dateTime={asset.createdAt}>
        {new Date(asset.createdAt).toLocaleString(i18n.language)}
      </time>
    </article>
  );
}

export function AssetsPage() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [sources, setSources] = useState<SourceVersionSummary[]>([]);
  const [assets, setAssets] = useState<MediaAssetVersionSummary[]>([]);
  const [kind, setKind] = useState<KindFilter>("all");
  const { listRef: kindsRef, indicator: kindsIndicator } = useTabIndicator<HTMLDivElement>(kind);
  const [query, setQuery] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewingAssetId, setPreviewingAssetId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ asset: MediaAssetVersionSummary; url: string } | null>(null);

  const openPreview = async (asset: MediaAssetVersionSummary) => {
    setPreviewError(null);
    setPreviewingAssetId(asset.id);
    try {
      setPreview({ asset, url: await createMediaPreviewUrl(asset.id) });
    } catch (err) {
      setPreviewError(err instanceof ApiError ? err.message : t("assets.previewFailed"));
    } finally {
      setPreviewingAssetId(null);
    }
  };

  useEffect(() => {
    let active = true;
    void api<ProjectSummary[]>("/projects")
      .then((items) => {
        if (!active) return;
        const accessible = items.filter((item) => !item.archivedAt);
        setProjects(accessible);
        setProjectId((current) => current && accessible.some((item) => item.id === current) ? current : accessible[0]?.id ?? "");
      })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoadingProjects(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!projectId) {
      setSources([]);
      setAssets([]);
      return;
    }
    let active = true;
    setLoadingData(true);
    setError(false);
    void Promise.all([listProjectSources(projectId), listProjectMedia(projectId)])
      .then(([nextSources, nextAssets]) => {
        if (!active) return;
        setSources(nextSources);
        setAssets(nextAssets);
      })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoadingData(false); });
    return () => { active = false; };
  }, [projectId]);

  const visibleAssets = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return assets.filter((asset) => (kind === "all" || asset.kind === kind)
      && (!q || asset.originalFileName.toLocaleLowerCase().includes(q) || asset.origin.toLocaleLowerCase().includes(q)));
  }, [assets, kind, query]);
  const visibleSources = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return sources.filter((source) => (kind === "all" || kind === "document")
      && (!q || (source.originRef ?? source.type).toLocaleLowerCase().includes(q) || source.fetchStatus.includes(q)));
  }, [sources, kind, query]);
  const filteredCount = visibleAssets.length + visibleSources.length;
  const countForKind = (value: KindFilter) => value === "all"
    ? assets.length + sources.length
    : assets.filter((asset) => asset.kind === value).length + (value === "document" ? sources.length : 0);

  return (
    <>
      <PageHeader title={t("assets.title")} breadcrumb={t("assets.subtitle", { count: sources.length + assets.length })} />
      <div className="flex flex-col gap-5 md:flex-row md:gap-6">
        <aside className="w-full shrink-0 md:w-[220px]">
          <label className="mb-3 block px-2.5 text-[10.5px] font-bold uppercase tracking-wider text-lyx-fg-subtle">
            {t("assets.byProject")}
            <select
              className="mt-1.5 h-9 w-full rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg px-2 text-[12px] font-medium normal-case tracking-normal text-lyx-fg"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              disabled={loadingProjects || projects.length === 0}
            >
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <p className="mb-1.5 px-2.5 text-[10.5px] font-bold uppercase tracking-wider text-lyx-fg-subtle">{t("assets.byKind")}</p>
          <div ref={kindsRef} className="relative flex flex-col gap-0.5">
            <TabIndicator {...kindsIndicator} className="rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg" />
            {KINDS.map((item) => (
              <FilterItem
                key={item}
                active={kind === item}
                indicated={kindsIndicator.box !== null}
                label={t(item === "all" ? "jobs.all" : `assets.kinds.${item === "document" ? "file" : item}`)}
                count={countForKind(item)}
                onClick={() => setKind(item)}
              />
            ))}
          </div>
          <div className="mt-4 rounded-[var(--lyx-radius)] border border-dashed border-lyx-border bg-lyx-muted p-3">
            <p className="text-[11.5px] font-semibold">{t("org.retention")}</p>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <Banner variant="warn">{t("assets.banner")}</Banner>
          <input
            className="mb-4 h-9 w-full max-w-xs rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg px-3 text-[12px]"
            placeholder={t("topbar.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {error ? <Banner variant="danger">{t("common.error")}</Banner> : null}
          {previewError ? <Banner variant="danger">{previewError}</Banner> : null}
          {loadingProjects || loadingData ? <SkeletonCards label={t("common.loading")} media={false} count={6} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" /> : null}
          {!loadingProjects && projects.length === 0 ? <EmptyState title={t("common.empty")} /> : null}
          {!loadingProjects && !loadingData && projectId && filteredCount === 0 ? <EmptyState title={t("common.empty")} /> : null}
          {/* While a project loads, the previous project's cards would be stale: the skeleton stands in for them. */}
          {!loadingData && visibleSources.length > 0 ? (
            <section className="lyx-enter mb-6">
              <h2 className="mb-3 text-[13px] font-semibold">{t("assets.byProject")} · {visibleSources.length}</h2>
              <div className="lyx-list grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {visibleSources.map((source) => <SourceCard key={source.id} source={source} />)}
              </div>
            </section>
          ) : null}
          {!loadingData && visibleAssets.length > 0 ? (
            <section className="lyx-enter">
              <h2 className="mb-3 text-[13px] font-semibold">{t("assets.title")} · {visibleAssets.length}</h2>
              <div className="lyx-list grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {visibleAssets.map((asset) => <MediaCard key={asset.id} asset={asset} onPreview={openPreview} previewing={previewingAssetId === asset.id} />)}
              </div>
            </section>
          ) : null}
        </main>
      </div>
      {preview ? (
        <Modal title={preview.asset.originalFileName} onClose={() => setPreview(null)} width={640}>
          {preview.asset.kind === "image" ? (
            <img src={preview.url} alt={preview.asset.originalFileName} className="mx-auto max-h-[75vh] max-w-full object-contain" />
          ) : (
            <video src={preview.url} controls preload="metadata" className="mx-auto max-h-[75vh] max-w-full" aria-label={preview.asset.originalFileName} />
          )}
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" onClick={() => setPreview(null)}>{t("assets.closePreview")}</Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
