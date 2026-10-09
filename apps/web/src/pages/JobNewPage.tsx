import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../components/feedback";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Banner, PageHeader } from "../components/chrome";
import { BookmarkCheck, Bot, Captions, Clapperboard, FileText, Film, Languages, LayoutTemplate, Lightbulb, Link2, ListChecks, Mic, Palette, PenLine, Rocket, SlidersHorizontal, Sparkles, Timer, Tv } from "lucide-react";
import { Button, Field, Select, TextArea, TextInput } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TemplatePreviewModal } from "../components/TemplatePreviewModal";
import { TemplatePicker } from "../components/TemplatePicker";
import { Modal } from "../components/Modal";
import { SegmentedTabs } from "../components/motion";
import { mergeTemplateEntries, type TemplateEntry } from "../studio/template-gallery";
import {
  CATEGORY_FILTERS,
  accountForTemplate,
  categoryCounts,
  filterByCategory,
  templateRecipeId,
  templateSelectionState,
  toLibraryTemplates,
  uniqueTemplates,
  type CategoryFilter,
} from "../studio/template-catalog";
import type { PreviewableTemplate } from "../studio/template-preview";
import { captionPresetById, captionPresetOptionValues, captionPresetSupport } from "@lyonix/domain/caption-presets";
import { captionDefaultsFromRecipeCaptions } from "@lyonix/domain/caption-style";
import { recipeRegistry } from "@lyonix/render-recipes";
import { CaptionPresetPicker } from "../components/CaptionPresetPicker";
import { CAPTION_REASON_KEY } from "../studio/text-style/CaptionPresetViews";
import { studioCaptionEngine } from "../studio/text-style/caption-style-model";
import { api, ApiError, csrfHeaders } from "../api";
import type { ApiJob, ApiProvider } from "../jobs-api";
import type { PublicChannel } from "../channel-api";
import type { BackgroundSegmentsSetting, CreationPreferenceOptions, ElevenLabsVoiceSummaryResponse, NewsItemResponse, UiLocale, UrlIntakeRewrite, UrlIntakeSource, UrlIntakeStage, VideoProductionSourceInput } from "@lyonix/contracts";
// Browser-safe subpaths (the bare `@lyonix/domain` barrel pulls in node:crypto - see its index.ts).
import { resolveBackgroundSegmentRange } from "@lyonix/domain/background-segments";
import { parseSelectedNews } from "@lyonix/domain/news";
import { classifyIntakeUrl } from "@lyonix/domain/url-intake";
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
import { DraftSaveControl } from "../job-new/DraftSaveControl";
import { FIELD_LABEL_KEYS, autofillSystemChoices, buildInitialFormState, creationLists, mediaAccountsOf, usableAccounts, type CreationLists } from "../job-new/form-state";
import { SelectedNewsCard } from "../job-new/SelectedNewsCard";
import { newsPick, newsUnpick } from "../job-new/news-pick";
import { NewsDrawer } from "../news/NewsDrawer";
import { ContentSourceBar } from "../job-new/ContentSourceBar";
import { VoicePicker } from "../job-new/VoicePicker";
import { renderVoiceConfig } from "../job-new/voice-picker";
import { AccentCard, AdvancedSection, ChoiceField, FormSection, LabelIcon, ProgressStrip, ReadyItem, SummaryRow } from "../job-new/CreateVideoParts";
import { analyzeIntakeUrlStream, rewriteIntakeSource } from "../job-new/intake-api";
import { SPOKEN_STAGES, intakeApply, type IntakeApplied, type IntakeState, type IntakeTarget } from "../job-new/url-intake";

const toBackgroundSegmentsSetting = (choice: string): BackgroundSegmentsSetting => (choice === "auto" ? { mode: "auto" } : { mode: "fixed", count: Number(choice) });

/** Auto mode has no manual review step (D10) - it needs one concrete number, not a range. */
const midpoint = (range: string) => {
  const [lo, hi] = range.replace(/s$/, "").split("-").map(Number);
  return Math.round(((lo ?? 0) + (hi ?? lo ?? 0)) / 2);
};

