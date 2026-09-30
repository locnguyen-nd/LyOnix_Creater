import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApifyCandidateResponse, ApifyPlatformId, ApifySearchResponse, MediaAssetVersionSummary, ScriptVisualPlanResponse } from "@lyonix/contracts";
import { ApiError } from "../api";
import { Button } from "../components/ui";
import { APIFY_TAB_PLATFORMS, apifyKeywordsForScene, prefillApifyKeyword } from "./apify-search";
import { importApify, searchApify } from "./timeline-api";

/**
 * VE2E-34 Studio "Apify" tab. Search runs a server-pinned Actor for the picked platform; the keyword is
 * prefilled from the visual plan (ja by default, en switchable). Results carry the owner-accepted-risk
 * badge; preview-only candidates (Google video, Pinterest HLS-only) cannot be imported. The parent decides
 * how an imported asset is applied (this scene / whole segment scope), so this component only reports it.
 */
export function ApifyMediaTab(props: {
  projectId: string;
  accountId: string | null;
  visualPlan: ScriptVisualPlanResponse | null | undefined;
  selectedSceneId: string | null;
  onImported: (asset: MediaAssetVersionSummary, label: string) => void;
}) {
  const { t } = useTranslation();
  const { projectId, accountId, visualPlan, selectedSceneId, onImported } = props;
  const [platform, setPlatform] = useState<ApifyPlatformId>("tiktok");
  const [lang, setLang] = useState<"ja" | "en">("ja");
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [result, setResult] = useState<ApifySearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setKeyword(prefillApifyKeyword(apifyKeywordsForScene(visualPlan, selectedSceneId), lang));
  }, [visualPlan, selectedSceneId, lang]);

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
      onImported(asset, `Apify ${candidate.author ?? candidate.platform}`);
    } catch (err) {
      fail(err);
    } finally {
      setImportingId(null);
    }
  };

  if (!accountId) return <p className="text-[11px] text-lyx-fg-muted">{t("studioPro.apifyNoAccount")}</p>;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-[11px]">
        <span className="text-lyx-fg-muted">{t("studioPro.apifyPlatform")}</span>
        <select aria-label={t("studioPro.apifyPlatform")} value={platform} onChange={(event) => setPlatform(event.target.value as ApifyPlatformId)} className="h-9 rounded-[4px] border border-lyx-border bg-lyx-muted px-2 text-[12px]">
          {APIFY_TAB_PLATFORMS.map((item) => <option key={item.id} value={item.id}>{t(item.labelKey)}</option>)}
        </select>
      </label>
      <div className="flex gap-3 text-[11px]" role="radiogroup" aria-label={t("studioPro.apifyKeyword")}>
        {(["ja", "en"] as const).map((value) => (
          <label key={value} className="flex items-center gap-1">
            <input type="radio" name="apify-lang" checked={lang === value} onChange={() => setLang(value)} />
            {t(value === "ja" ? "studioPro.apifyLangJa" : "studioPro.apifyLangEn")}
          </label>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input aria-label={t("studioPro.apifyKeyword")} value={keyword} onChange={(event) => setKeyword(event.target.value)} className="h-9 flex-1 rounded-[4px] border border-lyx-border bg-lyx-muted px-2 text-[12px]" />
        <Button variant="secondary" disabled={busy || !keyword.trim()} onClick={() => void search()}>{busy ? t("studioPro.apifySearching") : t("studioPro.apifySearch")}</Button>
      </div>
      {error ? <p role="alert" className="text-[11px] text-lyx-danger">{error}</p> : null}
      {result?.primaryError ? <p className="text-[10px] text-amber-500">{t("studioPro.apifyBackupUsed", { actor: result.actor.actorId })}</p> : null}
      {result && result.candidates.length === 0 ? <p className="text-[11px] text-lyx-fg-muted">{t("studioPro.apifyNoResults")}</p> : null}
      {result ? (
        <div className="grid grid-cols-2 gap-1.5">
          {result.candidates.map((candidate) => (
            <div key={candidate.candidateId} className="flex flex-col gap-1 rounded-[4px] border border-lyx-border p-1">
              <div className="relative overflow-hidden rounded-[3px] bg-lyx-muted" style={{ aspectRatio: "9 / 16" }}>
                {candidate.previewUrl ? <img src={candidate.previewUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" /> : null}
                <span className="absolute left-1 top-1 rounded-[3px] bg-amber-600/90 px-1 text-[8px] text-white">{t("studioPro.apifyRiskBadge")}</span>
              </div>
              <p className="line-clamp-2 text-[9px] text-lyx-fg-muted" title={candidate.title}>{candidate.title || candidate.author || candidate.platform}</p>
              {candidate.importable ? (
                <Button variant="secondary" disabled={importingId !== null} onClick={() => void importCandidate(candidate)}>
                  {importingId === candidate.candidateId ? t("studioPro.apifyImporting") : t("studioPro.apifyImport")}
                </Button>
              ) : (
                <span className="text-[9px] text-lyx-fg-muted">{t("studioPro.apifyPreviewOnly")}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
