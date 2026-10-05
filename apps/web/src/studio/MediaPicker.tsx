import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Image as ImageIcon, Images, Scissors, Search, Sparkles, UploadCloud, Video } from "lucide-react";
import type { MediaAssetVersionSummary, PexelsSearchResponse, ScriptVisualPlanResponse } from "@lyonix/contracts";
import { ApiError } from "../api";
import { Button } from "../components/ui";
import { LazyThumb } from "../components/LazyThumb";
import { ApifyMediaTab } from "./ApifyMediaTab";
import { applyShortsPlanPreview, filterLibrary, formatClock, LIBRARY_FILTERS, type LibraryFilter } from "./media-picker-utils";
import { planShortsFromSource, type ShortsPlan } from "./auto-shorts";
import { readLocalMediaMeta, uploadMediaFile } from "./upload-api";

type SourceTab = "library" | "pexels" | "apify" | "upload";

export type MediaPickerProps = {
  projectId: string;
  library: MediaAssetVersionSummary[];
  thumbCache: Record<string, string>;
  selectedAssetId: string | null;
  selectedSceneLabel: string | null;
  onAssign: (asset: { id: string; label: string }) => void;
  pexels: {
    hasAccount: boolean;
    query: string;
    setQuery: (value: string) => void;
    type: "video" | "photo";
    setType: (value: "video" | "photo") => void;
    results: PexelsSearchResponse | null;
    searching: boolean;
    keywordChips: { lang: string; value: string }[];
    onSearch: (query?: string) => void;
    onImport: (externalId: string, label: string, type: "video" | "photo") => void;
  };
  apify: {
    accountId: string | null;
    visualPlan: ScriptVisualPlanResponse | null | undefined;
    selectedSceneId: string | null;
    fallbackKeyword: string;
    onImported: (asset: MediaAssetVersionSummary, label: string) => void;
  };
  upload: {
    /** Segment lengths of the current draft: one short is cut per segment. Empty until "Auto-fill media" created segments. */
    segmentDurations: { segmentId: string; durationMs: number }[];
    onUploaded: (asset: MediaAssetVersionSummary) => void;
    onApplyShorts: (asset: MediaAssetVersionSummary, plan: ShortsPlan) => void;
  };
};

const TAB_ICONS: Record<SourceTab, ReactNode> = {
  library: <Images size={14} strokeWidth={1.9} />,
  pexels: <Search size={14} strokeWidth={1.9} />,
  apify: <Sparkles size={14} strokeWidth={1.9} />,
  upload: <UploadCloud size={14} strokeWidth={1.9} />,
};

const LIBRARY_PAGE = 12;
/** Library videos at least this long get a "cut into shorts" shortcut. */
const LONG_VIDEO_MS = 30_000;
const MAX_UPLOAD_LABEL = "1 GB";

