import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, PlugZap } from "lucide-react";
import { TREND_CATEGORIES } from "@lyonix/domain/trend-radar";
import type { TrendRadarConfigResponse, TrendRadarConfigUpdateRequest } from "@lyonix/contracts";
import { ApiError } from "../api";
import { Banner, SkeletonRows, StatusPill } from "../components/chrome";
import { useToast } from "../components/feedback";
import { Button, Field, Select, TextArea, TextInput } from "../components/ui";
import { useMe } from "../session";
import { getTrendConfig, testTrendSource, updateTrendConfig } from "../trend-radar-api";
import { configPatch, linesOf, type TrendConfigDraft } from "./trend-ui";

function Panel({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Toggle({ label, checked, disabled, onChange, testId }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; testId?: string }) {
  return (
    <label className={`inline-flex items-center gap-2 text-[13px] ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <input type="checkbox" data-testid={testId} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

const draftOf = (config: TrendRadarConfigResponse): TrendConfigDraft => ({
  ...config,
  keywordsText: config.keywords.join("\n"),
  hashtagsText: config.hashtags.join("\n"),
});

/**
 * VE2E-158 settings. Only an admin saves; everyone else sees them read-only. Yahoo!ニュース RSS cannot be switched on here while the operator
 * has not confirmed the usage rights in the deployment config - the switch is never treated as that confirmation (the API refuses it too).
 * Nothing here holds or shows a key: the Apify / Gemini accounts are picked by name, their secrets stay on the server.
 */
export function TrendConfigPanel({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const toast = useToast();
  const isAdmin = me.role === "admin";
  const [config, setConfig] = useState<TrendRadarConfigResponse | null>(null);
  const [draft, setDraft] = useState<TrendConfigDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; state: string; message: string }>>({});

  useEffect(() => {
    getTrendConfig()
      .then((next) => { setConfig(next); setDraft(draftOf(next)); })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
  }, [t]);

  if (!config || !draft) return error ? <Banner variant="danger">{error}</Banner> : <SkeletonRows label={t("common.loading")} count={6} />;

  const set = (patch: Partial<TrendConfigDraft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const toggleIn = (list: string[], value: string, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value));
  const number = (value: string) => (value.trim() === "" ? 0 : Number(value));
  const readOnly = !isAdmin;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: TrendRadarConfigUpdateRequest = configPatch(draft);
      const next = await updateTrendConfig(patch);
      setConfig(next);
      setDraft(draftOf(next));
      toast.success(t("trendRadar.config.saved"));
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setSaving(false);
    }
  };

  const test = async (provider: "yahoo_news" | "tiktok") => {
    setTesting(provider);
    try {
      const result = await testTrendSource(provider);
      setTests((prev) => ({ ...prev, [provider]: result }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [provider]: { ok: false, state: "failed", message: err instanceof ApiError ? err.message : t("common.error") } }));
    } finally {
      setTesting(null);
    }
  };

  const testResult = (provider: string) => {
    const result = tests[provider];
    return result ? <p className="text-[12px]"><StatusPill tone={result.ok ? "ok" : "warn"}>{t(`trendRadar.sources.state.${result.state}`, { defaultValue: result.state })}</StatusPill> {result.message}</p> : null;
  };
  const testButton = (provider: "yahoo_news" | "tiktok") => (isAdmin ? <Button variant="secondary" loading={testing === provider} onClick={() => void test(provider)}><PlugZap size={14} aria-hidden />{t("trendRadar.config.test")}</Button> : null);

  return (
    <div className="flex flex-col gap-4" data-testid="trend-config">
      {readOnly ? <Banner variant="info">{t("trendRadar.config.adminOnly")}</Banner> : null}
      {error ? <Banner variant="danger">{error}</Banner> : null}

      <Panel title={t("trendRadar.config.yahoo")} aside={testButton("yahoo_news")}>
        {config.yahooRightsConfirmed ? <Banner variant="success">{t("trendRadar.config.yahooRightsOk")}</Banner> : (
          <Banner variant="warn">
            <strong>{t("trendRadar.sources.state.rights_unconfirmed")}</strong> - {t("trendRadar.config.yahooRights")}{" "}
            <a href={config.yahooTermsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">{t("trendRadar.sources.terms")}<ExternalLink size={12} aria-hidden /></a>
          </Banner>
        )}
        <Toggle testId="yahoo-enabled" label={t("trendRadar.config.enabled")} checked={draft.yahooEnabled} disabled={readOnly || (!config.yahooRightsConfirmed && !draft.yahooEnabled)} onChange={(yahooEnabled) => set({ yahooEnabled })} />
        <Field label={t("trendRadar.config.yahooCategories")}>
          <div className="flex flex-wrap gap-3">
            {config.yahooAvailableCategories.map((category) => (
              <Toggle key={category} label={t(`trendRadar.config.yahooCategory.${category}`, { defaultValue: category })} checked={draft.yahooCategories.includes(category)} disabled={readOnly} onChange={(on) => set({ yahooCategories: toggleIn(draft.yahooCategories, category, on) })} />
            ))}
          </div>
        </Field>
        {testResult("yahoo_news")}
      </Panel>

      <Panel title={t("trendRadar.config.tiktok")} aside={testButton("tiktok")}>
        <p className="text-[12px] text-lyx-fg-muted">{t("trendRadar.config.tiktokNote")}</p>
        <Toggle label={t("trendRadar.config.enabled")} checked={draft.tiktokEnabled} disabled={readOnly} onChange={(tiktokEnabled) => set({ tiktokEnabled })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("trendRadar.config.tiktokAccount")}>
            <Select value={draft.tiktokAccountId ?? ""} disabled={readOnly} onChange={(event) => set({ tiktokAccountId: event.target.value || null })}>
              <option value="">{t("trendRadar.config.tiktokAccountNone")}</option>
              {config.tiktokAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.enabled ? "" : " (off)"}</option>)}
            </Select>
          </Field>
          <Field label={t("trendRadar.config.tiktokMaxQueries")}><TextInput type="number" min={1} max={10} disabled={readOnly} value={draft.tiktokMaxQueries} onChange={(event) => set({ tiktokMaxQueries: number(event.target.value) })} /></Field>
          <Field label={t("trendRadar.config.tiktokResults")}><TextInput type="number" min={5} max={30} disabled={readOnly} value={draft.tiktokResultsPerQuery} onChange={(event) => set({ tiktokResultsPerQuery: number(event.target.value) })} /></Field>
          <Field label={t("trendRadar.config.tiktokMinViews")}><TextInput type="number" min={0} disabled={readOnly} value={draft.tiktokMinViews} onChange={(event) => set({ tiktokMinViews: number(event.target.value) })} /></Field>
        </div>
        {testResult("tiktok")}
      </Panel>

      <Panel title={`${t("trendRadar.config.keywords")} / ${t("trendRadar.config.hashtags")}`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("trendRadar.config.keywords")} hint={t("trendRadar.config.wordsHint")}><TextArea lang="ja" disabled={readOnly} value={draft.keywordsText} onChange={(event) => set({ keywordsText: event.target.value })} /></Field>
          <Field label={t("trendRadar.config.hashtags")} hint={t("trendRadar.config.wordsHint")}><TextArea lang="ja" disabled={readOnly} value={draft.hashtagsText} onChange={(event) => set({ hashtagsText: event.target.value })} /></Field>
        </div>
        <Field label={t("trendRadar.config.categories")}>
          <div className="flex flex-wrap gap-3">
            {TREND_CATEGORIES.map((category) => <Toggle key={category} label={t(`trendRadar.category.${category}`)} checked={draft.categories.includes(category)} disabled={readOnly} onChange={(on) => set({ categories: toggleIn(draft.categories, category, on) })} />)}
          </div>
        </Field>
        <p className="text-[11px] text-lyx-fg-subtle">{t("trendRadar.config.wordsCount", { keywords: linesOf(draft.keywordsText).length, hashtags: linesOf(draft.hashtagsText).length })}</p>
      </Panel>

      <Panel title={t("trendRadar.config.schedule")}>
        <Toggle label={t("trendRadar.config.scheduleEnabled")} checked={draft.scheduleEnabled} disabled={readOnly} onChange={(scheduleEnabled) => set({ scheduleEnabled })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("trendRadar.config.interval")}><TextInput type="number" min={15} max={360} disabled={readOnly} value={draft.intervalMinutes} onChange={(event) => set({ intervalMinutes: number(event.target.value) })} /></Field>
          <Field label={t("trendRadar.config.window")}><TextInput type="number" min={6} max={168} disabled={readOnly} value={draft.windowHours} onChange={(event) => set({ windowHours: number(event.target.value) })} /></Field>
        </div>
      </Panel>

      <Panel title={t("trendRadar.config.thresholds")}>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t("trendRadar.band.hot")}><TextInput type="number" min={1} max={100} disabled={readOnly} value={draft.thresholds.hot} onChange={(event) => set({ thresholds: { ...draft.thresholds, hot: number(event.target.value) } })} /></Field>
          <Field label={t("trendRadar.band.rising")}><TextInput type="number" min={1} max={100} disabled={readOnly} value={draft.thresholds.rising} onChange={(event) => set({ thresholds: { ...draft.thresholds, rising: number(event.target.value) } })} /></Field>
          <Field label={t("trendRadar.band.review")}><TextInput type="number" min={1} max={100} disabled={readOnly} value={draft.thresholds.review} onChange={(event) => set({ thresholds: { ...draft.thresholds, review: number(event.target.value) } })} /></Field>
          <Field label={t("trendRadar.config.notifyMin")}><TextInput type="number" min={0} max={100} disabled={readOnly} value={draft.notifyMinScore} onChange={(event) => set({ notifyMinScore: number(event.target.value) })} /></Field>
        </div>
      </Panel>

      <Panel title={t("trendRadar.config.analysis")}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("trendRadar.config.analysisAccount")}>
            <Select value={draft.analysisAccountId ?? ""} disabled={readOnly} onChange={(event) => set({ analysisAccountId: event.target.value || null })}>
              <option value="">{t("trendRadar.config.analysisAccountAuto")}</option>
              {config.analysisAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.model}</option>)}
            </Select>
          </Field>
          <Field label={t("trendRadar.config.autoPerDay")}><TextInput type="number" min={0} max={5} disabled={readOnly} value={draft.autoAnalysisPerDay} onChange={(event) => set({ autoAnalysisPerDay: number(event.target.value) })} /></Field>
          <Field label={t("trendRadar.config.totalPerDay")}><TextInput type="number" min={0} max={100} disabled={readOnly} value={draft.analysisPerDay} onChange={(event) => set({ analysisPerDay: number(event.target.value) })} /></Field>
        </div>
        <p className="text-[12px] text-lyx-fg-muted">
          {t("trendRadar.config.usageToday", { auto: config.analysisUsageToday.auto, manual: config.analysisUsageToday.manual, failures: config.analysisUsageToday.failures })}
          {config.analysisUsageToday.model ? ` · ${config.analysisUsageToday.model}` : ""}
        </p>
      </Panel>

      {isAdmin ? (
        <div className="flex justify-end">
          <Button loading={saving} onClick={() => void save()}>{t("trendRadar.config.save")}</Button>
        </div>
      ) : null}
    </div>
  );
}
