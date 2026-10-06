import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Banner, PageHeader } from "../components/chrome";
import { Button, Field, Select, TextArea } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Check } from "lucide-react";
import { TemplatePreviewButton, TemplatePreviewModal, TemplateThumb } from "../components/TemplatePreviewModal";
import { engineOfProvider } from "../studio/render-engine";
import { api, ApiError, csrfHeaders } from "../api";
import type { ApiJob, ApiProvider } from "../jobs-api";
import type { PublicChannel } from "../channel-api";
import type { BackgroundSegmentsSetting, CreatomateTemplateSummaryResponse, CreationPreferenceOptions, ElevenLabsVoiceSummaryResponse, UiLocale, VideoProductionSourceInput } from "@lyonix/contracts";
// Browser-safe subpaths (the bare `@lyonix/domain` barrel pulls in node:crypto - see its index.ts).
import { resolveBackgroundSegmentRange } from "@lyonix/domain/background-segments";
import {
  AUTO_SOURCE_TYPES,
  BACKGROUND_SEGMENT_CHOICES,
  DURATION_TARGETS,
  SCENE_COUNT_TARGETS,
  SYSTEM_CREATION_DEFAULTS,
  pickCreationPreferences,
  type JobNewFieldKey,
  type JobNewFormValues,
} from "@lyonix/domain/creation-form";
import { listCreatomateTemplates, listElevenLabsVoices, pinTemplateSnapshot } from "../studio/timeline-api";
import { isTemplateOnlyRenderProvider, renderAccountOptionLabel } from "../studio/render-provider";
import { ORSHOT_FORMATS, ORSHOT_SIZES, compactOrshotOptions } from "../studio/orshot-embed";
import { setupAutoProfile, submitVideoProduction } from "../video-productions-api";
import { deleteJobNewDraft, getCreationPreferences, getJobNewDraft, resetCreationPreferences, saveCreationPreferences, saveJobNewDraft } from "../job-new/creation-api";
import { DraftAutosaver, type DraftSaveStatus } from "../job-new/draft-autosave";
import { FIELD_LABEL_KEYS, autofillSystemChoices, buildInitialFormState, creationLists, usableAccounts, type CreationLists } from "../job-new/form-state";

const toBackgroundSegmentsSetting = (choice: string): BackgroundSegmentsSetting => (choice === "auto" ? { mode: "auto" } : { mode: "fixed", count: Number(choice) });

/** Auto mode has no manual review step (D10) - it needs one concrete number, not a range. */
const midpoint = (range: string) => {
  const [lo, hi] = range.replace(/s$/, "").split("-").map(Number);
  return Math.round(((lo ?? 0) + (hi ?? lo ?? 0)) / 2);
};

