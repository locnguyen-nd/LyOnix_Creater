import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Banner, PageHeader } from "../components/chrome";
import { Button, Field, Select, TextArea } from "../components/ui";
import { api, ApiError, csrfHeaders } from "../api";
import type { ApiJob, ApiProvider } from "../jobs-api";
import type { PublicChannel } from "../channel-api";
import type { ElevenLabsVoiceSummaryResponse, UiLocale, VideoProductionSourceInput } from "@lyonix/contracts";
import { listCreatomateTemplates, listElevenLabsVoices, pinTemplateSnapshot } from "../studio/timeline-api";
import { setupAutoProfile, submitVideoProduction } from "../video-productions-api";

const DURATION_TARGETS = ["30-45s", "45-65s", "65-90s"] as const;
const SCENE_COUNT_TARGETS = ["6-8", "8-12", "12-16"] as const;
const AUTO_SOURCE_TYPES = ["topic", "raw_script", "article_url"] as const;

/** Auto mode has no manual review step (D10) - it needs one concrete number, not a range. */
const midpoint = (range: string) => {
  const [lo, hi] = range.replace(/s$/, "").split("-").map(Number);
  return Math.round(((lo ?? 0) + (hi ?? lo ?? 0)) / 2);
};

const usableAccounts = (providers: ApiProvider[], role: ApiProvider["role"]) =>
  providers.filter((item) => item.role === role && (item.isFake || item.status === "verified"));

/**
 * The generate direction sent to the content provider must match the script's own target
 * `language`, not the UI locale a Vietnamese-speaking operator happens to be using — a
 * hardcoded Vietnamese instruction here previously leaked into every generated script
 * regardless of the selected script language (e.g. a `ja` script request carrying a
 * Vietnamese-only instruction), risking mixed-language output.
 */
const TARGET_HINT_BY_LOCALE: Record<UiLocale, (durationSeconds: string, sceneCount: string) => string> = {
  vi: (duration, scenes) => `Viết kịch bản TikTok ${duration} giây, ${scenes} cảnh. Không trả nguyên văn nguồn dài.`,
  en: (duration, scenes) => `Write a TikTok script ${duration} seconds long with ${scenes} scenes. Do not return the long source verbatim.`,
  ja: (duration, scenes) => `${duration}秒、${scenes}シーンのTikTok台本を作成してください。長い元テキストをそのまま返さないでください。`,
  ko: (duration, scenes) => `${duration}초, ${scenes}개 장면의 TikTok 대본을 작성하세요. 긴 원문을 그대로 반환하지 마세요.`,
};

