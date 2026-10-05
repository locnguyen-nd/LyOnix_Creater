import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApifyCandidateResponse, ApifyPlatformId, ApifySearchResponse, MediaAssetVersionSummary, ScriptVisualPlanResponse } from "@lyonix/contracts";
import { ApiError } from "../api";
import { Button } from "../components/ui";
import { APIFY_TAB_PLATFORMS, apifyKeywordsForScene, prefillApifyKeyword } from "./apify-search";
import { importApify, searchApify } from "./timeline-api";

/**
 * VE2E-34 Studio "Apify" source. Search runs a server-pinned Actor for the picked platform; the keyword is
 * prefilled from the visual plan (ja by default, en switchable) and, when the script has no plan, from the selected
 * scene's own text so the search is never blocked by an empty box. Results carry the owner-accepted-risk badge;
 * preview-only candidates (Google video, Pinterest HLS-only) cannot be imported. The parent decides how an imported
 * asset is applied (this scene / whole segment scope), so this component only reports it.
 */
export function ApifyMediaTab(props: {
  projectId: string;
  accountId: string | null;
  visualPlan: ScriptVisualPlanResponse | null | undefined;
  selectedSceneId: string | null;
  /** Used when the visual plan has no keyword for the selected scene (e.g. the scene's visual query). */
  fallbackKeyword?: string;
  onImported: (asset: MediaAssetVersionSummary, label: string) => void;
}) {
  const { t } = useTranslation();
  const { projectId, accountId, visualPlan, selectedSceneId, fallbackKeyword = "", onImported } = props;
  const [platform, setPlatform] = useState<ApifyPlatformId>("tiktok");
  const [lang, setLang] = useState<"ja" | "en">("ja");
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ApifySearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const planned = apifyKeywordsForScene(visualPlan, selectedSceneId);
  useEffect(() => {
    setKeyword(prefillApifyKeyword(planned, lang) || fallbackKeyword.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualPlan, selectedSceneId, lang, fallbackKeyword]);

  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : t("common.error"));

  const search = async () => {
    if (!accountId || !keyword.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await searchApify(projectId, { providerAccountId: accountId, platform, query: keyword.trim(), lang, limit: 10 }));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const importCandidate = async (candidate: ApifyCandidateResponse) => {
    if (!accountId || !candidate.importRef) return;
    setImportingId(candidate.candidateId);
    setError(null);
    try {
      const { asset } = await importApify(projectId, { providerAccountId: accountId, importRef: candidate.importRef, sceneId: selectedSceneId });
      setImportedIds((prev) => new Set(prev).add(candidate.candidateId));
      onImported(asset, `Apify ${candidate.author ?? candidate.platform}`);
    } catch (err) {
      fail(err);
    } finally {
      setImportingId(null);
    }
  };

  if (!accountId) return <p className="rounded-lg border border-dashed border-lyx-border px-3 py-6 text-center text-[11.5px] leading-5 text-lyx-fg-muted">{t("studioPro.apifyNoAccount")}</p>;

  const chips = [planned.ja, planned.en].filter((value): value is string => Boolean(value?.trim()));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("studioPro.apifyPlatform")}>
        {APIFY_TAB_PLATFORMS.map((item) => (
          <button key={item.id} type="button" aria-pressed={platform === item.id} onClick={() => setPlatform(item.id)}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${platform === item.id ? "border-lyx-cta bg-lyx-cta font-semibold text-lyx-cta-fg" : "border-lyx-border bg-lyx-bg hover:bg-lyx-muted"}`}>
            {t(item.labelKey)}
          </button>
        ))}
      </div>
      <div className="inline-flex self-start overflow-hidden rounded-lg border border-lyx-border text-[11.5px]" role="radiogroup" aria-label={t("studioPro.apifyKeyword")}>
        {(["ja", "en"] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={lang === value} onClick={() => setLang(value)} className={`px-3 py-1.5 ${lang === value ? "bg-lyx-cta font-semibold text-lyx-cta-fg" : "bg-lyx-bg hover:bg-lyx-muted"}`}>
            {t(value === "ja" ? "studioPro.apifyLangJa" : "studioPro.apifyLangEn")}
          </button>
        ))}
      </div>
      <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <input aria-label={t("studioPro.apifyKeyword")} placeholder={t("mediaPicker.apify.keywordPlaceholder")} value={keyword} onChange={(event) => setKeyword(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-lyx-border bg-lyx-bg px-2.5 text-[12px]" />
        <Button variant="secondary" type="submit" disabled={busy || !keyword.trim()}>{busy ? t("studioPro.apifySearching") : t("studioPro.apifySearch")}</Button>
      </form>
      {chips.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <button key={chip} type="button" className="rounded-full border border-lyx-border px-2.5 py-1 text-[10.5px] text-lyx-fg-muted hover:bg-lyx-muted hover:text-lyx-fg" onClick={() => setKeyword(chip)}>{chip}</button>
          ))}
        </div>
      ) : null}
      {busy ? <p role="status" className="rounded-lg bg-lyx-neutral-bg px-3 py-2 text-[11px] leading-4 text-lyx-fg-muted">{t("mediaPicker.apify.slowHint")}</p> : null}
      {error ? <p role="alert" className="text-[11.5px] text-lyx-danger">{error}</p> : null}
      {result?.primaryError ? <p className="text-[10.5px] text-lyx-warn">{t("studioPro.apifyBackupUsed", { actor: result.actor.actorId })}</p> : null}
      {!result && !busy ? <p className="rounded-lg border border-dashed border-lyx-border px-3 py-6 text-center text-[11.5px] leading-5 text-lyx-fg-muted">{t("mediaPicker.apify.idle")}</p> : null}
      {result && result.candidates.length === 0 ? <p className="text-[11.5px] text-lyx-fg-muted">{t("studioPro.apifyNoResults")}</p> : null}
      {result ? (
        <div className="grid grid-cols-2 gap-2">
          {result.candidates.map((candidate) => {
            const imported = importedIds.has(candidate.candidateId);
            return (
              <div key={candidate.candidateId} className="flex flex-col gap-1.5">
                <div className="relative aspect-[9/16] overflow-hidden rounded-lg border border-lyx-border bg-lyx-bg-muted">
                  {candidate.previewUrl ? <img src={candidate.previewUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" /> : null}
                  <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold text-white">{t("studioPro.apifyRiskBadge")}</span>
                </div>
                <p className="line-clamp-2 text-[10px] leading-4 text-lyx-fg-muted" title={candidate.title}>{candidate.title || candidate.author || candidate.platform}</p>
                {candidate.importable ? (
                  <Button variant="secondary" disabled={importingId !== null || imported} onClick={() => void importCandidate(candidate)}>
                    {importingId === candidate.candidateId ? t("studioPro.apifyImporting") : imported ? t("mediaPicker.apify.imported") : t("studioPro.apifyImport")}
                  </Button>
                ) : (
                  <span className="text-[10px] text-lyx-fg-muted">{t("studioPro.apifyPreviewOnly")}</span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