const formatTime = (date: Date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voices, setVoices] = useState<ElevenLabsVoiceSummaryResponse[]>([]);
  const [renderTemplates, setRenderTemplates] = useState<CreatomateTemplateSummaryResponse[]>([]);

  // VE2E-124: the whole form is one value - what the draft stores and the defaults are picked from.
  const [form, setForm] = useState<JobNewFormValues>(SYSTEM_CREATION_DEFAULTS);
  const formRef = useRef(form);
  formRef.current = form;
  const [hydrated, setHydrated] = useState(false);
  /** Fields whose value came from the draft / the user's defaults / the URL and was not changed by the user since. */
  const restoredRef = useRef(new Set<JobNewFieldKey>());
  /** Restored values that no longer exist: cleared, shown as a warning, never replaced automatically. */
  const clearedRef = useRef(new Set<JobNewFieldKey>());
  const [cleared, setCleared] = useState<JobNewFieldKey[]>([]);
  const touchedRef = useRef(false);
  const closedRef = useRef(false);
  const preferencesRef = useRef<CreationPreferenceOptions | null>(null);
  const [restoredAt, setRestoredAt] = useState<Date | null>(null);
  const [draftStatus, setDraftStatus] = useState<DraftSaveStatus>({ kind: "idle" });
  const [defaultsMessage, setDefaultsMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [defaultsBusy, setDefaultsBusy] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const autosaver = useMemo(
    () => new DraftAutosaver<JobNewFormValues>({ save: saveJobNewDraft, onStatus: setDraftStatus, isConflict: (err) => err instanceof ApiError && err.code === "VERSION_CONFLICT" }),
    [],
  );

  const contentAccounts = usableAccounts(providers, "content");
  const voiceAccounts = usableAccounts(providers, "tts");
  const mediaAccounts = usableAccounts(providers, "visual").filter((item) => item.provider === "pexels");
  const renderAccountChoices = providers.filter((item) => item.role === "render");
  const renderAccounts = usableAccounts(providers, "render");
  const lists: CreationLists = creationLists(channels, providers);
  const renderProvider = renderAccounts.find((account) => account.id === form.renderAccountId)?.provider;
  const isOrshotRender = isTemplateOnlyRenderProvider(renderProvider);
  // V04-XX: templates of the chosen render account, labelled with its engine for the preview.
  const previewTemplates = renderTemplates.map((tpl) => ({ ...tpl, engine: engineOfProvider(renderProvider ?? "creatomate") }));
  // Auto resolves against the same target duration the Auto profile is created with (midpoint of the range).
  const autoSegmentRange = resolveBackgroundSegmentRange({ mode: "auto" }, midpoint(form.durationTarget));
  const preflight = [
    { key: "content", ok: contentAccounts.length > 0 },
    { key: "voice", ok: Boolean(form.voiceAccountId) && Boolean(form.voiceId) },
    { key: "media", ok: Boolean(form.mediaAccountId) },
    { key: "render", ok: Boolean(form.renderAccountId) },
    { key: "template", ok: Boolean(form.templateId) },
  ] as const;
  const preflightReady = preflight.every((row) => row.ok);
  const selected = contentAccounts.find((item) => item.id === form.contentAccountId);
  const selectedChannel = channels.find((item) => item.id === form.channelId);
  const generatingLabel = selected
    ? t("jobs.generating", { provider: selected.provider, model: selected.model })
    : t("common.loading");

  const setClearedFields = (next: Set<JobNewFieldKey>) => {
    clearedRef.current = next;
    setCleared([...next]);
  };
  /** A change made by the user: autosaved, and those fields are no longer "restored" (nor flagged as needing a new choice). */
  const update = (patch: Partial<JobNewFormValues>, alsoResolved: JobNewFieldKey[] = []) => {
    touchedRef.current = true;
    const keys = [...(Object.keys(patch) as JobNewFieldKey[]), ...alsoResolved];
    keys.forEach((key) => restoredRef.current.delete(key));
    if (keys.some((key) => clearedRef.current.has(key))) setClearedFields(new Set([...clearedRef.current].filter((key) => !keys.includes(key))));
    setForm((prev) => ({ ...prev, ...patch }));
  };
  /** A programmatic fill (system auto-pick, list results): not a user change. */
  const fill = (patch: Partial<JobNewFormValues>) => setForm((prev) => ({ ...prev, ...patch }));
  const markCleared = (keys: JobNewFieldKey[]) => setClearedFields(new Set([...clearedRef.current, ...keys]));

  /** Restored start state (draft > user defaults > system defaults, URL intent on top), validated against what the user can pick now. */
  const applyInitialState = (input: { draft: Partial<JobNewFormValues> | null; preferences: CreationPreferenceOptions | null; lists: CreationLists }) => {
    const state = buildInitialFormState({ draft: input.draft, preferences: input.preferences, url: { entryMode: params.get("entry"), channelId: params.get("channelId") }, lists: input.lists });
    restoredRef.current = state.restored;
    setClearedFields(new Set(state.cleared));
    touchedRef.current = false;
    setForm(state.values);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextChannels, nextProviders, draft, preferences] = await Promise.all([
          api<PublicChannel[]>("/channels"),
          api<ApiProvider[]>("/provider-accounts"),
          getJobNewDraft().catch(() => null),
          getCreationPreferences().catch(() => null),
        ]);
        if (cancelled) return;
        setChannels(nextChannels);
        setProviders(nextProviders);
        preferencesRef.current = preferences?.options ?? null;
        applyInitialState({ draft: draft?.payload ?? null, preferences: preferencesRef.current, lists: creationLists(nextChannels, nextProviders) });
        if (draft) {
          setRestoredAt(new Date(draft.updatedAt));
          setDraftStatus({ kind: "saved", at: new Date(draft.updatedAt) });
        }
        // Autosave only from now on: the restored values never overwrite the stored draft by themselves.
        autosaver.start(draft?.version ?? null);
        setHydrated(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t("common.error"));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave (debounced in DraftAutosaver) - only after the user changed something.
  useEffect(() => {
    if (hydrated && touchedRef.current && !closedRef.current) autosaver.schedule(form);
  }, [form, hydrated, autosaver]);

  // Leaving the page (SPA navigation, tab hidden): save a change still waiting for its debounce.
  useEffect(() => {
    const flush = () => {
      if (!closedRef.current) void autosaver.flushPending();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
      autosaver.stop();
    };
  }, [autosaver]);

  // Auto mode: an empty voice / Pexels / render account takes the first one (unchanged behaviour), unless a restored value was cleared.
  useEffect(() => {
    if (!hydrated || form.entryMode !== "auto") return;
    const filled = autofillSystemChoices(formRef.current, creationLists(channels, providers), clearedRef.current);
    const patch: Partial<JobNewFormValues> = {};
    for (const key of ["voiceAccountId", "mediaAccountId", "renderAccountId"] as const) if (filled[key] !== formRef.current[key]) patch[key] = filled[key];
    if (Object.keys(patch).length) fill(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, form.entryMode, providers]);

  useEffect(() => {
    const accountId = form.voiceAccountId;
    if (!accountId) { setVoices([]); return; }
    let cancelled = false;
    void listElevenLabsVoices(accountId).then((rows) => {
      if (cancelled) return;
      setVoices(rows);
      const current = formRef.current.voiceId;
      if (current && rows.some((row) => row.voiceId === current)) return;
      if (current && restoredRef.current.has("voiceId")) {
        // A saved voice that no longer exists: clear it and ask, never pick another voice silently.
        restoredRef.current.delete("voiceId");
        markCleared(["voiceId"]);
        fill({ voiceId: "" });
        return;
      }
      if (clearedRef.current.has("voiceId")) return;
      fill({ voiceId: rows[0]?.voiceId ?? "" });
    }).catch(() => { if (!cancelled) setVoices([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.voiceAccountId]);

  /**
   * VE2E-23: the render template used to be auto-picked (`templates[0]`, whichever the
   * Creatomate account happened to return first) with no compatibility check — every
   * template pinned so far requires at least one "image" modification slot that Auto's
   * scene media (Pexels, almost always video) can never fill, so every Auto run failed
   * the same way at the last step. Owner decision (chat, 26/09): let the operator pick
   * the template explicitly instead of guessing. Resetting `templateId` whenever the
   * account changes (or the previous pick isn't in the new list) keeps this an explicit
   * choice rather than silently falling back to a default. VE2E-124: a restored template that
   * is gone is reported as such.
   */
  useEffect(() => {
    const accountId = form.renderAccountId;
    if (!accountId) { setRenderTemplates([]); return; }
    let cancelled = false;
    void listCreatomateTemplates(accountId).then((rows) => {
      if (cancelled) return;
      setRenderTemplates(rows);
      const current = formRef.current.templateId;
      if (!current || rows.some((row) => row.externalTemplateId === current)) return;
      if (restoredRef.current.has("templateId")) {
        restoredRef.current.delete("templateId");
        markCleared(["templateId"]);
      }
      fill({ templateId: "" });
    }).catch(() => { if (!cancelled) setRenderTemplates([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.renderAccountId]);

  /** After a successful submit: the draft is done - stop autosave and delete it, so the next new job starts from the defaults. */
  const closeDraft = async () => {
    closedRef.current = true;
    autosaver.stop();
    await autosaver.idle();
    await deleteJobNewDraft().catch(() => undefined);
  };

  const saveDraftNow = () => {
    closedRef.current = false;
    touchedRef.current = true;
    void autosaver.flush(formRef.current);
  };

  const overwriteDraft = async () => {
    try {
      const current = await getJobNewDraft();
      autosaver.adoptVersion(current?.version ?? null);
      await autosaver.retry();
    } catch (err) {
      setDraftStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Runs once the user confirmed in the dialog (no browser `confirm` popup). */
  const discardDraft = async () => {
    setDiscarding(true);
    try {
      autosaver.stop();
      await autosaver.idle();
      await deleteJobNewDraft().catch(() => undefined);
      applyInitialState({ draft: null, preferences: preferencesRef.current, lists });
      setRestoredAt(null);
      setDraftStatus({ kind: "idle" });
      closedRef.current = false;
      autosaver.start(null);
    } finally {
      setDiscarding(false);
      setDiscardOpen(false);
    }
  };

  const saveDefaults = async () => {
    setDefaultsBusy(true);
    setDefaultsMessage(null);
    try {
      const saved = await saveCreationPreferences(pickCreationPreferences(formRef.current));
      preferencesRef.current = saved.options;
      setDefaultsMessage({ ok: true, text: t("jobs.defaultsSaved") });
    } catch (err) {
      setDefaultsMessage({ ok: false, text: err instanceof ApiError ? err.message : t("common.error") });
    } finally {
      setDefaultsBusy(false);
    }
  };

  const resetDefaults = async () => {
    if (!window.confirm(t("jobs.defaultsResetConfirm"))) return;
    setDefaultsBusy(true);
    setDefaultsMessage(null);
    try {
      await resetCreationPreferences();
      preferencesRef.current = null;
      // Options back to the system defaults (the topic/script being typed is kept), then the usual first-available picks.
      const systemOptions = pickCreationPreferences(SYSTEM_CREATION_DEFAULTS);
      update(systemOptions, ["voiceId", "templateId"]);
      setForm((prev) => autofillSystemChoices({ ...prev, ...systemOptions }, lists, clearedRef.current));
      setDefaultsMessage({ ok: true, text: t("jobs.defaultsResetDone") });
    } catch (err) {
      setDefaultsMessage({ ok: false, text: err instanceof ApiError ? err.message : t("common.error") });
    } finally {
      setDefaultsBusy(false);
    }
  };

  const nextSteps = [
    t("jobs.nextStep1"),
    t("jobs.nextStep2"),
    t("jobs.nextStep3"),
    t("jobs.nextStep4"),
  ];

  const placeholder = (value: string) => (value ? null : <option value="" disabled>{t("jobs.selectPlaceholder")}</option>);

  return (
    <>
      <PageHeader title={t("jobs.create")} />
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {hydrated && contentAccounts.length === 0 ? (
        <Banner variant="warn">
          {t("jobs.needProvider")} <Link className="underline" to="/settings">{t("providers.title")}</Link>
        </Banner>
      ) : null}
      {restoredAt ? <Banner variant="info">{t("jobs.draftRestored", { time: formatTime(restoredAt) })}</Banner> : null}
      {cleared.length > 0 ? (
        <Banner variant="warn">{t("jobs.restoreInvalid", { fields: cleared.map((key) => t(FIELD_LABEL_KEYS[key] ?? key)).join(", ") })}</Banner>
      ) : null}
      {previewIndex !== null && previewTemplates[previewIndex] ? (
        <TemplatePreviewModal
          templates={previewTemplates}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          selectedId={form.templateId || null}
          onSelect={(tpl) => {
            update({ templateId: tpl.externalTemplateId });
            setPreviewIndex(null);
          }}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
      <ConfirmDialog
        open={discardOpen}
        title={t("jobs.draftDiscardTitle")}
        message={t("jobs.draftDiscardMessage")}
        details={[t("jobs.draftDiscardLosesContent"), t("jobs.draftDiscardLosesChoices")]}
        note={t("jobs.draftDiscardKeepsDefaults")}
        confirmLabel={t("jobs.draftDiscardConfirmButton")}
        busyLabel={t("jobs.draftDiscarding")}
        cancelLabel={t("common.cancel")}
        busy={discarding}
        onConfirm={() => void discardDraft()}
        onCancel={() => setDiscardOpen(false)}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <form
          className="flex flex-col gap-5 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-5"
          onSubmit={(event) => {
            event.preventDefault();
            const values = formRef.current;
            if (values.entryMode === "auto") {
              void (async () => {
                try {
                  setBusy(true);
                  setError(null);
                  const source: VideoProductionSourceInput =
                    values.autoSourceType === "raw_script" ? { type: "raw_script", rawScript: values.autoRawScript }
                    : values.autoSourceType === "article_url" ? { type: "article_url", url: values.autoArticleUrl }
                    : { type: "topic", topic: values.topic };
                  if (!values.templateId) throw new ApiError("VALIDATION_FAILED", t("jobs.autoTemplateRequired"));
                  const snapshot = await pinTemplateSnapshot(values.renderAccountId, values.templateId);
                  const setup = await setupAutoProfile({
                    name: (values.topic || values.autoArticleUrl || "Auto video").slice(0, 60),
                    contentAccountId: values.contentAccountId,
                    voiceAccountId: values.voiceAccountId,
                    voiceId: values.voiceId,
                    mediaAccountId: values.mediaAccountId,
                    renderAccountId: values.renderAccountId,
                    templateSnapshotId: snapshot.id,
                    ...(isOrshotRender ? { renderOptions: compactOrshotOptions({ ...(values.orshotFormat ? { format: values.orshotFormat } : {}), ...(values.orshotSize ? { size: values.orshotSize } : {}) }) } : {}),
                    locale: values.language,
                    durationSec: midpoint(values.durationTarget),
                    sceneCount: midpoint(values.sceneCountTarget),
                  });
                  const submitted = await submitVideoProduction(setup.projectId, setup.automationProfileId, source, toBackgroundSegmentsSetting(values.backgroundSegmentsChoice));
                  await closeDraft();
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
                    topic: values.topic,
                    locale: values.language,
                    mode: "topic",
                    channelId: values.channelId,
                    promptSpec: values.promptSpec,
                    contentProviderAccountId: values.contentAccountId,
                    existingScript: values.mode === "revise" ? values.existingScript : "",
                  }),
                });
                // The job exists from here on (even if the script generation below fails): the draft is done.
                await closeDraft();
                try {
                  const targetHint = TARGET_HINT_BY_LOCALE[values.language](values.durationTarget.replace(/s$/, ""), values.sceneCountTarget);
                  const direction = values.promptSpec.trim() ? `${values.promptSpec.slice(0, 450)} (${targetHint})` : targetHint;
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
            <button type="button" onClick={() => update({ entryMode: "auto" })} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${form.entryMode === "auto" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
              {t("jobs.autoModeLabel")}
            </button>
            <button type="button" onClick={() => update({ entryMode: "manual" })} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${form.entryMode === "manual" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
              {t("jobs.studioModeLabel")}
            </button>
          </div>

          {form.entryMode === "manual" ? (
            <div className="inline-flex w-fit gap-0.5 rounded-[8px] bg-lyx-muted p-1">
              <button type="button" onClick={() => update({ mode: "topic" })} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${form.mode === "topic" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
                {t("jobs.topicMode")}
              </button>
              <button type="button" onClick={() => update({ mode: "revise" })} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${form.mode === "revise" ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
                {t("jobs.reviseMode")}
              </button>
            </div>
          ) : (
            <div className="inline-flex w-fit gap-0.5 rounded-[8px] bg-lyx-muted p-1">
              {AUTO_SOURCE_TYPES.map((type) => (
                <button key={type} type="button" onClick={() => update({ autoSourceType: type })} className={`rounded-[6px] px-4 py-1.5 text-[12.5px] font-semibold ${form.autoSourceType === type ? "bg-lyx-bg text-lyx-fg shadow-sm" : "text-lyx-fg-muted"}`}>
                  {t(`jobs.autoSource.${type}`)}
                </button>
              ))}
            </div>
          )}

          <div>
            <p className="mb-2.5 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("jobs.basicsSection")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("jobs.channel")}>
                <Select value={form.channelId} onChange={(e) => update({ channelId: e.target.value })} required>
                  {placeholder(form.channelId)}
                  {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
                </Select>
              </Field>
              <Field label={t("jobs.language")}>
                <Select value={form.language} onChange={(e) => update({ language: e.target.value as UiLocale })}>
                  <option value="vi">VI</option><option value="en">EN</option><option value="ja">JA</option><option value="ko">KO</option>
                </Select>
              </Field>
            </div>
          </div>

          {form.entryMode === "manual" ? (
            <>
              <Field label={t("jobs.topic")} {...(error ? { error } : {})}>
                <TextArea value={form.topic} onChange={(e) => update({ topic: e.target.value })} required />
              </Field>
              <Field label={t("jobs.prompt")} hint={t("jobs.promptHint")}>
                <TextArea value={form.promptSpec} onChange={(e) => update({ promptSpec: e.target.value })} />
              </Field>
              {form.mode === "revise" ? (
                <Field label={t("jobs.existingScript")} hint={t("jobs.existingScriptHint")}>
                  <TextArea value={form.existingScript} onChange={(e) => update({ existingScript: e.target.value })} required />
                </Field>
              ) : null}
            </>
          ) : (
            <>
              {form.autoSourceType === "topic" ? (
                <Field label={t("jobs.topic")} {...(error ? { error } : {})}>
                  <TextArea value={form.topic} onChange={(e) => update({ topic: e.target.value })} required />
                </Field>
              ) : form.autoSourceType === "raw_script" ? (
                <Field label={t("jobs.existingScript")} {...(error ? { error } : {})}>
                  <TextArea value={form.autoRawScript} onChange={(e) => update({ autoRawScript: e.target.value })} required />
                </Field>
              ) : (
                <Field label={t("jobs.autoSource.article_url")} {...(error ? { error } : {})}>
                  <TextArea value={form.autoArticleUrl} onChange={(e) => update({ autoArticleUrl: e.target.value })} required />
                </Field>
              )}
            </>
          )}

          <div className="border-t border-lyx-border pt-4">
            <Field label={t("jobs.contentAccount")}>
              <Select value={form.contentAccountId} onChange={(e) => update({ contentAccountId: e.target.value })} required>
                {placeholder(form.contentAccountId)}
                {contentAccounts.map((item) => (
                  <option key={item.id} value={item.id}>{item.name} · {item.provider} · {item.model}{item.status !== "verified" ? " · ?" : ""}</option>
                ))}
              </Select>
            </Field>
          </div>

          {form.entryMode === "auto" ? (
            <div className="flex flex-col gap-3 border-t border-lyx-border pt-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("jobs.autoPreflightTitle")}</p>
              <ul className="flex flex-col gap-1.5">
                {preflight.map((row) => (
                  <li key={row.key} className="flex items-center justify-between text-[12.5px]">
                    <span className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${row.ok ? "bg-lyx-ok" : "bg-lyx-danger"}`} />
                      {t(`jobs.autoPreflight.${row.key}`)}
                    </span>
                    {!row.ok && row.key !== "template" ? <Link className="text-[11.5px] underline" to="/settings">{t("providers.title")}</Link> : null}
                  </li>
                ))}
              </ul>
              {voiceAccounts.length > 1 || (voiceAccounts.length > 0 && !form.voiceAccountId) ? (
                <Field label={t("jobs.autoVoiceAccount")}>
                  <Select value={form.voiceAccountId} onChange={(e) => update({ voiceAccountId: e.target.value }, ["voiceId"])}>
                    {placeholder(form.voiceAccountId)}
                    {voiceAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                  </Select>
                </Field>
              ) : null}
              {voiceAccounts.length > 0 ? (
                <Field label={t("jobs.autoVoice")}>
                  <Select value={form.voiceId} onChange={(e) => update({ voiceId: e.target.value })}>
                    {placeholder(form.voiceId)}
                    {voices.map((voice) => <option key={voice.voiceId} value={voice.voiceId}>{voice.name}</option>)}
                  </Select>
                </Field>
              ) : null}
              {mediaAccounts.length > 1 || (mediaAccounts.length > 0 && !form.mediaAccountId) ? (
                <Field label={t("jobs.autoMediaAccount")}>
                  <Select value={form.mediaAccountId} onChange={(e) => update({ mediaAccountId: e.target.value })}>
                    {placeholder(form.mediaAccountId)}
                    {mediaAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                  </Select>
                </Field>
              ) : null}
              <>
                <Field label={t("jobs.autoRenderAccount")}>
                  <Select value={form.renderAccountId} onChange={(e) => update({ renderAccountId: e.target.value }, ["templateId"])}>
                    {placeholder(form.renderAccountId)}
                    {renderAccountChoices.map((account) => (
                      <option key={account.id} value={account.id} disabled={!renderAccounts.some((usable) => usable.id === account.id)}>
                        {renderAccountOptionLabel(account)}{account.status !== "verified" && !account.isFake ? ` · ${t(`providers.${account.status}`)}` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                {!renderAccounts.some((account) => account.provider === "orshot") ? (
                  <Link className="text-[12px] underline" to="/settings?tab=providers">{t("jobs.autoAddOrshot")}</Link>
                ) : null}
              </>
              {isOrshotRender ? (
                <div className="flex flex-col gap-2 rounded-[var(--lyx-radius)] border border-lyx-border p-3">
                  <p className="text-[12px] text-lyx-fg-muted">{t("jobs.autoOrshotHint")}</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t("jobs.autoOrshotFormat")}>
                      <Select value={form.orshotFormat} onChange={(e) => update({ orshotFormat: e.target.value as JobNewFormValues["orshotFormat"] })}>
                        <option value="">mp4</option>
                        {ORSHOT_FORMATS.filter((format) => format !== "mp4").map((format) => <option key={format} value={format}>{format}</option>)}
                      </Select>
                    </Field>
                    <Field label={t("jobs.autoOrshotSize")}>
                      <Select value={form.orshotSize} onChange={(e) => update({ orshotSize: e.target.value })}>
                        <option value="">{t("studioPro.orshotSizeTemplate")}</option>
                        {ORSHOT_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <p className="text-[12px]">{t("jobs.autoOrshotEstimate", { credits: midpoint(form.durationTarget), seconds: midpoint(form.durationTarget) })}</p>
                </div>
              ) : null}
              {renderAccounts.length > 0 ? (
                <Field label={t("jobs.autoTemplate")} {...(renderTemplates.length === 0 ? { hint: t("jobs.autoNoTemplate") } : {})}>
                  {/* VE2E-13: real template preview images at Auto intake. V04-XX: the picture opens the 9:16 preview (it no
                      longer selects); only "Chọn" / "Chọn template này" applies a template. */}
                  <div className="-mx-1 flex snap-x gap-2.5 overflow-x-auto px-1 pb-2" data-testid="template-strip">
                    {previewTemplates.map((tpl, index) => {
                      const chosen = form.templateId === tpl.externalTemplateId;
                      return (
                        <div key={tpl.externalTemplateId} className="w-[92px] shrink-0 snap-start" data-testid="template-card">
                          <div className={`relative overflow-hidden rounded-[8px] transition ${chosen ? "ring-2 ring-lyx-fg ring-offset-2 ring-offset-lyx-bg" : "ring-1 ring-lyx-border hover:ring-lyx-strong"}`}>
                            <button type="button" onClick={() => setPreviewIndex(index)} title={t("templates.previewOpen")} className="block w-full">
                              <div className="flex items-center justify-center overflow-hidden bg-lyx-muted text-[9px] text-lyx-fg-subtle" style={{ aspectRatio: "9 / 16" }}>
                                <TemplateThumb template={tpl} fallbackLabel={t("templates.preview")} />
                              </div>
                            </button>
                            <TemplatePreviewButton iconOnly onClick={() => setPreviewIndex(index)} label={t("templates.previewOpen")} className="absolute bottom-1.5 right-1.5" />
                            {chosen ? <span className="absolute left-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-lyx-fg text-lyx-bg" aria-hidden="true"><Check size={12} /></span> : null}
                          </div>
                          <div className="mt-1.5 truncate text-[11px] font-medium" title={tpl.name}>{tpl.name}</div>
                          <button
                            type="button"
                            onClick={() => update({ templateId: tpl.externalTemplateId })}
                            disabled={chosen}
                            className={`mt-1 w-full rounded-[6px] border py-1 text-[11px] font-semibold transition ${chosen ? "border-lyx-fg bg-lyx-fg text-lyx-bg" : "border-lyx-border hover:border-lyx-strong"}`}
                          >
                            {chosen ? t("templates.current") : t("templates.choose")}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </Field>
              ) : null}
            </div>
          ) : null}

          {/* VE2E-124: the user's own draft - saved here only, no job/workflow, no AI/TTS/render call, no cost. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-lyx-border pt-4 text-[12px]" data-testid="draft-bar">
            <Button type="button" variant="secondary" disabled={!hydrated || busy} onClick={saveDraftNow}>{t("jobs.draftSave")}</Button>
            <span role="status" className="text-lyx-fg-muted">
              {draftStatus.kind === "saving" ? t("jobs.draftSaving")
                : draftStatus.kind === "saved" ? t("jobs.draftSavedAt", { time: formatTime(draftStatus.at) })
                : draftStatus.kind === "pending" ? t("jobs.draftPending")
                : null}
            </span>
            {draftStatus.kind === "error" ? (
              <span role="alert" className="flex items-center gap-2 text-lyx-danger">
                {t("jobs.draftSaveFailed")}
                <Button type="button" variant="ghost" onClick={() => void autosaver.retry()}>{t("jobs.draftRetry")}</Button>
              </span>
            ) : null}
            {draftStatus.kind === "conflict" ? (
              <span role="alert" className="flex items-center gap-2 text-amber-500">
                {t("jobs.draftConflict")}
                <Button type="button" variant="ghost" onClick={() => void overwriteDraft()}>{t("jobs.draftOverwrite")}</Button>
              </span>
            ) : null}
            <Button type="button" variant="ghost" className="ml-auto" disabled={!hydrated || busy} onClick={() => setDiscardOpen(true)}>{t("jobs.draftDiscard")}</Button>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-lyx-border pt-4">
            <p className="text-[11.5px] text-lyx-fg-muted">{form.entryMode === "auto" ? t("jobs.autoSubmitHint") : t("jobs.submitHint")}</p>
            <Button type="submit" disabled={!hydrated || busy || !form.contentAccountId || (form.entryMode === "auto" && !preflightReady)}>
              {busy ? generatingLabel : form.entryMode === "auto" ? t("jobs.autoSubmit") : t("jobs.submit")}
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
                <dd className="font-medium uppercase">{form.language}</dd>
              </div>
              <div className="flex items-center justify-between py-2 text-[12.5px]">
                <dt className="text-lyx-fg-muted">{t("jobs.durationTarget")}</dt>
                <dd>
                  <Select className="h-8 text-[12px]" value={form.durationTarget} onChange={(e) => update({ durationTarget: e.target.value as JobNewFormValues["durationTarget"] })}>
                    {DURATION_TARGETS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </Select>
                </dd>
              </div>
              <div className="flex items-center justify-between border-t border-lyx-neutral-bg py-2 text-[12.5px]">
                <dt className="text-lyx-fg-muted">{t("jobs.sceneCountTarget")}</dt>
                <dd>
                  <Select className="h-8 text-[12px]" value={form.sceneCountTarget} onChange={(e) => update({ sceneCountTarget: e.target.value as JobNewFormValues["sceneCountTarget"] })}>
                    {SCENE_COUNT_TARGETS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </Select>
                </dd>
              </div>
              {form.entryMode === "auto" ? (
                <div className="flex flex-col gap-1 border-t border-lyx-neutral-bg py-2 text-[12.5px]">
                  <div className="flex items-center justify-between">
                    <dt className="text-lyx-fg-muted">
                      <label htmlFor="background-segments">{t("jobs.backgroundSegments")}</label>
                    </dt>
                    <dd>
                      <Select id="background-segments" className="h-8 text-[12px]" value={form.backgroundSegmentsChoice} onChange={(e) => update({ backgroundSegmentsChoice: e.target.value })}>
                        {BACKGROUND_SEGMENT_CHOICES.map((value) => (
                          <option key={value} value={value}>
                            {value === "auto"
                              ? t("jobs.backgroundSegmentsAuto", { min: autoSegmentRange?.min ?? "?", max: autoSegmentRange?.max ?? "?" })
                              : t("jobs.backgroundSegmentsFixed", { count: Number(value) })}
                          </option>
                        ))}
                      </Select>
                    </dd>
                  </div>
                  <p className="text-[11px] text-lyx-fg-subtle">{t("jobs.backgroundSegmentsHint")}</p>
                </div>
              ) : null}
            </dl>
          </div>

          {/* VE2E-124: the user's own creation defaults (options only, stored per user on the server). */}
          <div className="rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-4" data-testid="defaults-box">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("jobs.defaultsTitle")}</p>
            <p className="mb-3 text-[11.5px] text-lyx-fg-muted">{t("jobs.defaultsHint")}</p>
            <div className="flex flex-col gap-2">
              <Button type="button" variant="secondary" disabled={!hydrated || defaultsBusy} onClick={() => void saveDefaults()}>{t("jobs.defaultsSave")}</Button>
              <Button type="button" variant="ghost" disabled={!hydrated || defaultsBusy} onClick={() => void resetDefaults()}>{t("jobs.defaultsReset")}</Button>
            </div>
            {defaultsMessage ? (
              <p role={defaultsMessage.ok ? "status" : "alert"} className={`mt-2 text-[12px] ${defaultsMessage.ok ? "text-lyx-ok" : "text-lyx-danger"}`}>{defaultsMessage.text}</p>
            ) : null}
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