/** One media tile used by every source tab so the whole picker looks and behaves the same. */
function MediaTile(props: { thumb: ReactNode; badge?: string; duration?: string | null; title: string; selected?: boolean; footer?: ReactNode; onClick?: () => void; disabled?: boolean }) {
  const { thumb, badge, duration, title, selected, footer, onClick, disabled } = props;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || !onClick}
        title={title}
        className={`group relative aspect-[9/16] w-full overflow-hidden rounded-lg border bg-lyx-bg-muted transition-all hover:-translate-y-px hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0 disabled:hover:shadow-none ${selected ? "border-2 border-lyx-fg" : "border-lyx-border"}`}
      >
        {thumb}
        {badge ? <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">{badge}</span> : null}
        {duration ? <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-white">{duration}</span> : null}
        {selected ? <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-lyx-cta text-lyx-cta-fg"><Check size={12} strokeWidth={3} /></span> : null}
      </button>
      {footer}
    </div>
  );
}

function SectionMessage({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-lyx-border px-3 py-6 text-center text-[11.5px] leading-5 text-lyx-fg-muted">{children}</p>;
}

function LibraryTab({ props, onCut }: { props: MediaPickerProps; onCut: (asset: MediaAssetVersionSummary) => void }) {
  const { t } = useTranslation();
  const { library, thumbCache, selectedAssetId, onAssign } = props;
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [shown, setShown] = useState(LIBRARY_PAGE);
  const counts = useMemo(() => Object.fromEntries(LIBRARY_FILTERS.map((item) => [item, filterLibrary(library, item).length])) as Record<LibraryFilter, number>, [library]);
  const visible = filterLibrary(library, filter);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("mediaPicker.tabs.library")}>
        {LIBRARY_FILTERS.filter((item) => item === "all" || counts[item] > 0).map((item) => (
          <button key={item} type="button" aria-pressed={filter === item} onClick={() => { setFilter(item); setShown(LIBRARY_PAGE); }}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${filter === item ? "border-lyx-cta bg-lyx-cta font-semibold text-lyx-cta-fg" : "border-lyx-border bg-lyx-bg hover:bg-lyx-muted"}`}>
            {t(`mediaPicker.filter.${item}`)} <span className="tabular-nums opacity-70">{counts[item]}</span>
          </button>
        ))}
      </div>
      {visible.length === 0 ? <SectionMessage>{t("mediaPicker.libraryEmpty")}</SectionMessage> : (
        <div className="grid grid-cols-2 gap-2">
          {visible.slice(0, shown).map((asset) => {
            const url = thumbCache[asset.id];
            return (
              <MediaTile
                key={asset.id}
                title={asset.originalFileName}
                badge={t(`mediaPicker.origin.${asset.origin}`)}
                duration={asset.kind === "video" ? formatClock(asset.durationMs) : null}
                selected={selectedAssetId === asset.id}
                onClick={() => onAssign({ id: asset.id, label: asset.originalFileName })}
                footer={asset.kind === "video" && (asset.durationMs ?? 0) >= LONG_VIDEO_MS ? (
                  <button type="button" onClick={() => onCut(asset)} className="flex items-center justify-center gap-1 rounded-md border border-lyx-border py-1 text-[10.5px] font-medium hover:bg-lyx-muted">
                    <Scissors size={11} strokeWidth={2} />{t("mediaPicker.cutShorts")}
                  </button>
                ) : null}
                thumb={url && (asset.kind === "image" || asset.kind === "video") ? <LazyThumb kind={asset.kind} url={url} className="h-full w-full" /> : <span className="flex h-full w-full items-center justify-center text-lyx-fg-subtle">{asset.kind === "video" ? <Video size={22} /> : <ImageIcon size={22} />}</span>}
              />
            );
          })}
        </div>
      )}
      {shown < visible.length ? (
        <button type="button" className="rounded-lg border border-lyx-border py-1.5 text-[11.5px] hover:bg-lyx-muted" onClick={() => setShown((count) => count + LIBRARY_PAGE)}>
          {t("studioPro.libraryShowAll", { count: visible.length - shown })}
        </button>
      ) : null}
    </div>
  );
}

function PexelsTab({ props }: { props: MediaPickerProps }) {
  const { t } = useTranslation();
  const { pexels } = props;
  const items = pexels.results ? [...pexels.results.videos.map((row) => ({ row, type: "video" as const })), ...pexels.results.photos.map((row) => ({ row, type: "photo" as const }))] : [];
  if (!pexels.hasAccount) return <SectionMessage>{t("mediaPicker.pexels.noAccount")}</SectionMessage>;
  return (
    <div className="flex flex-col gap-3">
      <div className="inline-flex self-start overflow-hidden rounded-lg border border-lyx-border text-[11.5px]" role="group" aria-label={t("studioPro.manualMediaType")}>
        {(["video", "photo"] as const).map((type) => (
          <button key={type} type="button" aria-pressed={pexels.type === type} onClick={() => pexels.setType(type)} className={`px-3 py-1.5 ${pexels.type === type ? "bg-lyx-cta font-semibold text-lyx-cta-fg" : "bg-lyx-bg hover:bg-lyx-muted"}`}>
            {t(type === "video" ? "studioPro.videoMedia" : "studioPro.photoMedia")}
          </button>
        ))}
      </div>
      <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); pexels.onSearch(); }}>
        <input value={pexels.query} onChange={(event) => pexels.setQuery(event.target.value)} placeholder={t("studioPro.pexelsSearchPlaceholder")} aria-label={t("studioPro.pexelsSearchPlaceholder")} className="h-9 min-w-0 flex-1 rounded-lg border border-lyx-border bg-lyx-bg px-2.5 text-[12px]" />
        <Button variant="secondary" type="submit" disabled={pexels.searching || !pexels.query.trim()}>{pexels.searching ? t("studioPro.aiSearchRunning") : t("studioPro.search")}</Button>
      </form>
      {pexels.keywordChips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label={t("mediaPicker.suggestedKeywords")}>
          {pexels.keywordChips.map((chip) => (
            <button key={`${chip.lang}:${chip.value}`} type="button" className="rounded-full border border-lyx-border px-2.5 py-1 text-[10.5px] text-lyx-fg-muted hover:bg-lyx-muted hover:text-lyx-fg" onClick={() => { pexels.setQuery(chip.value); pexels.onSearch(chip.value); }}>
              {chip.lang ? `${chip.lang} · ` : ""}{chip.value}
            </button>
          ))}
        </div>
      ) : null}
      {!pexels.results ? <SectionMessage>{t("mediaPicker.pexels.idle")}</SectionMessage> : items.length === 0 ? <SectionMessage>{t("mediaPicker.noResults")}</SectionMessage> : (
        <div className="grid grid-cols-2 gap-2">
          {items.map(({ row, type }) => (
            <MediaTile
              key={`${type}-${row.externalId}`}
              title={`${row.attribution.photographerName} · ${row.attribution.pexelsPageUrl}`}
              badge={type === "video" ? t("studioPro.videoMedia") : t("studioPro.photoMedia")}
              onClick={() => pexels.onImport(row.externalId, `Pexels ${row.attribution.photographerName}`, type)}
              thumb={<img src={row.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
              footer={<span className="truncate text-[10px] text-lyx-fg-muted">{row.attribution.photographerName}</span>}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UploadTab({ props, asset, setAsset }: { props: MediaPickerProps; asset: MediaAssetVersionSummary | null; setAsset: (asset: MediaAssetVersionSummary | null) => void }) {
  const { t } = useTranslation();
  const { projectId, upload, onAssign } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<"idle" | "measuring" | "uploading">("idle");
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [applied, setApplied] = useState<number | null>(null);

  const plan = useMemo(
    () => (asset?.kind === "video" && asset.durationMs && upload.segmentDurations.length > 0 ? planShortsFromSource({ segments: upload.segmentDurations, sourceDurationMs: asset.durationMs }) : null),
    [asset, upload.segmentDurations],
  );

  const start = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setApplied(null);
    setAsset(null);
    if (!file.type.startsWith("video/") && !file.type.startsWith("image/")) { setError(t("mediaPicker.upload.badType")); return; }
    setFileName(file.name);
    setPhase("measuring");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const meta = await readLocalMediaMeta(file);
      setPhase("uploading");
      const uploaded = await uploadMediaFile(projectId, file, meta, setProgress, controller.signal);
      setAsset(uploaded);
      upload.onUploaded(uploaded);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "CANCELLED")) setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setPhase("idle");
      abortRef.current = null;
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    void start(event.dataTransfer.files?.[0]);
  };

  const busy = phase !== "idle";
  return (
    <div className="flex flex-col gap-3">
      <label
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors ${dragging ? "border-lyx-fg bg-lyx-muted" : "border-lyx-border hover:bg-lyx-muted"} ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        <UploadCloud size={26} strokeWidth={1.6} className="text-lyx-fg-muted" />
        <span className="text-[12.5px] font-semibold">{t("mediaPicker.upload.drop")}</span>
        <span className="text-[11px] text-lyx-fg-muted">{t("mediaPicker.upload.hint", { max: MAX_UPLOAD_LABEL })}</span>
        <span className="mt-1 rounded-lg border border-lyx-border bg-lyx-bg px-3 py-1.5 text-[11.5px] font-medium">{t("mediaPicker.upload.choose")}</span>
        <input ref={inputRef} type="file" accept="video/*,image/*" className="hidden" disabled={busy} onChange={(event) => void start(event.target.files?.[0])} />
      </label>

      {busy ? (
        <div className="rounded-lg border border-lyx-border p-3" role="status">
          <div className="flex items-center justify-between gap-2 text-[11.5px]">
            <span className="truncate font-medium">{fileName}</span>
            <span className="shrink-0 tabular-nums text-lyx-fg-muted">{phase === "measuring" ? t("mediaPicker.upload.measuring") : t("mediaPicker.upload.uploading", { percent: Math.round(progress * 100) })}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-lyx-neutral-bg"><div className="h-full rounded-full bg-lyx-cta transition-all" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <button type="button" className="mt-2 text-[11px] text-lyx-fg-muted underline" onClick={() => abortRef.current?.abort()}>{t("mediaPicker.upload.cancel")}</button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-[11.5px] text-lyx-danger">{error}</p> : null}

      {asset ? (
        <div className="flex flex-col gap-3 rounded-lg border border-lyx-border p-3">
          <div className="flex items-center justify-between gap-2 text-[11.5px]">
            <span className="truncate font-medium">{asset.originalFileName}</span>
            <span className="shrink-0 tabular-nums text-lyx-fg-muted">{asset.kind === "video" ? formatClock(asset.durationMs) : t("studioPro.photoMedia")}</span>
          </div>
          <Button variant="secondary" onClick={() => onAssign({ id: asset.id, label: asset.originalFileName })}>{t("mediaPicker.upload.useForScene")}</Button>

          {asset.kind === "video" ? (
            <div className="flex flex-col gap-2 border-t border-lyx-border pt-3">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold"><Scissors size={14} strokeWidth={1.9} />{t("mediaPicker.upload.shortsTitle")}</p>
              {!asset.durationMs ? <p className="text-[11px] text-lyx-fg-muted">{t("mediaPicker.upload.shortsNoDuration")}</p>
                : upload.segmentDurations.length === 0 ? <p className="text-[11px] text-lyx-fg-muted">{t("mediaPicker.upload.shortsNeedSegments")}</p>
                : plan ? (
                  <>
                    <p className="text-[11px] leading-4 text-lyx-fg-muted">{t("mediaPicker.upload.shortsHint", { count: plan.windows.length })}</p>
                    <div className="relative h-7 overflow-hidden rounded bg-lyx-neutral-bg" aria-label={t("mediaPicker.upload.shortsPreview")}>
                      {applyShortsPlanPreview(plan, asset.durationMs).map((bar, index) => (
                        <span key={bar.segmentId} title={`#${index + 1} · ${formatClock(bar.startMs)}`} className={`absolute inset-y-1 rounded-sm text-center text-[9px] font-bold leading-5 ${bar.fits ? "bg-lyx-ok/70 text-white" : "bg-lyx-warn/70 text-white"}`} style={{ left: `${bar.leftPct}%`, width: `${Math.max(bar.widthPct, 1.5)}%` }}>{index + 1}</span>
                      ))}
                    </div>
                    {plan.needsMoreSource ? <p className="text-[11px] text-lyx-warn">{t("mediaPicker.upload.shortsShort")}</p> : null}
                    {applied !== null ? <p role="status" className="text-[11px] text-lyx-ok">{t("mediaPicker.upload.shortsApplied", { count: applied })}</p> : null}
                    <Button onClick={() => { upload.onApplyShorts(asset, plan); setApplied(plan.windows.length); }}>{t("mediaPicker.upload.shortsApply", { count: plan.windows.length })}</Button>
                  </>
                ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MediaPicker(props: MediaPickerProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SourceTab>("library");
  const [workAsset, setWorkAsset] = useState<MediaAssetVersionSummary | null>(null);
  const tabs: SourceTab[] = ["library", "pexels", "apify", "upload"];
  return (
    <section className="flex flex-col gap-3" aria-label={t("mediaPicker.title")}>
      <p className="text-[11px] leading-4 text-lyx-fg-muted">{props.selectedSceneLabel ? t("mediaPicker.forScene", { scene: props.selectedSceneLabel }) : t("mediaPicker.noScene")}</p>
      <div role="tablist" aria-label={t("mediaPicker.title")} className="grid grid-cols-4 gap-1 rounded-xl bg-lyx-neutral-bg p-1">
        {tabs.map((item) => (
          <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}
            className={`flex flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10.5px] transition-colors ${tab === item ? "bg-lyx-bg font-semibold shadow-sm" : "text-lyx-fg-muted hover:text-lyx-fg"}`}>
            {TAB_ICONS[item]}
            {t(`mediaPicker.tabs.${item}`)}
          </button>
        ))}
      </div>
      {tab === "library" ? <LibraryTab props={props} onCut={(asset) => { setWorkAsset(asset); setTab("upload"); }} /> : null}
      {tab === "pexels" ? <PexelsTab props={props} /> : null}
      {tab === "apify" ? (
        <ApifyMediaTab projectId={props.projectId} accountId={props.apify.accountId} visualPlan={props.apify.visualPlan} selectedSceneId={props.apify.selectedSceneId} fallbackKeyword={props.apify.fallbackKeyword} onImported={props.apify.onImported} />
      ) : null}
      {tab === "upload" ? <UploadTab props={props} asset={workAsset} setAsset={setWorkAsset} /> : null}
    </section>
  );
}