const formatTime = (date: Date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The main form's id: the content fields (card 1) and the summary's submit button live outside the <form> element. */
const FORM_ID = "job-new-form";
const SCRIPT_LANGUAGES = ["vi", "en", "ja", "ko"] as const satisfies readonly UiLocale[];
const SOURCE_ICON: Record<(typeof AUTO_SOURCE_TYPES)[number], React.ReactNode> = {
  topic: <Lightbulb size={14} aria-hidden />,
  raw_script: <FileText size={14} aria-hidden />,
  article_url: <Link2 size={14} aria-hidden />,
};

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
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [channels, setChannels] = useState<PublicChannel[]>([]);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voices, setVoices] = useState<ElevenLabsVoiceSummaryResponse[]>([]);
  const [voicesState, setVoicesState] = useState<"loading" | "ready" | "failed">("ready");
  // V04-01: the template library = the templates of EVERY usable render account (LyOnix built-ins + Creatomate + Orshot).
  const [libraryEntries, setLibraryEntries] = useState<TemplateEntry[]>([]);
  const [libraryFailed, setLibraryFailed] = useState<string[]>([]);
  /** Group filter of the library - display only, never saved, never changes the selection. */
  const [category, setCategory] = useState<CategoryFilter>("all");
  /** "Chọn template này" on a template several accounts list, without a current / default one among them: the user picks the account. */
  const [accountChoice, setAccountChoice] = useState<{ template: PreviewableTemplate; accountIds: string[] } | null>(null);

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
  // VE2E-96: "Nguồn nội dung" - the news drawer (opened by a search) and the result of the last analysed URL.
  const [newsDrawer, setNewsDrawer] = useState<{ query: string } | null>(null);
  const [intake, setIntake] = useState<IntakeState>({ kind: "idle" });
  const intakeAppliedRef = useRef<IntakeApplied>({});
  const autosaver = useMemo(
    () => new DraftAutosaver<JobNewFormValues>({ save: saveJobNewDraft, onStatus: setDraftStatus, isConflict: (err) => err instanceof ApiError && err.code === "VERSION_CONFLICT" }),
    [],
  );

  const contentAccounts = usableAccounts(providers, "content");
  const voiceAccounts = usableAccounts(providers, "tts");
  const mediaAccounts = mediaAccountsOf(providers);
  const renderAccountChoices = providers.filter((item) => item.role === "render");
  const renderAccounts = usableAccounts(providers, "render");
  const lists: CreationLists = creationLists(channels, providers);
  const renderProvider = renderAccounts.find((account) => account.id === form.renderAccountId)?.provider;
  const isOrshotRender = isTemplateOnlyRenderProvider(renderProvider);
  const library = useMemo(() => toLibraryTemplates(libraryEntries), [libraryEntries]);
  const counts = useMemo(() => categoryCounts(uniqueTemplates(library)), [library]);
  // V04-XX / V04-01: the cards (one per template) and the preview browse the filtered list; previewing never selects.
  const previewTemplates = useMemo(() => uniqueTemplates(library), [library]);
  // V04-01: the chosen template against the chosen render account - Auto is blocked unless it is compatible AND ready to render.
  const templateState = templateSelectionState(library, form.templateId, form.renderAccountId);
  // VE2E-94: the caption preset against the engine of the chosen template + render account (Orshot draws no caption style).
  const captionTemplate = templateState.kind === "none" || templateState.kind === "missing" ? null : templateState.template;
  const captionEngine = studioCaptionEngine(captionTemplate, renderProvider);
  const captionRecipe = captionTemplate ? recipeRegistry.latest(templateRecipeId(captionTemplate) ?? "") : null;
  const captionDefaults = captionRecipe ? captionDefaultsFromRecipeCaptions(captionRecipe.captions) : null;
  const captionPreset = captionPresetById(form.captionPresetId);
  const captionPresetCheck = captionPreset && captionEngine ? captionPresetSupport(captionEngine, captionPreset) : ({ ok: true } as const);
  const renderAccountKey = renderAccounts.map((account) => account.id).join(",");
  // Auto resolves against the same target duration the Auto profile is created with (midpoint of the range).
  const autoSegmentRange = resolveBackgroundSegmentRange({ mode: "auto" }, midpoint(form.durationTarget));
  const preflight = [
    { key: "content", ok: contentAccounts.length > 0 },
    { key: "voice", ok: Boolean(form.voiceAccountId) && Boolean(form.voiceId) },
    { key: "media", ok: Boolean(form.mediaAccountId) },
    { key: "render", ok: Boolean(form.renderAccountId) },
    { key: "template", ok: templateState.kind === "ok" },
  ] as const;
  const preflightReady = preflight.every((row) => row.ok);
  const selected = contentAccounts.find((item) => item.id === form.contentAccountId);
  const selectedVoice = voices.find((voice) => voice.voiceId === form.voiceId);
  // Card status chips ("Bước N" -> "Xong"): display only, they never block anything themselves.
  const contentDone = form.entryMode === "manual"
    ? Boolean(form.topic.trim()) && (form.mode !== "revise" || Boolean(form.existingScript.trim()))
    : form.autoSourceType === "topic" ? Boolean(form.topic.trim()) : form.autoSourceType === "raw_script" ? Boolean(form.autoRawScript.trim()) : Boolean(form.autoArticleUrl.trim());
  const videoDone = Boolean(form.channelId);
  const styleDone = templateState.kind === "ok" && Boolean(form.voiceId) && captionPresetCheck.ok;
  const canSubmit = Boolean(form.contentAccountId) && (form.entryMode !== "auto" || preflightReady);
  const progressSteps = [
    { name: t("jobs.section.content.title"), accent: "blue" as const, done: contentDone },
    { name: t("jobs.section.video.title"), accent: "green" as const, done: videoDone },
    ...(form.entryMode === "auto" ? [{ name: t("jobs.section.style.title"), accent: "violet" as const, done: styleDone }] : []),
  ];
  /** What still blocks the create button (shown on the phone action bar). */
  const missingCount = form.entryMode === "auto" ? preflight.filter((row) => !row.ok).length : form.contentAccountId ? 0 : 1;
  // "Nâng cao" stays open while a required account there can be picked but is not: a required field is never hidden.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedNeeded = hydrated && (
    (!form.contentAccountId && contentAccounts.length > 0)
    || (form.entryMode === "auto" && ((!form.voiceAccountId && voiceAccounts.length > 0) || (!form.mediaAccountId && mediaAccounts.length > 0) || (!form.renderAccountId && renderAccounts.length > 0)))
  );
  const selectedChannel = channels.find((item) => item.id === form.channelId);
  // VE2E-96: the news item the topic came from (stored with the draft, like the topic itself).
  const selectedNews = useMemo(() => parseSelectedNews(form.selectedNews), [form.selectedNews]);
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
    if (!accountId) { setVoices([]); setVoicesState("ready"); return; }
    let cancelled = false;
    setVoicesState("loading");
    void listElevenLabsVoices(accountId).then((rows) => {
      if (cancelled) return;
      setVoices(rows);
      setVoicesState("ready");
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
    }).catch(() => { if (!cancelled) { setVoices([]); setVoicesState("failed"); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.voiceAccountId]);

  /**
   * VE2E-23: the render template used to be auto-picked (`templates[0]`, whichever the
   * Creatomate account happened to return first) with no compatibility check — every
   * template pinned so far requires at least one "image" modification slot that Auto's
   * scene media (Pexels, almost always video) can never fill, so every Auto run failed
   * the same way at the last step. Owner decision (chat, 26/09): let the operator pick
   * the template explicitly instead of guessing. V04-01: the library lists the templates of
   * every usable render account (listing costs nothing); choosing one also picks its account.
   * Changing the render account afterwards KEEPS the template: an incompatible pair is shown
   * as such and blocks Auto (see `templateState`) instead of being silently cleared.
   * VE2E-124: a restored template that exists nowhere any more is cleared and reported - only
   * once every list loaded, a failed list never clears a choice.
   */
  useEffect(() => {
    if (!hydrated) return;
    const accounts = renderAccounts;
    if (accounts.length === 0) { setLibraryEntries([]); setLibraryFailed([]); return; }
    let cancelled = false;
    void Promise.allSettled(accounts.map((account) => listCreatomateTemplates(account.id))).then((results) => {
      if (cancelled) return;
      const entries = mergeTemplateEntries(accounts, results.map((result) => (result.status === "fulfilled" ? result.value : [])));
      setLibraryEntries(entries);
      setLibraryFailed(accounts.filter((_, index) => results[index]!.status === "rejected").map((account) => account.name));
      const current = formRef.current.templateId;
      if (!current || entries.some((entry) => entry.template.externalTemplateId === current) || results.some((result) => result.status === "rejected")) return;
      if (restoredRef.current.has("templateId")) {
        restoredRef.current.delete("templateId");
        markCleared(["templateId"]);
      }
      fill({ templateId: "" });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, renderAccountKey]);

  /**
   * V04-01: "Chọn template này" - the only way the library applies a template. It also picks the template's render account: the
   * only one listing it, else the one already selected, else the user's default render account, else the user is asked. Never a
   * silent switch to another (possibly paid) account: the card the user chose names its provider.
   */
  const chooseTemplate = (template: PreviewableTemplate, accountId?: string) => {
    const choice = accountId ? { kind: "one" as const, accountId } : accountForTemplate(library, template.externalTemplateId, { currentAccountId: form.renderAccountId, defaultAccountId: preferencesRef.current?.renderAccountId ?? null });
    setPreviewIndex(null);
    if (choice.kind === "ask") {
      setAccountChoice({ template, accountIds: choice.accountIds });
      return;
    }
    setAccountChoice(null);
    if (choice.kind === "none") return;
    update(choice.accountId === form.renderAccountId ? { templateId: template.externalTemplateId } : { templateId: template.externalTemplateId, renderAccountId: choice.accountId });
  };

  /** VE2E-96: "Dùng tin này" (see `newsPick`) closes the news drawer; a topic the user typed is only replaced once they confirm. */
  const pickNewsItem = async (item: NewsItemResponse) => {
    const pick = newsPick(formRef.current, item);
    if (pick.kind === "apply") {
      if (pick.needsConfirm && !(await confirm({ title: t("news.replaceTitle"), message: t("news.replaceMessage"), confirmLabel: t("news.replaceConfirm"), tone: "warn" }))) return;
      update(pick.patch);
    }
    setNewsDrawer(null);
  };

  /** VE2E-96: the rewrite of an analysed source, with the form's content account / language / length. Never touches the form. */
  const rewriteIntake = async (source: UrlIntakeSource) => {
    const values = formRef.current;
    setIntake((prev) => (prev.kind === "ready" && prev.source === source ? { ...prev, rewrite: { status: "pending" } } : prev));
    let rewrite: UrlIntakeRewrite;
    try {
      rewrite = await rewriteIntakeSource({ source, ...(values.contentAccountId ? { contentAccountId: values.contentAccountId } : {}), language: values.language, durationSec: midpoint(values.durationTarget) });
    } catch (err) {
      rewrite = { status: "failed", code: err instanceof ApiError ? err.code : "PROVIDER_UNAVAILABLE", message: err instanceof ApiError ? err.message : t("common.error") };
    }
    setIntake((prev) => (prev.kind === "ready" && prev.source === source ? { ...prev, rewrite } : prev));
  };

  /** VE2E-96: "Phân tích" - reads the URL (TikTok transcript / article), shows it, then writes the script. The form is not changed here. */
  const analyzeUrl = async (url: string) => {
    const classified = classifyIntakeUrl(url);
    const sourceType = classified.ok && classified.kind === "tiktok" ? "tiktok" as const : "article" as const;
    let stage: UrlIntakeStage = "reading";
    // once a "no subtitle" stage arrives the progress line follows the speech-to-text path, also for a later "cleaning" or an error
    let spoken = false;
    setIntake({ kind: "loading", stage, sourceType });
    try {
      const values = formRef.current;
      // the form's media (Apify) / voice (ElevenLabs) accounts are tried first for a TikTok transcript; the server streams its stages
      const result = await analyzeIntakeUrlStream(
        { url, language: values.language, ...(values.mediaAccountId ? { mediaAccountId: values.mediaAccountId } : {}), ...(values.voiceAccountId ? { voiceAccountId: values.voiceAccountId } : {}) },
        (next) => {
          stage = next;
          spoken = spoken || SPOKEN_STAGES.has(next);
          setIntake({ kind: "loading", stage: next, sourceType, spoken });
        },
      );
      if (!result.ok) {
        setIntake({ kind: "error", code: result.error.code, message: result.error.message, stage, sourceType: result.sourceType ?? sourceType, spoken });
        return;
      }
      setIntake({ kind: "ready", source: result.source, rewrite: { status: "pending" }, applied: null });
      await rewriteIntake(result.source);
    } catch (err) {
      setIntake({ kind: "error", code: err instanceof ApiError && err.code === "VALIDATION_FAILED" ? "invalid_url" : "request_failed", message: err instanceof ApiError ? err.message : t("common.error") });
    }
  };

  /** VE2E-96: "Đưa vào chủ đề" / "Đưa vào kịch bản" (see `intakeApply`); text the user typed there is only replaced once they confirm. */
  const applyIntake = async (target: IntakeTarget) => {
    if (intake.kind !== "ready") return;
    const outcome = intakeApply(formRef.current, intake.source, intake.rewrite, target, intakeAppliedRef.current);
    if (!outcome) return;
    if (outcome.needsConfirm && !(await confirm({ title: t("intake.replaceTitle"), message: t(target === "topic" ? "intake.replaceTopic" : "intake.replaceScript"), confirmLabel: t("intake.replaceConfirm"), tone: "warn" }))) return;
    update(outcome.patch);
    intakeAppliedRef.current = { ...intakeAppliedRef.current, [target]: outcome.written };
    setIntake((prev) => (prev.kind === "ready" ? { ...prev, applied: target } : prev));
  };

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
    if (!(await confirm({ title: t("jobs.defaultsResetConfirm"), message: t("jobs.defaultsResetConfirm"), tone: "warn" }))) return;
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

  /** Brings a field into view (no smooth scroll under reduced motion) and focuses its first control. */
  const focusField = (testId: string) => {
    const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    target.querySelector<HTMLElement>("select, button, input")?.focus({ preventScroll: true });
  };
  /** What a missing "Kiểm tra trước khi chạy" line offers: pick it on this page when possible, else add the account in Settings. */
  const preflightAction = (key: (typeof preflight)[number]["key"]) => {
    const choose = (testId: string, openAdvanced = false) => (
      <button type="button" className="shrink-0 text-[11.5px] font-medium underline" onClick={() => { if (openAdvanced) setAdvancedOpen(true); window.setTimeout(() => focusField(testId), 0); }}>{t("jobs.choose")}</button>
    );
    const settings = <Link className="shrink-0 text-[11.5px] underline" to="/settings?tab=providers">{t("providers.title")}</Link>;
    if (key === "template") return renderAccounts.length > 0 ? choose("template-field") : settings;
    if (key === "voice") return voiceAccounts.length === 0 ? settings : form.voiceAccountId ? choose("voice-field") : choose("advanced-settings", true);
    const usable = key === "content" ? contentAccounts : key === "media" ? mediaAccounts : renderAccounts;
    return usable.length > 0 ? choose("advanced-settings", true) : settings;
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
      <PageHeader
        title={t("jobs.create")}
        breadcrumb={<span key={form.entryMode} className="lyx-fade inline-block">{form.entryMode === "auto" ? t("jobs.autoSubmitHint") : t("jobs.submitHint")}</span>}
        actions={
          <SegmentedTabs
            ariaLabel={t("jobs.mode")}
            testId="entry-mode"
            value={form.entryMode}
            onChange={(entryMode) => update({ entryMode })}
            options={[
              { id: "auto", label: t("jobs.autoModeLabel"), icon: <Sparkles size={14} className="text-[var(--lyx-accent-violet)]" aria-hidden /> },
              { id: "manual", label: t("jobs.studioModeLabel"), icon: <PenLine size={14} className="text-[var(--lyx-accent-blue)]" aria-hidden /> },
            ]}
          />
        }
      />
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
          selectedId={templateState.kind === "ok" || templateState.kind === "not_ready" ? form.templateId : null}
          onSelect={(tpl) => chooseTemplate(tpl)}
          onClose={() => setPreviewIndex(null)}
        />
      ) : null}
      {accountChoice ? (
        <Modal title={t("templates.library.chooseAccountTitle")} onClose={() => setAccountChoice(null)}>
          <p className="mb-3 text-[12.5px] text-lyx-fg-muted">{t("templates.library.chooseAccountHint")}</p>
          <div className="flex flex-col gap-2" data-testid="template-account-choice">
            {accountChoice.accountIds.map((accountId) => {
              const account = renderAccounts.find((item) => item.id === accountId);
              return (
                <Button key={accountId} type="button" variant="secondary" onClick={() => chooseTemplate(accountChoice.template, accountId)}>
                  {account ? renderAccountOptionLabel(account) : accountId}
                </Button>
              );
            })}
            <Button type="button" variant="ghost" onClick={() => setAccountChoice(null)}>{t("common.cancel")}</Button>
          </div>
        </Modal>
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

      {/* Create-video layout: numbered cards on the left (1 Nội dung, 2 Video, 3 Phong cách, then the collapsed technical settings),
          a sticky summary with the submit button on the right. Only the presentation changed: submit / draft / defaults are untouched. */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-5">
          {/* 1 - what the video is about. It sits outside the <form> because the URL / news search are forms of their own;
              its text fields join the main form through `form={FORM_ID}` (validation + submit). */}
          <FormSection step={1} accent="blue" icon={<Lightbulb size={18} aria-hidden />} complete={contentDone} stepLabel={t("jobs.stepLabel", { n: 1 })} doneLabel={t("jobs.sectionDone")} title={t("jobs.section.content.title")} subtitle={t("jobs.section.content.subtitle")} testId="section-content">
            {form.entryMode === "manual" ? (
              <SegmentedTabs
                key="manual-mode"
                value={form.mode}
                onChange={(mode) => update({ mode })}
                options={[
                  { id: "topic", label: t("jobs.topicMode"), icon: <Lightbulb size={14} aria-hidden /> },
                  { id: "revise", label: t("jobs.reviseMode"), icon: <PenLine size={14} aria-hidden /> },
                ]}
              />
            ) : (
              <SegmentedTabs
                key="auto-source"
                value={form.autoSourceType}
                onChange={(autoSourceType) => update({ autoSourceType })}
                options={AUTO_SOURCE_TYPES.map((type) => ({ id: type, label: t(`jobs.autoSource.${type}`), icon: SOURCE_ICON[type] }))}
              />
            )}

            {/* VE2E-96: a URL to analyse or a news search - the result is applied to the fields below only through its buttons. */}
            <ContentSourceBar
              embedded
              state={intake}
              onAnalyze={(url) => void analyzeUrl(url)}
              onSearchNews={(query) => setNewsDrawer({ query })}
              onApply={(target) => void applyIntake(target)}
              onRetryRewrite={() => { if (intake.kind === "ready") void rewriteIntake(intake.source); }}
            />

            {/* VE2E-96: the news item the topic was made from (picked in the news drawer or from a pasted URL). */}
            {selectedNews ? <SelectedNewsCard item={selectedNews} onClear={() => update(newsUnpick(formRef.current))} /> : null}

            {form.entryMode === "manual" ? (
              <>
                <Field label={t("jobs.topic")} {...(error ? { error } : {})}>
                  <TextArea form={FORM_ID} className="min-h-24" placeholder={t("jobs.placeholder.topic")} value={form.topic} onChange={(e) => update({ topic: e.target.value })} required />
                </Field>
                {form.mode === "revise" ? (
                  <Field label={t("jobs.existingScript")} hint={t("jobs.existingScriptHint")}>
                    <TextArea form={FORM_ID} className="min-h-32" placeholder={t("jobs.placeholder.script")} value={form.existingScript} onChange={(e) => update({ existingScript: e.target.value })} required />
                  </Field>
                ) : null}
                <Field label={t("jobs.prompt")} hint={t("jobs.promptHint")}>
                  <TextArea form={FORM_ID} className="min-h-20" value={form.promptSpec} onChange={(e) => update({ promptSpec: e.target.value })} />
                </Field>
              </>
            ) : form.autoSourceType === "topic" ? (
              <Field label={t("jobs.topic")} {...(error ? { error } : {})}>
                <TextArea form={FORM_ID} className="min-h-28" placeholder={t("jobs.placeholder.topic")} value={form.topic} onChange={(e) => update({ topic: e.target.value })} required />
              </Field>
            ) : form.autoSourceType === "raw_script" ? (
              <Field label={t("jobs.existingScript")} {...(error ? { error } : {})}>
                <TextArea form={FORM_ID} className="min-h-40" placeholder={t("jobs.placeholder.script")} value={form.autoRawScript} onChange={(e) => update({ autoRawScript: e.target.value })} required />
              </Field>
            ) : (
              <Field label={t("jobs.autoSource.article_url")} {...(error ? { error } : {})}>
                <TextInput form={FORM_ID} inputMode="url" placeholder={t("jobs.placeholder.articleUrl")} value={form.autoArticleUrl} onChange={(e) => update({ autoArticleUrl: e.target.value })} required />
              </Field>
            )}
          </FormSection>
          {newsDrawer ? (
            <NewsDrawer initialQuery={newsDrawer.query} selectedId={selectedNews?.id ?? null} onUse={(item) => void pickNewsItem(item)} onClose={() => setNewsDrawer(null)} />
          ) : null}

          <form
            id={FORM_ID}
            className="flex min-w-0 flex-col gap-5"
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
                    // V04-01: never start a run whose template cannot render with this account (the API re-checks with the same rule).
                    const state = templateSelectionState(library, values.templateId, values.renderAccountId);
                    if (state.kind === "incompatible") throw new ApiError("VALIDATION_FAILED", t("templates.library.blockReason.incompatible_account"));
                    if (state.kind === "not_ready") throw new ApiError("VALIDATION_FAILED", t("templates.library.notReadyWarning", { reason: t(`templates.library.blockReason.${state.reason}`) }));
                    // VE2E-94: a caption preset the template's engine cannot draw never starts a run; a valid one is sent as VALUES.
                    const preset = captionPresetById(values.captionPresetId);
                    const presetEngine = state.kind === "ok" ? studioCaptionEngine(state.template, renderAccounts.find((account) => account.id === values.renderAccountId)?.provider) : null;
                    const presetSupport = preset && presetEngine ? captionPresetSupport(presetEngine, preset) : null;
                    if (preset && presetSupport && !presetSupport.ok) throw new ApiError("VALIDATION_FAILED", t("captionPresets.incompatibleSelected", { name: t(preset.nameKey), reason: t(CAPTION_REASON_KEY[presetSupport.reason]) }));
                    const snapshot = await pinTemplateSnapshot(values.renderAccountId, values.templateId);
                    const setup = await setupAutoProfile({
                      name: (values.topic || values.autoArticleUrl || "Auto video").slice(0, 60),
                      contentAccountId: values.contentAccountId,
                      // the same account + voiceId the Voice Picker previews (renderVoiceConfig is shared with it)
                      ...renderVoiceConfig(values),
                      mediaAccountId: values.mediaAccountId,
                      renderAccountId: values.renderAccountId,
                      templateSnapshotId: snapshot.id,
                      ...(isOrshotRender ? { renderOptions: compactOrshotOptions({ ...(values.orshotFormat ? { format: values.orshotFormat } : {}), ...(values.orshotSize ? { size: values.orshotSize } : {}) }) } : {}),
                      ...(preset && presetEngine && presetEngine !== "orshot" ? { captionStyle: captionPresetOptionValues(preset) } : {}),
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
            {/* 2 - where and how long */}
            <FormSection step={2} accent="green" icon={<Clapperboard size={18} aria-hidden />} complete={videoDone} stepLabel={t("jobs.stepLabel", { n: 2 })} doneLabel={t("jobs.sectionDone")} title={t("jobs.section.video.title")} subtitle={t("jobs.section.video.subtitle")} testId="section-video">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("jobs.channel")} icon={<LabelIcon icon={<Tv size={14} />} />}>
                  <Select value={form.channelId} onChange={(e) => update({ channelId: e.target.value })} required>
                    {placeholder(form.channelId)}
                    {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
                  </Select>
                </Field>
                <ChoiceField label={t("jobs.language")} icon={<LabelIcon icon={<Languages size={14} />} />}>
                  <SegmentedTabs ariaLabel={t("jobs.language")} testId="language-choice" value={form.language} onChange={(language) => update({ language })} options={SCRIPT_LANGUAGES.map((code) => ({ id: code, label: code.toUpperCase() }))} />
                </ChoiceField>
                <ChoiceField label={t("jobs.durationTarget")} icon={<LabelIcon icon={<Timer size={14} />} />}>
                  <SegmentedTabs ariaLabel={t("jobs.durationTarget")} testId="duration-choice" value={form.durationTarget} onChange={(durationTarget) => update({ durationTarget })} options={DURATION_TARGETS.map((value) => ({ id: value, label: value }))} />
                </ChoiceField>
                <ChoiceField label={t("jobs.sceneCountTarget")} icon={<LabelIcon icon={<Film size={14} />} />}>
                  <SegmentedTabs ariaLabel={t("jobs.sceneCountTarget")} testId="scene-count-choice" value={form.sceneCountTarget} onChange={(sceneCountTarget) => update({ sceneCountTarget })} options={SCENE_COUNT_TARGETS.map((value) => ({ id: value, label: value }))} />
                </ChoiceField>
              </div>
            </FormSection>

            {/* 3 - Auto only: how it looks and sounds */}
            {form.entryMode === "auto" ? (
              <FormSection step={3} accent="violet" icon={<Palette size={18} aria-hidden />} complete={styleDone} stepLabel={t("jobs.stepLabel", { n: 3 })} doneLabel={t("jobs.sectionDone")} title={t("jobs.section.style.title")} subtitle={t("jobs.section.style.subtitle")} testId="section-style">
                <div data-testid="template-field">
                  <ChoiceField label={t("jobs.autoTemplate")} icon={<LabelIcon icon={<LayoutTemplate size={14} />} />} {...(renderAccounts.length > 0 && library.length === 0 ? { hint: t("jobs.autoNoTemplate") } : {})}>
                    {renderAccounts.length > 0 ? (
                      /* VE2E-13 / V04-XX / V04-01: the library of every render account, filtered by group. A card only opens the 9:16
                         preview; only "Chọn template này" in the preview applies a template (and its render account). */
                      <div className="flex flex-col gap-2.5">
                        <TemplatePicker
                          templates={library}
                          selectedId={templateState.kind === "ok" || templateState.kind === "not_ready" || templateState.kind === "incompatible" ? form.templateId : null}
                          onChoose={(tpl) => chooseTemplate(tpl)}
                          onPreviewSelected={(tpl) => { const at = previewTemplates.findIndex((item) => item.externalTemplateId === tpl.externalTemplateId); if (at >= 0) setPreviewIndex(at); }}
                        />
                        {templateState.kind === "ok" || templateState.kind === "not_ready" || templateState.kind === "incompatible" ? (
                          <p className="text-[12px] text-lyx-fg-muted" data-testid="template-selected-line">{t("templates.library.selectedLine", { name: templateState.template.name })}</p>
                        ) : null}
                        {templateState.kind === "incompatible" ? (
                          <Banner variant="warn"><span data-testid="template-incompatible">{t("templates.library.blockReason.incompatible_account")}</span></Banner>
                        ) : null}
                        {templateState.kind === "not_ready" ? (
                          <Banner variant="warn"><span data-testid="template-not-ready-warning">{t("templates.library.notReadyWarning", { reason: t(`templates.library.blockReason.${templateState.reason}`) })}</span></Banner>
                        ) : null}
                        {libraryFailed.length > 0 ? <p className="text-[11.5px] text-lyx-danger">{t("templates.library.loadPartial", { names: libraryFailed.join(", ") })}</p> : null}
                      </div>
                    ) : (
                      <p className="text-[12.5px] text-lyx-fg-muted">{t("jobs.noRenderAccount")} <Link className="underline" to="/settings?tab=providers">{t("providers.title")}</Link></p>
                    )}
                  </ChoiceField>
                </div>

                <div data-testid="voice-field">
                  {voiceAccounts.length > 0 ? (
                    <ChoiceField label={t("jobs.autoVoice")} icon={<LabelIcon icon={<Mic size={14} />} />}>
                      {/* search / filter / preview; choosing sets form.voiceId exactly as the old select did (draft + defaults unchanged) */}
                      <VoicePicker
                        voices={voices}
                        selectedId={form.voiceId}
                        onSelect={(voiceId) => update({ voiceId })}
                        language={form.language}
                        accountId={form.voiceAccountId}
                        modelId={voiceAccounts.find((account) => account.id === form.voiceAccountId)?.model ?? null}
                        state={voicesState}
                        onCloned={(result) => {
                          // the new voice joins the list (reloaded; if that fails it is added by hand) and is chosen right away
                          const added = { voiceId: result.voiceId, name: result.name, category: "cloned", previewUrl: null, gender: null, language: null, accent: null, age: null, useCase: null, descriptive: null, languages: [] };
                          void listElevenLabsVoices(form.voiceAccountId)
                            .then((rows) => setVoices(rows.some((row) => row.voiceId === result.voiceId) ? rows : [added, ...rows]))
                            .catch(() => setVoices((current) => [added, ...current.filter((row) => row.voiceId !== result.voiceId)]));
                          update({ voiceId: result.voiceId });
                        }}
                      />
                    </ChoiceField>
                  ) : (
                    <ChoiceField label={t("jobs.autoVoice")} icon={<LabelIcon icon={<Mic size={14} />} />}>
                      <p className="text-[12.5px] text-lyx-fg-muted">{t("jobs.noVoiceAccount")} <Link className="underline" to="/settings?tab=providers">{t("providers.title")}</Link></p>
                    </ChoiceField>
                  )}
                </div>

                {/* VE2E-94: shared caption presets (same catalog as Studio); stored with the draft / defaults like every option. */}
                <section className="flex flex-col gap-1.5" aria-label={t("captionPresets.title")} data-testid="auto-caption-style">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-medium"><LabelIcon icon={<Captions size={14} />} />{t("captionPresets.title")}</span>
                  <CaptionPresetPicker selectedId={form.captionPresetId} engine={captionEngine} defaults={captionDefaults} onChoose={(id) => update({ captionPresetId: id })} />
                  {captionPreset && !captionPresetCheck.ok ? (
                    <Banner variant="warn">
                      <span data-testid="caption-preset-incompatible">{t("captionPresets.incompatibleSelected", { name: t(captionPreset.nameKey), reason: t(CAPTION_REASON_KEY[captionPresetCheck.reason]) })}</span>
                    </Banner>
                  ) : null}
                </section>
              </FormSection>
            ) : null}

            {/* Technical settings: accounts and render options - collapsed, opened by itself while a required choice is missing. */}
            <AdvancedSection
              icon={<SlidersHorizontal size={15} aria-hidden />}
              title={t("jobs.advanced.title")}
              subtitle={t(form.entryMode === "auto" ? "jobs.advanced.subtitleAuto" : "jobs.advanced.subtitleStudio")}
              open={advancedOpen || advancedNeeded}
              onToggle={setAdvancedOpen}
              attention={advancedNeeded ? t("jobs.advanced.attention") : null}
            >
              <Field label={t("jobs.contentAccount")}>
                <Select value={form.contentAccountId} onChange={(e) => update({ contentAccountId: e.target.value })} required>
                  {placeholder(form.contentAccountId)}
                  {contentAccounts.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} · {item.provider} · {item.model}{item.status !== "verified" ? " · ?" : ""}</option>
                  ))}
                </Select>
              </Field>
              {form.entryMode === "auto" ? (
                <>
                  {voiceAccounts.length > 1 || (voiceAccounts.length > 0 && !form.voiceAccountId) ? (
                    <Field label={t("jobs.autoVoiceAccount")}>
                      <Select value={form.voiceAccountId} onChange={(e) => update({ voiceAccountId: e.target.value }, ["voiceId"])}>
                        {placeholder(form.voiceAccountId)}
                        {voiceAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                      </Select>
                    </Field>
                  ) : null}
                  {mediaAccounts.length > 1 || (mediaAccounts.length > 0 && !form.mediaAccountId) ? (
                    <Field label={t("jobs.autoMediaAccount")}>
                      <Select value={form.mediaAccountId} onChange={(e) => update({ mediaAccountId: e.target.value })}>
                        {placeholder(form.mediaAccountId)}
                        {mediaAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.provider}</option>)}
                      </Select>
                    </Field>
                  ) : null}
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
                    <Link className="-mt-2 text-[12px] text-lyx-fg-muted underline" to="/settings?tab=providers">{t("jobs.autoAddOrshot")}</Link>
                  ) : null}
                  {isOrshotRender ? (
                    <div className="flex flex-col gap-2 rounded-lg border border-lyx-border p-3">
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
                  <Field label={t("jobs.backgroundSegments")} hint={t("jobs.backgroundSegmentsHint")}>
                    <Select id="background-segments" value={form.backgroundSegmentsChoice} onChange={(e) => update({ backgroundSegmentsChoice: e.target.value })}>
                      {BACKGROUND_SEGMENT_CHOICES.map((value) => (
                        <option key={value} value={value}>
                          {value === "auto"
                            ? t("jobs.backgroundSegmentsAuto", { min: autoSegmentRange?.min ?? "?", max: autoSegmentRange?.max ?? "?" })
                            : t("jobs.backgroundSegmentsFixed", { count: Number(value) })}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              ) : null}
            </AdvancedSection>

            {/* VE2E-124: the user's own creation defaults (options only, stored per user on the server). */}
            <AccentCard accent="rose" icon={<BookmarkCheck size={15} aria-hidden />} title={t("jobs.defaultsTitle")} subtitle={t("jobs.defaultsHint")} testId="defaults-box" className="lyx-panel-hover sm:px-5">
              <div className="flex flex-wrap items-center gap-2 sm:pl-[38px]">
                <Button type="button" variant="secondary" disabled={!hydrated || defaultsBusy} onClick={() => void saveDefaults()}>{t("jobs.defaultsSave")}</Button>
                <Button type="button" variant="ghost" disabled={!hydrated || defaultsBusy} onClick={() => void resetDefaults()}>{t("jobs.defaultsReset")}</Button>
                {defaultsMessage ? (
                  <p key={defaultsMessage.text} role={defaultsMessage.ok ? "status" : "alert"} className={`lyx-enter text-[12px] ${defaultsMessage.ok ? "text-lyx-ok" : "text-lyx-danger"}`}>{defaultsMessage.text}</p>
                ) : null}
              </div>
            </AccentCard>
          </form>

          {/* Phones: the summary sits below everything, so the create button also rides along at the bottom of the screen
              (sticky inside this column only - it stops where the summary begins). */}
          <div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-lyx-border bg-lyx-bg px-4 py-3 sm:-mx-7 sm:px-7 lg:hidden" data-testid="mobile-submit">
            <p className={`min-w-0 flex-1 text-[12px] ${missingCount > 0 ? "text-lyx-warn" : "text-lyx-ok"}`}>{missingCount > 0 ? t("jobs.readyMissing", { count: missingCount }) : t("jobs.readyAll")}</p>
            <Button type="submit" form={FORM_ID} className="lyx-btn-accent shrink-0" loading={busy} disabled={!hydrated || !canSubmit}>
              {busy ? null : <Rocket size={14} aria-hidden />}
              {form.entryMode === "auto" ? t("jobs.autoSubmit") : t("jobs.submit")}
            </Button>
          </div>
        </div>

        {/* Summary: what will be made, what is still missing, and the one button that makes it (submits the form above). */}
        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-[calc(var(--lyx-topbar)+20px)]" aria-label={t("jobs.summary")}>
          <AccentCard accent="cta" icon={<ListChecks size={15} aria-hidden />} title={t("jobs.summary")} testId="create-summary">
            <ProgressStrip title={t("jobs.progressTitle")} label={t("jobs.progressDone", { done: progressSteps.filter((step) => step.done).length, total: progressSteps.length })} steps={progressSteps} />
            <dl className="flex flex-col divide-y divide-lyx-neutral-bg">
              <SummaryRow accent="green" icon={<Tv size={13} />} label={t("jobs.channel")} value={selectedChannel?.name ?? t("jobs.notChosen")} empty={!selectedChannel} />
              <SummaryRow accent="green" icon={<Languages size={13} />} label={t("jobs.language")} value={form.language.toUpperCase()} />
              <SummaryRow accent="green" icon={<Timer size={13} />} label={t("jobs.durationTarget")} value={form.durationTarget} />
              <SummaryRow accent="green" icon={<Film size={13} />} label={t("jobs.sceneCountTarget")} value={form.sceneCountTarget} />
              {form.entryMode === "auto" ? (
                <>
                  <SummaryRow accent="violet" icon={<LayoutTemplate size={13} />} label={t("jobs.summaryLabel.template")} value={captionTemplate?.name ?? t("jobs.notChosen")} empty={!captionTemplate} />
                  <SummaryRow accent="violet" icon={<Mic size={13} />} label={t("jobs.summaryLabel.voice")} value={selectedVoice?.name ?? t("jobs.notChosen")} empty={!selectedVoice} />
                  <SummaryRow accent="violet" icon={<Captions size={13} />} label={t("jobs.summaryLabel.caption")} value={captionPreset ? t(captionPreset.nameKey) : t("captionPresets.templateDefault")} />
                </>
              ) : (
                <SummaryRow accent="amber" icon={<Bot size={13} />} label={t("jobs.summaryLabel.model")} value={selected ? `${selected.provider} · ${selected.model}` : t("jobs.notChosen")} empty={!selected} />
              )}
            </dl>

            {form.entryMode === "auto" ? (
              <div className="flex flex-col gap-2 border-t border-lyx-border pt-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("jobs.autoPreflightTitle")}</p>
                <ul className="flex flex-col gap-1.5" data-testid="auto-preflight">
                  {preflight.map((row) => (
                    <ReadyItem
                      key={row.key}
                      ok={row.ok}
                      label={t(`jobs.autoPreflight.${row.key}`)}
                      action={preflightAction(row.key)}
                    />
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 border-t border-lyx-border pt-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("jobs.nextStepsTitle")}</p>
                <ol className="flex flex-col gap-1 text-[12px] text-lyx-fg-muted">
                  {nextSteps.map((label, index) => (
                    <li key={label} className="flex gap-2"><span className="w-3 shrink-0 font-semibold text-lyx-fg-subtle">{index + 1}</span>{label}</li>
                  ))}
                </ol>
              </div>
            )}

            {/* the moment everything is ready the button rings once (keyed on readiness) */}
            <Button
              key={canSubmit ? "ready" : "blocked"}
              type="submit"
              form={FORM_ID}
              className={`lyx-btn-accent h-11 w-full text-[14px] ${canSubmit && hydrated ? "lyx-anim-success" : ""}`}
              loading={busy}
              disabled={!hydrated || !canSubmit}
            >
              {busy ? null : <Rocket size={15} aria-hidden />}
              {busy ? generatingLabel : form.entryMode === "auto" ? t("jobs.autoSubmit") : t("jobs.submit")}
            </Button>

            {/* VE2E-124: the user's own draft - saved here only, no job/workflow, no AI/TTS/render call, no cost. */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-t border-lyx-border pt-3 text-[12px]" data-testid="draft-bar">
              {/* the draft's save button with its saving / saved / failed feedback (saving itself: DraftAutosaver, unchanged) */}
              <DraftSaveControl
                status={draftStatus}
                disabled={!hydrated || busy}
                onSave={saveDraftNow}
                onRetry={() => void autosaver.retry()}
                onOverwrite={() => void overwriteDraft()}
                formatTime={formatTime}
              />
              <Button type="button" variant="ghost" className="!px-2.5 text-[12px]" disabled={!hydrated || busy} onClick={() => setDiscardOpen(true)}>{t("jobs.draftDiscard")}</Button>
            </div>
          </AccentCard>
        </aside>
      </div>
    </>
  );
}
