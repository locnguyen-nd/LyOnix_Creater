import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Banner, PageHeader } from "../components/chrome";
import { Button, Field, Select, TextArea } from "../components/ui";
import { api, ApiError, csrfHeaders } from "../api";
import type { ApiJob, ApiProvider } from "../jobs-api";
import type { PublicChannel } from "../channel-api";
import type { UiLocale } from "@lyonix/contracts";

const DURATION_TARGETS = ["30-45s", "45-65s", "65-90s"] as const;
const SCENE_COUNT_TARGETS = ["6-8", "8-12", "12-16"] as const;

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
  const contentAccounts = providers.filter((item) => item.role === "content" && (item.isFake || item.status === "verified"));
  const selected = contentAccounts.find((item) => item.id === content);
  const generatingLabel = selected
    ? t("jobs.generating", { provider: selected.provider, model: selected.model })
    : t("common.loading");

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

  return (
    <>
      <PageHeader title={t("jobs.create")} />
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {contentAccounts.length === 0 ? (
        <Banner variant="warn">
          {t("jobs.needProvider")} <Link className="underline" to="/settings">{t("providers.title")}</Link>
        </Banner>
      ) : null}
      <div className="mb-4 flex gap-2">
        <Button variant={mode === "topic" ? "primary" : "secondary"} onClick={() => setMode("topic")}>{t("jobs.topicMode")}</Button>
        <Button variant={mode === "revise" ? "primary" : "secondary"} onClick={() => setMode("revise")}>{t("jobs.reviseMode")}</Button>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
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
          <Field label={t("jobs.contentAccount")}>
            <Select value={content} onChange={(e) => setContent(e.target.value)} required>
              {contentAccounts.map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.provider} · {item.model}{item.status !== "verified" ? " · ?" : ""}</option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={busy || !content}>{busy ? generatingLabel : t("jobs.submit")}</Button>
        </form>
        <aside className="flex flex-col gap-4 border border-lyx-border p-4">
          <div>
            <h2 className="mb-2 text-[16px] font-semibold">{t("jobs.summary")}</h2>
            <p className="text-[12px] text-lyx-fg-muted">{t("jobs.preset")}</p>
          </div>
          <Field label={t("jobs.durationTarget")}>
            <Select value={durationTarget} onChange={(e) => setDurationTarget(e.target.value as (typeof DURATION_TARGETS)[number])}>
              {DURATION_TARGETS.map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </Field>
          <Field label={t("jobs.sceneCountTarget")}>
            <Select value={sceneCountTarget} onChange={(e) => setSceneCountTarget(e.target.value as (typeof SCENE_COUNT_TARGETS)[number])}>
              {SCENE_COUNT_TARGETS.map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </Field>
          <p className="border-t border-lyx-border pt-3 text-[11px] leading-4 text-lyx-fg-muted">{t("jobs.nextStepsHint")}</p>
        </aside>
      </div>
    </>
  );
}