export function JobNewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [channels, setChannels] = useState<PublicChannel[]>([]);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [mode, setMode] = useState<"topic" | "revise">("topic");
  const [channelId, setChannelId] = useState(params.get("channelId") ?? "");
  const [topic, setTopic] = useState("");
  const [promptSpec, setPromptSpec] = useState("");
  const [existingScript, setExistingScript] = useState("");
  const [language, setLanguage] = useState<UiLocale>("vi");
  const [content, setContent] = useState("");
  const [durationTarget, setDurationTarget] = useState<(typeof DURATION_TARGETS)[number]>("45-65s");
  const [sceneCountTarget, setSceneCountTarget] = useState<(typeof SCENE_COUNT_TARGETS)[number]>("8-12");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // VE2E-08: Auto entry (spec §7) - toggle Auto|Studio, single CTA, preflight must be all-green.
  const [entryMode, setEntryMode] = useState<"manual" | "auto">("manual");
  const [autoSourceType, setAutoSourceType] = useState<(typeof AUTO_SOURCE_TYPES)[number]>("topic");
  const [autoRawScript, setAutoRawScript] = useState("");
  const [autoArticleUrl, setAutoArticleUrl] = useState("");
  const [voiceAccountId, setVoiceAccountId] = useState("");
  const [voices, setVoices] = useState<ElevenLabsVoiceSummaryResponse[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [mediaAccountId, setMediaAccountId] = useState("");
  const [renderAccountId, setRenderAccountId] = useState("");

  const contentAccounts = providers.filter((item) => item.role === "content" && (item.isFake || item.status === "verified"));
  const voiceAccounts = usableAccounts(providers, "tts");
  const mediaAccounts = usableAccounts(providers, "visual");
  const renderAccounts = usableAccounts(providers, "render");
  const preflight = [
    { key: "content", ok: contentAccounts.length > 0 },
    { key: "voice", ok: voiceAccounts.length > 0 && Boolean(voiceId) },
    { key: "media", ok: mediaAccounts.length > 0 },
    { key: "render", ok: renderAccounts.length > 0 },
  ] as const;
  const preflightReady = preflight.every((row) => row.ok);
  const selected = contentAccounts.find((item) => item.id === content);
  const selectedChannel = channels.find((item) => item.id === channelId);
  const generatingLabel = selected
    ? t("jobs.generating", { provider: selected.provider, model: selected.model })
    : t("common.loading");

  useEffect(() => {
    if (entryMode !== "auto") return;
    setVoiceAccountId((current) => current || voiceAccounts[0]?.id || "");
    setMediaAccountId((current) => current || mediaAccounts[0]?.id || "");
    setRenderAccountId((current) => current || renderAccounts[0]?.id || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryMode, providers]);

  useEffect(() => {
    if (!voiceAccountId) { setVoices([]); return; }
    void listElevenLabsVoices(voiceAccountId).then((rows) => {
      setVoices(rows);
      setVoiceId((current) => (rows.some((row) => row.voiceId === current) ? current : rows[0]?.voiceId ?? ""));
    }).catch(() => setVoices([]));
  }, [voiceAccountId]);

  useEffect(() => {
    void Promise.all([api<PublicChannel[]>("/channels"), api<ApiProvider[]>("/provider-accounts")])
      .then(([nextChannels, nextProviders]) => {
        setChannels(nextChannels);
        setProviders(nextProviders);
        setChannelId((current) => current || nextChannels[0]?.id || "");
        const first = nextProviders.find((item) => item.role === "content" && item.status === "verified") ?? nextProviders.find((item) => item.role === "content");
        setContent((current) => current || first?.id || "");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
  }, []);

  const nextSteps = [
    t("jobs.nextStep1"),
    t("jobs.nextStep2"),
    t("jobs.nextStep3"),
    t("jobs.nextStep4"),
  ];

  return (
    <>
      <PageHeader title={t("jobs.create")} />
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {contentAccounts.length === 0 ? (
        <Banner variant="warn">
          {t("jobs.needProvider")} <Link className="underline" to="/settings">{t("providers.title")}</Link>
        </Banner>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <form
          className="flex flex-col gap-5 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (entryMode === "auto") {
              void (async () => {
                try {
                  setBusy(true);
                  setError(null);
                  const source: VideoProductionSourceInput =
                    autoSourceType === "raw_script" ? { type: "raw_script", rawScript: autoRawScript }
                    : autoSourceType === "article_url" ? { type: "article_url", url: autoArticleUrl }
                    : { type: "topic", topic };
                  const templates = await listCreatomateTemplates(renderAccountId);
                  const firstTemplate = templates[0];
                  if (!firstTemplate) throw new ApiError("VALIDATION_FAILED", t("jobs.autoNoTemplate"));
                  const snapshot = await pinTemplateSnapshot(renderAccountId, firstTemplate.externalTemplateId);
                  const setup = await setupAutoProfile({
                    name: (topic || autoArticleUrl || "Auto video").slice(0, 60),
                    contentAccountId: content,
                    voiceAccountId,
                    voiceId,
                    mediaAccountId,
                    renderAccountId,
                    templateSnapshotId: snapshot.id,
                    locale: language,
                    durationSec: midpoint(durationTarget),
                    sceneCount: midpoint(sceneCountTarget),
                  });
                  const submitted = await submitVideoProduction(setup.projectId, setup.automationProfileId, source);
                  navigate(`/video-productions/${submitted.id}`);
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : t("common.error"));
                } finally {
                  setBusy(false);
                }
              })();
              return;
            }
            void (async () => {
              try {
                setBusy(true);
                setError(null);
                const job = await api<ApiJob>("/jobs", {
                  method: "POST",
                  headers: await csrfHeaders(),
                  body: JSON.stringify({
                    topic,
                    locale: language,
                    mode: "topic",
                    channelId,
                    promptSpec,
                    contentProviderAccountId: content,
                    existingScript: mode === "revise" ? existingScript : "",
                  }),
                });
                try {
                  const targetHint = TARGET_HINT_BY_LOCALE[language](durationTarget.replace(/s$/, ""), sceneCountTarget);
                  const direction = promptSpec.trim() ? `${promptSpec.slice(0, 450)} (${targetHint})` : targetHint;
                  const generated = await api<ApiJob>(`/jobs/${job.id}/script/generate`, {
                    method: "POST",
                    headers: await csrfHeaders(),
                    body: JSON.stringify({ direction }),
                  });
                  navigate(`/jobs/${generated.id}/script`);
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : t("common.error"));
                  navigate(`/jobs/${job.id}/script`);
                }
              } catch (err) {
                setError(err instanceof ApiError ? err.message : t("common.error"));
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          <div className="inline-flex w-fit gap-0.5 rounded-[8px] bg-lyx-muted p-1">
            <button type="button" onClick={() => setEntryMode("auto")} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${entryMode === "auto" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
              {t("jobs.autoModeLabel")}
            </button>
            <button type="button" onClick={() => setEntryMode("manual")} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${entryMode === "manual" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
              {t("jobs.studioModeLabel")}
            </button>
          </div>

          {entryMode === "manual" ? (
            <div className="inline-flex w-fit gap-0.5 rounded-[8px] bg-lyx-muted p-1">
              <button type="button" onClick={() => setMode("topic")} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${mode === "topic" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
                {t("jobs.topicMode")}
              </button>
              <button type="button" onClick={() => setMode("revise")} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${mode === "revise" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
                {t("jobs.reviseMode")}
              </button>
            </div>
          ) : (
            <div className="inline-flex w-fit gap-0.5 rounded-[8px] bg-lyx-muted p-1">
              {AUTO_SOURCE_TYPES.map((type) => (
                <button key={type} type="button" onClick={() => setAutoSourceType(type)} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${autoSourceType === type ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
                  {t(`jobs.autoSource.${type}`)}
                </button>
              ))}
            </div>
          )}

          <div>
            <p className="mb-2.5 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("jobs.basicsSection")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("jobs.channel")}>
                <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
                  {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
                </Select>
              </Field>
              <Field label={t("jobs.language")}>
                <Select value={language} onChange={(e) => setLanguage(e.target.value as UiLocale)}>
                  <option value="vi">VI</option><option value="en">EN</option><option value="ja">JA</option><option value="ko">KO</option>
                </Select>
              </Field>
            </div>
          </div>

          {entryMode === "manual" ? (
            <>
              <Field label={t("jobs.topic")} {...(error ? { error } : {})}>
                <TextArea value={topic} onChange={(e) => setTopic(e.target.value)} required />
              </Field>
              <Field label={t("jobs.prompt")} hint={t("jobs.promptHint")}>
                <TextArea value={promptSpec} onChange={(e) => setPromptSpec(e.target.value)} />
              </Field>
              {mode === "revise" ? (
                <Field label={t("jobs.existingScript")} hint={t("jobs.existingScriptHint")}>
                  <TextArea value={existingScript} onChange={(e) => setExistingScript(e.target.value)} required />
                </Field>
              ) : null}
            </>
          ) : (
            <>
              {autoSourceType === "topic" ? (
                <Field label={t("jobs.topic")} {...(error ? { error } : {})}>
                  <TextArea value={topic} onChange={(e) => setTopic(e.target.value)} required />
                </Field>
              ) : autoSourceType === "raw_script" ? (
                <Field label={t("jobs.existingScript")} {...(error ? { error } : {})}>
                  <TextArea value={autoRawScript} onChange={(e) => setAutoRawScript(e.target.value)} required />
                </Field>
              ) : (
                <Field label={t("jobs.autoSource.article_url")} {...(error ? { error } : {})}>
                  <TextArea value={autoArticleUrl} onChange={(e) => setAutoArticleUrl(e.target.value)} required />
                </Field>
              )}
            </>
          )}

          <div className="border-t border-lyx-border pt-4">
            <Field label={t("jobs.contentAccount")}>
              <Select value={content} onChange={(e) => setContent(e.target.value)} required>
                {contentAccounts.map((item) => (
                  <option key={item.id} value={item.id}>{item.name} · {item.provider} · {item.model}{item.status !== "verified" ? " · ?" : ""}</option>
                ))}
              </Select>
            </Field>
          </div>

          {entryMode === "auto" ? (
            <div className="flex flex-col gap-3 border-t border-lyx-border pt-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("jobs.autoPreflightTitle")}</p>
              <ul className="flex flex-col gap-1.5">
                {preflight.map((row) => (
                  <li key={row.key} className="flex items-center justify-between text-[12.5px]">
                    <span className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${row.ok ? "bg-lyx-ok" : "bg-lyx-danger"}`} />
                      {t(`jobs.autoPreflight.${row.key}`)}
                    </span>
                    {!row.ok ? <Link className="text-[11.5px] underline" to="/settings">{t("providers.title")}</Link> : null}
                  </li>
                ))}
              </ul>
              {voiceAccounts.length > 0 ? (
                <Field label={t("jobs.autoVoice")}>
                  <Select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                    {voices.map((voice) => <option key={voice.voiceId} value={voice.voiceId}>{voice.name}</option>)}
                  </Select>
                </Field>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 border-t border-lyx-border pt-4">
            <p className="text-[11.5px] text-lyx-fg-muted">{entryMode === "auto" ? t("jobs.autoSubmitHint") : t("jobs.submitHint")}</p>
            <Button type="submit" disabled={busy || !content || (entryMode === "auto" && !preflightReady)}>
              {busy ? generatingLabel : entryMode === "auto" ? t("jobs.autoSubmit") : t("jobs.submit")}
            </Button>
          </div>
        </form>

        <div className="flex flex-col gap-4">
          <div className="rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("jobs.summary")}</p>
            <dl className="flex flex-col">
              <div className="flex items-center justify-between border-b border-lyx-neutral-bg py-2 text-[12.5px]">
                <dt className="text-lyx-fg-muted">{t("jobs.channel")}</dt>
                <dd className="font-medium">{selectedChannel?.name ?? "—"}</dd>
              </div>
              <div className="flex items-center justify-between border-b border-lyx-neutral-bg py-2 text-[12.5px]">
                <dt className="text-lyx-fg-muted">{t("jobs.language")}</dt>
                <dd className="font-medium uppercase">{language}</dd>
              </div>
              <div className="flex items-center justify-between py-2 text-[12.5px]">
                <dt className="text-lyx-fg-muted">{t("jobs.durationTarget")}</dt>
                <dd>
                  <Select className="h-8 text-[12px]" value={durationTarget} onChange={(e) => setDurationTarget(e.target.value as (typeof DURATION_TARGETS)[number])}>
                    {DURATION_TARGETS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </Select>
                </dd>
              </div>
              <div className="flex items-center justify-between border-t border-lyx-neutral-bg py-2 text-[12.5px]">
                <dt className="text-lyx-fg-muted">{t("jobs.sceneCountTarget")}</dt>
                <dd>
                  <Select className="h-8 text-[12px]" value={sceneCountTarget} onChange={(e) => setSceneCountTarget(e.target.value as (typeof SCENE_COUNT_TARGETS)[number])}>
                    {SCENE_COUNT_TARGETS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </Select>
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("jobs.nextStepsTitle")}</p>
            <ol className="flex flex-col">
              {nextSteps.map((label, index) => (
                <li key={label} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-lyx-neutral-bg text-[11px] font-bold text-lyx-fg-muted">{index + 1}</span>
                    {index < nextSteps.length - 1 ? <span className="w-px flex-1 bg-lyx-border" /> : null}
                  </div>
                  <p className="pb-4 text-[12.5px] leading-[22px]">{label}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </>
  );
}
