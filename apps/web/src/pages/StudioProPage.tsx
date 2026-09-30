import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Smartphone,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { LazyThumb } from "../components/LazyThumb";
import { RenderProgress } from "../components/RenderProgress";
import { Button, Select, TextArea } from "../components/ui";
import { api, ApiError } from "../api";
import type { ApiProvider } from "../jobs-api";
import type {
  AudioVersionResponse,
  ElevenLabsVoiceSummaryResponse,
  MediaAssetVersionSummary,
  PexelsSearchResponse,
  PexelsMediaType,
  RenderJobResponse,
  StudioContextResponse,
  StudioSceneContextResponse,
  TemplateModificationSlotResponse,
  TemplateSnapshotResponse,
  TimelineOptionValues,
  TimelineRenderPreviewResponse,
  TimelineSegmentResponse,
  MediaPlanResponse,
} from "@lyonix/contracts";
import { groupTemplateOptionsByScene } from "../studio/inspector-grouping";
import { buildTimelineSaveScenes, withMediaAssigned } from "../studio/timeline-save";
import { applyMediaPlan, assignSceneOnly, inPointShortfall, replaceSegmentSource } from "../studio/media-segments";
import { isCreatomatePreviewSupported, mountCreatomatePreview, type CreatomatePreviewHandle } from "../studio/creatomate-preview";
import {
  approveTimelineVersion,
  fetchCreatomatePreviewConfig,
  fetchStudioContext,
  fetchTimelineDynamicPreviewSource,
  generateSceneAudio,
  getAudioGenerationOperation,
  getRenderJob,
  getTemplateSnapshot,
  importPexels,
  issueMediaDeliveryToken,
  listElevenLabsVoices,
  listProjectMedia,
  listSceneAudioVersions,
  planProjectMedia,
  previewTimelineVersion,
  saveTimelineVersion,
  searchPexels,
  submitDynamicRenderFromTimeline,
} from "../studio/timeline-api";
import { UndoStack } from "../studio/undo-stack";
import { ApifyMediaTab } from "../studio/ApifyMediaTab";
import { SourceBadge } from "../studio/SourceBadge";
import { fetchVideoProductionStudioContext } from "../video-productions-api";

/** VE2E-13: Studio's Creatomate SDK preview panel state. `unsupported`/`not_configured` are expected fallback states, not errors — the existing LyOnix scene-board canvas stays the always-available preview in both cases. */
type SdkPreviewState = "off" | "unsupported" | "not_configured" | "loading" | "ready" | "error" | "empty";

const PANEL_STATE_KEY = "lyx-studio-panels";
const readPanelState = (): { left: boolean; right: boolean } => {
  if (typeof localStorage === "undefined") return { left: false, right: false };
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_STATE_KEY) ?? "{}");
    return { left: Boolean(raw.left), right: Boolean(raw.right) };
  } catch {
    return { left: false, right: false };
  }
};

const PREVIEW_ZOOM_STEPS = [180, 220, 270];
const MEDIA_SCALE_STEPS = [0.9, 1, 1.1] as const;
const TIMELINE_PX_PER_SECOND = [7, 11, 16];
const LIBRARY_PREVIEW_LIMIT = 12;
/** A signed media-delivery URL is refetched once cached this long - kept comfortably under the server's own token TTL (600s default, `media-delivery.service.ts`) so a thumbnail/player never silently 403s mid-session. */
const THUMB_CACHE_REFRESH_MS = 8 * 60_000;
/** Hard cap on how many signed delivery URLs `thumbCache` holds at once - a long Studio session that imports/regenerates many assets must not grow this without bound. */
const THUMB_CACHE_MAX_ENTRIES = 120;

type LeftTab = "media" | "script" | "voice";

type SceneDraft = {
  sceneId: string;
  mediaAssetVersionId: string | null;
  mediaLabel: string | null;
  audioVersionId: string | null;
  subtitleVersionId: string | null;
  screenTextOverride: string | null;
  annotation: string | null;
  /** User-removed from the render (kept, not deleted — see `toggleSceneExcluded`). */
  excluded: boolean;
  /** VE2E-42: carried through from the saved timeline (no segment UI until VE2E-41); see studio/timeline-save.ts. */
  segmentId: string | null;
  sourceStartMs: number | null;
  sourceDurationMs: number | null;
};

type TimelineDraft = {
  templateSnapshotId: string | null;
  scenes: SceneDraft[];
  optionValues: TimelineOptionValues;
  /** VE2E-42: the saved segment plan, carried through unchanged on re-save. */
  segments: TimelineSegmentResponse[];
};

const draftFromContext = (context: StudioContextResponse): TimelineDraft => {
  const saved = context.latestTimelineVersion;
  const contextIds = new Set(context.scenes.map((scene) => scene.sceneId));
  const savedById = new Map((saved?.scenes ?? []).map((scene) => [scene.sceneId, scene]));
  // A previously saved scene order (reordered via the timeline's move buttons) is preserved
  // across reloads; any scene the script has that the saved timeline doesn't know about yet
  // (freshly generated, never saved) is appended at the end in its script order.
  const orderedSceneIds = [
    ...(saved?.scenes ?? []).map((scene) => scene.sceneId).filter((sceneId) => contextIds.has(sceneId)),
    ...context.scenes.map((scene) => scene.sceneId).filter((sceneId) => !savedById.has(sceneId)),
  ];
  return {
    templateSnapshotId: saved?.templateSnapshotId ?? null,
    optionValues: saved?.optionValues ?? {},
    segments: saved?.segments ?? [],
    scenes: orderedSceneIds.map((sceneId) => {
      const bound = savedById.get(sceneId);
      return {
        sceneId,
        mediaAssetVersionId: bound?.mediaAssetVersionId ?? null,
        mediaLabel: null,
        audioVersionId: bound?.audioVersionId ?? null,
        subtitleVersionId: bound?.subtitleVersionId ?? null,
        screenTextOverride: bound?.screenTextOverride ?? null,
        annotation: bound?.annotation ?? null,
        excluded: bound?.excluded ?? false,
        segmentId: bound?.segmentId ?? null,
        sourceStartMs: bound?.sourceStartMs ?? null,
        sourceDurationMs: bound?.sourceDurationMs ?? null,
      };
    }),
  };
};

const usableAccounts = (providers: ApiProvider[], role: ApiProvider["role"]) =>
  providers.filter((row) => row.role === role && (row.isFake || row.status === "verified"));

export function StudioProPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // VE2E-08: this route is shared by the legacy job Studio bridge (/jobs/:id/studio) and
  // the Auto "Mở trong Studio" fork (/video-productions/:id/studio) - same page/component,
  // different context source and "back" target, since an Auto run has no legacy job row.
  const isVideoProduction = location.pathname.startsWith("/video-productions/");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const undoStack = useRef(new UndoStack<TimelineDraft>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Flips false on unmount so a still-running recursive poll (e.g. `generateAudioForScene`'s
  // audio-generation poll, which has no interval/effect of its own to clear) stops rescheduling
  // itself and stops calling setState instead of leaking a `setTimeout` chain forever.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const [context, setContext] = useState<StudioContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [mediaLibrary, setMediaLibrary] = useState<MediaAssetVersionSummary[]>([]);
  const [thumbCache, setThumbCache] = useState<Record<string, string>>({});

  const [draft, setDraft] = useState<TimelineDraft>({ templateSnapshotId: null, scenes: [], optionValues: {}, segments: [] });
  const [baseVersionId, setBaseVersionId] = useState<string | null>(null);
  const [timelineStatus, setTimelineStatus] = useState<"draft" | "approved" | null>(null);
  const [lastSavedJson, setLastSavedJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [approving, setApproving] = useState(false);
  const [preview, setPreview] = useState<TimelineRenderPreviewResponse | null>(null);

  // VE2E-18: job list/detail deep-links here with `?tab=media|voice|script` when that's
  // the job's real current step (CR-JOBS-PIPELINE-STATUS-2026-09-26).
  const initialTabParam = searchParams.get("tab");
  const [leftTab, setLeftTab] = useState<LeftTab>(
    initialTabParam === "voice" || initialTabParam === "script" || initialTabParam === "media" ? initialTabParam : "media",
  );
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [template, setTemplate] = useState<TemplateSnapshotResponse | null>(null);

  const [visualAccountId, setVisualAccountId] = useState("");
  const [pexelsQuery, setPexelsQuery] = useState("");
  const [manualMediaType, setManualMediaType] = useState<PexelsMediaType>("video");
  const [pexelsResults, setPexelsResults] = useState<PexelsSearchResponse | null>(null);
  const [pexelsSearching, setPexelsSearching] = useState(false);
  const [mediaPlanBusy, setMediaPlanBusy] = useState(false);
  const [mediaPlanDiagnostics, setMediaPlanDiagnostics] = useState<MediaPlanResponse["diagnostics"]>([]);
  const [segmentCount, setSegmentCount] = useState("auto");
  const [mediaScope, setMediaScope] = useState<"segment" | "scene">("segment");
  const [segmentInPoints, setSegmentInPoints] = useState<Record<string, number>>({});

  const [voiceAccountId, setVoiceAccountId] = useState("");
  const [voices, setVoices] = useState<ElevenLabsVoiceSummaryResponse[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [audioBySceneId, setAudioBySceneId] = useState<Record<string, AudioVersionResponse>>({});
  const [audioBusySceneId, setAudioBusySceneId] = useState<string | null>(null);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [voiceApplyBusy, setVoiceApplyBusy] = useState<{ done: number; total: number } | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const [renderAccountId, setRenderAccountId] = useState("");
  const [renderJob, setRenderJob] = useState<RenderJobResponse | null>(null);
  const [renderSubmitting, setRenderSubmitting] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [renderPlaybackError, setRenderPlaybackError] = useState(false);

  // VE2E-13: Creatomate JavaScript Preview SDK — off by default (mounting it loads a real
  // third-party iframe from creatomate.com, so it stays an explicit user action, never
  // eager/silent). `sdkConfigured` reflects the server-side public-token config check
  // (B10/B11-gated) fetched once on mount; the SDK toggle itself is only ever enabled when
  // that is true and the browser passes `isCreatomatePreviewSupported()`.
  const [sdkConfigured, setSdkConfigured] = useState<boolean | null>(null);
  const [sdkPublicToken, setSdkPublicToken] = useState<string | null>(null);
  const [sdkState, setSdkState] = useState<SdkPreviewState>("off");
  const sdkContainerRef = useRef<HTMLDivElement | null>(null);
  const sdkHandleRef = useRef<CreatomatePreviewHandle | null>(null);
  const sdkPushedVersionRef = useRef<string | null>(null);

  // Panel visibility (spec: "ẩn Nav, các vùng tùy chọn nếu không dùng đến để mở rộng không
  // gian") - collapsing either side panel just widens the center review/timeline column, and
  // is remembered per-browser like the theme/nav preferences so it doesn't reset every visit.
  const [panelState, setPanelState] = useState(readPanelState);
  const leftCollapsed = panelState.left;
  const rightCollapsed = panelState.right;
  const [tiktokFrame, setTiktokFrame] = useState(false);
  const [previewZoomIdx, setPreviewZoomIdx] = useState(1);
  const [mediaScaleIdx, setMediaScaleIdx] = useState(1);
  const [timelineZoomIdx, setTimelineZoomIdx] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [libraryExpanded, setLibraryExpanded] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewAudioTrackRef = useRef<HTMLAudioElement | null>(null);
  const thumbInFlight = useRef(new Set<string>());
  // Insertion-ordered `id -> cachedAt` for every `thumbCache` entry - drives the bounded FIFO
  // eviction and the TTL-based refresh below (a signed delivery URL expires server-side after
  // `MEDIA_DELIVERY_TOKEN_TTL_SEC`, default 600s - see `media-delivery.service.ts`). A `Map`
  // (not the `thumbCache` state itself) so read call sites elsewhere in this component are
  // untouched; this is purely the prefetch effect's own bookkeeping.
  const thumbCacheMeta = useRef(new Map<string, number>());

  const dirty = useMemo(() => JSON.stringify(draft) !== lastSavedJson, [draft, lastSavedJson]);

  const setPanel = (next: Partial<{ left: boolean; right: boolean }>) => {
    setPanelState((prev) => {
      const merged = { ...prev, ...next };
      localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(merged));
      return merged;
    });
  };

  useEffect(() => {
    if (!id) return;
    void (isVideoProduction ? fetchVideoProductionStudioContext(id) : fetchStudioContext(id))
      .then((ctx) => {
        setContext(ctx);
        const nextDraft = draftFromContext(ctx);
        setDraft(nextDraft);
        setLastSavedJson(JSON.stringify(nextDraft));
        setBaseVersionId(ctx.latestTimelineVersion?.id ?? null);
        setTimelineStatus(ctx.latestTimelineVersion?.status ?? null);
        setSelectedSceneId(ctx.scenes[0]?.sceneId ?? null);
        undoStack.current.reset();
        if (ctx.latestTimelineVersion?.templateSnapshotId) {
          void getTemplateSnapshot(ctx.latestTimelineVersion.templateSnapshotId).then(setTemplate).catch(() => undefined);
        }
        void api<ApiProvider[]>("/provider-accounts").then(setProviders).catch(() => undefined);
        void listProjectMedia(ctx.projectId).then(setMediaLibrary).catch(() => undefined);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === "INVALID_STATE") setNeedsApproval(true);
        else setError(err instanceof ApiError ? err.message : t("common.error"));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // VE2E-18: job list/detail deep-links here with `?renderJobId=` when the job's render is
  // the current step (in-flight or completed) - loads that render's status/link on mount
  // instead of only ever showing one submitted earlier in this same browser session.
  useEffect(() => {
    const renderJobId = searchParams.get("renderJobId");
    if (!renderJobId) return;
    void getRenderJob(renderJobId).then(setRenderJob).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // A pinned template arrives via TemplateGalleryPage's navigation state (it pins the
  // snapshot itself, then hands the id back here) rather than through localStorage.
  useEffect(() => {
    const incoming = (location.state as { templateSnapshotId?: string } | null)?.templateSnapshotId;
    if (!incoming || !context) return;
    navigate(location.pathname, { replace: true, state: {} });
    void getTemplateSnapshot(incoming).then((snapshot) => {
      setTemplate(snapshot);
      undoStack.current.push(draft);
      setDraft((prev) => ({ ...prev, templateSnapshotId: snapshot.id }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, context]);

  useEffect(() => {
    if (providers.length === 0) return;
    setVisualAccountId((current) => current || usableAccounts(providers, "visual").find((row) => row.provider === "pexels")?.id || "");
    setVoiceAccountId((current) => current || usableAccounts(providers, "tts")[0]?.id || "");
    setRenderAccountId((current) => current || usableAccounts(providers, "render")[0]?.id || "");
  }, [providers]);

  useEffect(() => {
    if (!voiceAccountId) return;
    void listElevenLabsVoices(voiceAccountId).then((rows) => {
      setVoices(rows);
      setSelectedVoiceId((current) => current || rows[0]?.voiceId || "");
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceAccountId]);

  // Autosave: optimistic version save debounced after any local edit, using the last
  // successfully saved/loaded version id as `supersedesId` (spec §7 "autosave optimistic
  // version, dirty/conflict indicator").
  useEffect(() => {
    if (!context || !dirty || conflict) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persist(); }, 1200);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, context, conflict]);

  // Resets the inline player's error state whenever a different render job is shown - an
  // earlier failed playback attempt must not stick around and mask a newer, valid resultUrl.
  useEffect(() => { setRenderPlaybackError(false); }, [renderJob?.id]);

  useEffect(() => {
    if (!renderJob || renderJob.status === "completed" || renderJob.status === "failed" || renderJob.status === "cancelled") {
      if (pollTimer.current) clearInterval(pollTimer.current);
      return;
    }
    pollTimer.current = setInterval(() => {
      void getRenderJob(renderJob.id).then(setRenderJob).catch(() => undefined);
    }, 4000);
    return () => { if (pollTimer.current) clearInterval(pollTimer.current); };
  }, [renderJob]);

  // VE2E-13: fetch once whether the server has a Creatomate Preview SDK public token
  // configured (B10/B11-gated) - never the render API secret, which never leaves the server.
  useEffect(() => {
    void fetchCreatomatePreviewConfig()
      .then((config) => {
        setSdkConfigured(config.configured);
        setSdkPublicToken(config.publicToken);
      })
      .catch(() => setSdkConfigured(false));
  }, []);

  // Mounts/disposes the real Creatomate SDK iframe only while the user has explicitly
  // toggled it on - never eagerly, since this loads a real third-party embed.
  useEffect(() => {
    if (sdkState !== "loading" || !sdkContainerRef.current || !sdkPublicToken) return;
    let cancelled = false;
    mountCreatomatePreview(sdkContainerRef.current, sdkPublicToken)
      .then((handle) => {
        if (cancelled) { handle.dispose(); return; }
        sdkHandleRef.current = handle;
        setSdkState("empty");
      })
      .catch(() => { if (!cancelled) setSdkState("error"); });
    return () => { cancelled = true; };
  }, [sdkState, sdkPublicToken]);

  // Pushes the current timeline's real dynamic composition JSON into the mounted SDK
  // whenever a save actually lands (`baseVersionId` changes) - the SDK always previews the
  // exact same source a submit would send, never a client-approximated JSON (spec §3).
  // `sdkPushedVersionRef` guards against re-pushing the same already-applied version when
  // this effect re-runs after `setSdkState("ready")` changes its own `sdkState` dependency.
  useEffect(() => {
    if (sdkState !== "empty" && sdkState !== "ready") return;
    if (!sdkHandleRef.current || !context || !baseVersionId) return;
    if (sdkState === "ready" && sdkPushedVersionRef.current === baseVersionId) return;
    const handle = sdkHandleRef.current;
    void fetchTimelineDynamicPreviewSource(context.projectId, baseVersionId)
      .then((preview) => {
        if (!preview.ready || !preview.source) { setSdkState("empty"); return; }
        sdkPushedVersionRef.current = baseVersionId;
        void handle.setSource(preview.source).then(() => setSdkState("ready")).catch(() => setSdkState("error"));
      })
      .catch(() => setSdkState("error"));
  }, [baseVersionId, sdkState, context]);

  useEffect(() => () => sdkHandleRef.current?.dispose(), []);

  const toggleSdkPreview = () => {
    if (sdkState !== "off") {
      sdkHandleRef.current?.dispose();
      sdkHandleRef.current = null;
      setSdkState("off");
      return;
    }
    if (!isCreatomatePreviewSupported()) { setSdkState("unsupported"); return; }
    if (!sdkConfigured || !sdkPublicToken) { setSdkState("not_configured"); return; }
    setSdkState("loading");
  };

  const persist = async () => {
    if (!context) return;
    setSaving(true);
    try {
      const result = await saveTimelineVersion(context.projectId, {
        supersedesId: baseVersionId,
        templateSnapshotId: draft.templateSnapshotId,
        ...buildTimelineSaveScenes(draft.scenes, draft.segments),
        optionValues: draft.optionValues,
      });
      setBaseVersionId(result.id);
      setTimelineStatus(result.status);
      setLastSavedJson(JSON.stringify(draft));
      setConflict(false);
      void previewTimelineVersion(result.id).then(setPreview).catch(() => undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") setConflict(true);
      else setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setSaving(false);
    }
  };

  const reloadAfterConflict = () => {
    if (!id) return;
    setConflict(false);
    void fetchStudioContext(id).then((ctx) => {
      setContext(ctx);
      const nextDraft = draftFromContext(ctx);
      setDraft(nextDraft);
      setLastSavedJson(JSON.stringify(nextDraft));
      setBaseVersionId(ctx.latestTimelineVersion?.id ?? null);
      setTimelineStatus(ctx.latestTimelineVersion?.status ?? null);
      undoStack.current.reset();
    });
  };

  const mutate = (updater: (prev: TimelineDraft) => TimelineDraft) => {
    setDraft((prev) => {
      undoStack.current.push(prev);
      return updater(prev);
    });
  };

  const handleUndo = () => setDraft((prev) => undoStack.current.undo(prev) ?? prev);
  const handleRedo = () => setDraft((prev) => undoStack.current.redo(prev) ?? prev);

  const scenes = context?.scenes ?? [];
  const sceneById = new Map(scenes.map((scene) => [scene.sceneId, scene]));
  // The timeline's own scene order (reorderable via the move buttons), not the fixed script
  // order - drives the scene board, the review panel and the render's actual scene order.
  const orderedScenes = draft.scenes.map((row) => sceneById.get(row.sceneId)).filter((scene): scene is StudioSceneContextResponse => Boolean(scene));
  const selectedScene = scenes.find((scene) => scene.sceneId === selectedSceneId) ?? scenes[0] ?? null;
  const selectedSceneDraft = draft.scenes.find((scene) => scene.sceneId === selectedSceneId) ?? null;
  const totalSeconds = Math.round(
    draft.scenes.reduce((sum, row) => (row.excluded ? sum : sum + (sceneById.get(row.sceneId)?.durationHintMs ?? 0)), 0) / 1000,
  );
  const mediaAssetById = new Map(mediaLibrary.map((asset) => [asset.id, asset]));
  const selectedMediaAsset = selectedSceneDraft?.mediaAssetVersionId ? mediaAssetById.get(selectedSceneDraft.mediaAssetVersionId) : undefined;
  const selectedAudio = selectedScene ? audioBySceneId[selectedScene.sceneId] : undefined;
  const sceneOptionGroups = template ? groupTemplateOptionsByScene(template.modifications, orderedScenes.map((scene) => ({ sceneId: scene.sceneId }))) : { bySceneId: new Map(), leftover: [] };
  const selectedSceneOptions: TemplateModificationSlotResponse[] = selectedScene ? sceneOptionGroups.bySceneId.get(selectedScene.sceneId) ?? [] : [];

  useEffect(() => {
    const player = previewVideoRef.current;
    if (!player || selectedSceneDraft?.sourceStartMs == null) return;
    player.currentTime = selectedSceneDraft.sourceStartMs / 1000;
  }, [selectedMediaAsset?.id, selectedSceneDraft?.sourceStartMs]);

  // Switching scenes always stops whatever was playing - the media/audio elements below are
  // re-pointed at the newly selected scene's own source, so a stale play state would otherwise
  // keep an old clip's audio going under a different scene's preview.
  useEffect(() => {
    setPlaying(false);
    previewVideoRef.current?.pause();
    previewAudioTrackRef.current?.pause();
  }, [selectedSceneId]);

  // Resolves every scene's already-generated audio so the Giọng đọc track can show a real
  // duration instead of an indefinite "···". Cheap metadata GETs; one batched setState.
  // Do not gate on an in-flight Set that survives effect cleanup — React Strict Mode remounts
  // cancel the first pass and would permanently skip the second if those ids stayed marked.
  useEffect(() => {
    const targets = draft.scenes.filter((row) => row.audioVersionId);
    if (targets.length === 0) return;
    let cancelled = false;
    void Promise.all(
      targets.map(async (row) => {
        const scene = sceneById.get(row.sceneId);
        if (!scene || !row.audioVersionId) return null;
        try {
          const rows = await listSceneAudioVersions(scene.id);
          const match = rows.find((item) => item.id === row.audioVersionId) ?? rows[0];
          return match ? ([scene.sceneId, match] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setAudioBySceneId((prev) => {
        let changed = false;
        const merged = { ...prev };
        for (const item of results) {
          if (!item || merged[item[0]]) continue;
          merged[item[0]] = item[1];
          changed = true;
        }
        return changed ? merged : prev;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.scenes]);

  // Prefetch signed media URLs outside render — calling setState from `loadThumb` during
  // paint previously queued dozens of updates on every Studio paint (library + timeline) and
  // made the page feel stuck once a project had many assets.
  useEffect(() => {
    const ids = new Set<string>();
    for (const row of draft.scenes) {
      if (row.mediaAssetVersionId) ids.add(row.mediaAssetVersionId);
    }
    for (const audio of Object.values(audioBySceneId)) ids.add(audio.mediaAssetVersionId);
    for (const asset of mediaLibrary.slice(0, libraryExpanded ? mediaLibrary.length : LIBRARY_PREVIEW_LIMIT)) {
      ids.add(asset.id);
    }
    for (const id of ids) {
      const cachedAt = thumbCacheMeta.current.get(id);
      const fresh = cachedAt !== undefined && Date.now() - cachedAt < THUMB_CACHE_REFRESH_MS;
      if ((thumbCache[id] && fresh) || thumbInFlight.current.has(id)) continue;
      thumbInFlight.current.add(id);
      void issueMediaDeliveryToken(id)
        .then(({ url }) => {
          thumbCacheMeta.current.delete(id); // re-insert at the end so it reads as most-recently-fetched for FIFO eviction below.
          thumbCacheMeta.current.set(id, Date.now());
          const evicted: string[] = [];
          while (thumbCacheMeta.current.size > THUMB_CACHE_MAX_ENTRIES) {
            const oldest = thumbCacheMeta.current.keys().next().value;
            if (oldest === undefined) break;
            thumbCacheMeta.current.delete(oldest);
            evicted.push(oldest);
          }
          setThumbCache((prev) => {
            const next = { ...prev, [id]: url };
            for (const staleId of evicted) delete next[staleId];
            return next;
          });
        })
        .catch(() => undefined)
        .finally(() => thumbInFlight.current.delete(id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.scenes, audioBySceneId, mediaLibrary, libraryExpanded]);

  const moveScene = (sceneId: string, direction: -1 | 1) => {
    mutate((prev) => {
      const index = prev.scenes.findIndex((row) => row.sceneId === sceneId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.scenes.length) return prev;
      const next = [...prev.scenes];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return { ...prev, scenes: next };
    });
  };

  const toggleSceneExcluded = (sceneId: string) => {
    mutate((prev) => ({ ...prev, scenes: prev.scenes.map((row) => (row.sceneId === sceneId ? { ...row, excluded: !row.excluded } : row)) }));
  };

  const assignMediaToScene = (sceneId: string, asset: { id: string; label: string }) => {
    mutate((prev) => ({
      ...prev,
      scenes: prev.scenes.map((scene) => (scene.sceneId === sceneId ? { ...withMediaAssigned(scene, asset.id), mediaLabel: asset.label } : scene)),
    }));
  };

  const assignMediaToSelectedScene = (asset: { id: string; label: string }) => {
    if (!selectedSceneId) return;
    const selected = draft.scenes.find((scene) => scene.sceneId === selectedSceneId);
    const libraryAsset = mediaLibrary.find((row) => row.id === asset.id);
    if (selected?.segmentId && mediaScope === "scene") {
      mutate((prev) => ({ ...prev, ...assignSceneOnly(prev.scenes, prev.segments, selectedSceneId, { id: asset.id, label: asset.label }) }));
      return;
    }
    if (selected?.segmentId && libraryAsset && (libraryAsset.kind === "video" || libraryAsset.kind === "image")) {
      mutate((prev) => {
        const segmentAsset = { id: libraryAsset.id, kind: libraryAsset.kind as "video" | "image", durationMs: libraryAsset.durationMs };
        const replaced = replaceSegmentSource(prev.scenes, prev.segments, selected.segmentId!, segmentAsset);
        return { ...prev, ...replaced, scenes: replaced.scenes.map((scene) => scene.segmentId === selected.segmentId ? { ...scene, mediaLabel: asset.label } : scene) };
      });
      return;
    }
    assignMediaToScene(selectedSceneId, asset);
  };

  const setOptionValue = (key: string, value: string) => {
    mutate((prev) => ({ ...prev, optionValues: { ...prev.optionValues, [key]: value } }));
  };

  const setScreenTextOverride = (sceneId: string, value: string) => {
    mutate((prev) => ({ ...prev, scenes: prev.scenes.map((scene) => (scene.sceneId === sceneId ? { ...scene, screenTextOverride: value } : scene)) }));
  };

  const setAnnotation = (sceneId: string, value: string) => {
    mutate((prev) => ({ ...prev, scenes: prev.scenes.map((scene) => (scene.sceneId === sceneId ? { ...scene, annotation: value } : scene)) }));
  };

  const runPexelsSearch = async (query?: string) => {
    if (!context || !visualAccountId) return;
    const q = (query ?? pexelsQuery).trim();
    if (!q) return;
    setPexelsSearching(true);
    try {
      const results = await searchPexels(context.projectId, visualAccountId, manualMediaType, q);
      setPexelsResults(results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setPexelsSearching(false);
    }
  };

  // Shared by Pexels and Apify imports: honours the "this scene / whole segment" scope. The new asset is not in
  // `mediaLibrary` yet (state update pending), so the segment path must use the asset object directly.
  const applyImportedAsset = (asset: MediaAssetVersionSummary, label: string) => {
    const selectedSegmentId = draft.scenes.find((scene) => scene.sceneId === selectedSceneId)?.segmentId;
    if (selectedSegmentId && mediaScope === "segment") {
      if (asset.kind !== "video" && asset.kind !== "image") return;
      mutate((prev) => {
        const segmentAsset = { id: asset.id, kind: asset.kind as "video" | "image", durationMs: asset.durationMs };
        const replaced = replaceSegmentSource(prev.scenes, prev.segments, selectedSegmentId, segmentAsset, segmentInPoints[selectedSegmentId] ?? 0);
        return { ...prev, ...replaced, scenes: replaced.scenes.map((scene) => scene.segmentId === selectedSegmentId ? { ...scene, mediaLabel: label } : scene) };
      });
    } else {
      assignMediaToSelectedScene({ id: asset.id, label });
    }
  };

  const importPexelsResult = async (externalId: string, label: string, type: PexelsMediaType = manualMediaType) => {
    if (!context || !visualAccountId) return;
    try {
      const { asset } = await importPexels(context.projectId, { providerAccountId: visualAccountId, type, externalId, sceneId: selectedSceneId });
      setMediaLibrary((prev) => [asset, ...prev]);
      applyImportedAsset(asset, label);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    }
  };

  // VE2E-41: Studio calls the server-side MediaPlanService that Auto uses, keeping media
  // source selection and segment ranges consistent across both entry points.
  const autoFillAllMedia = async () => {
    // VE2E-48: the server picks the user's Apify account itself; the client only needs *an* account id (Pexels preferred, else Apify).
    const planAccountId = visualAccountId || apifyAccountId;
    if (!context || !planAccountId || scenes.length === 0) return;
    setError(null);
    setMediaPlanBusy(true);
    try {
      const backgroundSegments = segmentCount === "auto" ? { mode: "auto" as const } : { mode: "fixed" as const, count: Number(segmentCount) };
      const plan = await planProjectMedia(context.projectId, { scriptDraftVersionId: context.scriptDraftVersionId, providerAccountId: planAccountId, backgroundSegments });
      setMediaPlanDiagnostics(plan.diagnostics);
      setDraft((prev) => {
        undoStack.current.push(prev);
        return { ...prev, ...applyMediaPlan(prev.scenes, plan) };
      });
      void listProjectMedia(context.projectId).then(setMediaLibrary).catch(() => undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setMediaPlanBusy(false);
    }
  };

  // Resolves once that scene's audio finishes (completed or failed) so callers can await
  // one scene before starting the next - `generateAudioForSelectedScene` below and the
  // "apply to the whole video" bulk action both build on this single implementation.
  const generateAudioForScene = (scene: StudioSceneContextResponse): Promise<void> => {
    if (!context || !voiceAccountId || !selectedVoiceId) return Promise.resolve();
    setAudioBusySceneId(scene.sceneId);
    setAudioNotice(null);
    return generateSceneAudio(scene.id, { providerAccountId: voiceAccountId, voiceId: selectedVoiceId }, crypto.randomUUID())
      .then(
        (accepted) =>
          new Promise<void>((resolve) => {
            const poll = async (operationId: string): Promise<void> => {
              // The component may have unmounted (navigated away) or this generation may have
              // been superseded while a poll was in flight - never reschedule and never touch
              // state on a gone component; just let the promise settle quietly.
              if (!mountedRef.current) { resolve(); return; }
              const result = await getAudioGenerationOperation(operationId);
              if (!mountedRef.current) { resolve(); return; }
              if (result.status === "completed" && result.audioVersion) {
                setAudioBySceneId((prev) => ({ ...prev, [scene.sceneId]: result.audioVersion! }));
                mutate((prev) => ({
                  ...prev,
                  scenes: prev.scenes.map((row) =>
                    row.sceneId === scene.sceneId
                      ? { ...row, audioVersionId: result.audioVersion!.id, subtitleVersionId: result.audioVersion!.subtitleVersion?.id ?? null }
                      : row,
                  ),
                }));
                setAudioBusySceneId(null);
                resolve();
                return;
              }
              if (result.status === "failed") {
                setAudioNotice(t("studioPro.audioStatusFailed"));
                setAudioBusySceneId(null);
                resolve();
                return;
              }
              setTimeout(() => void poll(operationId), 2000);
            };
            void poll(accepted.operationId);
          }),
      )
      .catch((err) => {
        setAudioBusySceneId(null);
        setError(err instanceof ApiError ? err.message : t("common.error"));
      });
  };

  const generateAudioForSelectedScene = () => (selectedScene ? generateAudioForScene(selectedScene) : Promise.resolve());

  // Auto mode: one voice pick, generated narration for every scene in order (sequential -
  // ElevenLabs is billed per call, so no fan-out) instead of clicking "generate" per scene.
  const applyVoiceToAllScenes = async () => {
    if (!voiceAccountId || !selectedVoiceId || scenes.length === 0) return;
    setVoiceApplyBusy({ done: 0, total: scenes.length });
    for (let i = 0; i < scenes.length; i++) {
      await generateAudioForScene(scenes[i]!);
      setVoiceApplyBusy({ done: i + 1, total: scenes.length });
    }
    setVoiceApplyBusy(null);
  };

  const playVoicePreview = () => {
    const voice = voices.find((row) => row.voiceId === selectedVoiceId);
    if (!voice?.previewUrl) return;
    if (!previewAudioRef.current) previewAudioRef.current = new Audio();
    previewAudioRef.current.src = voice.previewUrl;
    void previewAudioRef.current.play();
  };

  const submitApprove = async () => {
    if (!baseVersionId || dirty) return;
    setApproving(true);
    try {
      const approved = await approveTimelineVersion(baseVersionId);
      setTimelineStatus(approved.status);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setApproving(false);
    }
  };

  const submitRender = async () => {
    // Same freshness guard as submitApprove: `dirty` means the just-generated/edited narration
    // (or any other scene edit) hasn't finished autosaving into a real TimelineVersion yet -
    // submitting against the stale `baseVersionId` would render the OLD version, silently
    // dropping a scene whose audio was only just attached (resolveDynamicComposition requires
    // audioVersionId+audioMediaAssetVersionId to include a scene at all).
    if (!context || !baseVersionId || !renderAccountId || dirty) return;
    setRenderSubmitting(true);
    try {
      const job = await submitDynamicRenderFromTimeline(context.projectId, baseVersionId, {
        providerAccountId: renderAccountId,
        // Only a deliberate submit after a failed job creates a new attempt.
        ...(renderJob?.status === "failed" ? { idempotencyKey: crypto.randomUUID() } : {}),
      });
      setRenderJob(job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setRenderSubmitting(false);
    }
  };

  // Plays the selected scene's real bound media - video muted (its own audio is never the
  // intended track, see the render-time auto-mute in timeline-render-mapping.ts) alongside its
  // real generated narration, so "Phát" previews the actual assets rather than a static frame.
  const togglePlay = () => {
    const next = !playing;
    setPlaying(next);
    if (next) {
      void previewVideoRef.current?.play().catch(() => undefined);
      void previewAudioTrackRef.current?.play().catch(() => undefined);
    } else {
      previewVideoRef.current?.pause();
      previewAudioTrackRef.current?.pause();
    }
  };

  const zoomPreview = (delta: 1 | -1) => setPreviewZoomIdx((prev) => Math.min(PREVIEW_ZOOM_STEPS.length - 1, Math.max(0, prev + delta)));
  const zoomTimeline = (delta: 1 | -1) => setTimelineZoomIdx((prev) => Math.min(TIMELINE_PX_PER_SECOND.length - 1, Math.max(0, prev + delta)));
  const zoomMediaScale = (delta: 1 | -1) => setMediaScaleIdx((prev) => Math.min(MEDIA_SCALE_STEPS.length - 1, Math.max(0, prev + delta)));

  // One rendering per modification `kind` (color/font/volume), shared by both the selected
  // scene's own options and the rare template-level leftovers - a Creatomate modification key
  // is whitelisted server-side (`RenderAssignmentInput`), never a free JSON/expression field.
  const renderModField = (mod: TemplateModificationSlotResponse) => {
    const value = draft.optionValues[mod.key] ?? "";
    if (mod.kind === "color") {
      return (
        <div key={mod.key}>
          <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{mod.key}</label>
          <div className="flex items-center gap-1.5">
            {["#161616", "#F5F5F5", "#0A7A3E"].map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={hex}
                onClick={() => setOptionValue(mod.key, hex)}
                className={`h-[22px] w-[22px] rounded-[4px] border ${value === hex ? "border-lyx-fg" : "border-lyx-border"}`}
                style={{ backgroundColor: hex }}
              />
            ))}
            <input
              value={value}
              onChange={(event) => setOptionValue(mod.key, event.target.value)}
              className="h-8 flex-1 rounded-[4px] border border-lyx-border bg-lyx-muted px-2 text-[11px]"
            />
          </div>
        </div>
      );
    }
    if (mod.kind === "font") {
      return (
        <div key={mod.key}>
          <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{mod.key}</label>
          <Select className="w-full" value={value || "Inter Bold"} onChange={(event) => setOptionValue(mod.key, event.target.value)}>
            <option>Inter Bold</option>
            <option>Inter Medium</option>
            <option>Noto Sans</option>
          </Select>
        </div>
      );
    }
    return (
      <div key={mod.key}>
        <label className="mb-1 flex items-center justify-between font-mono text-[10px] text-lyx-fg-muted">
          <span>{mod.key}</span>
          <span>{value || "80"}%</span>
        </label>
        <input
          type="range"
          min={0}
          max={100}
          value={value || "80"}
          onChange={(event) => setOptionValue(mod.key, event.target.value)}
          className="w-full"
        />
      </div>
    );
  };

  if (needsApproval) {
    return (
      <>
        <Banner variant="warn">{t("studioPro.needScriptApproved")}</Banner>
        <Button variant="secondary" onClick={() => navigate(isVideoProduction ? `/video-productions/${id}` : `/jobs/${id}`)}>{t("studioPro.backToJob")}</Button>
      </>
    );
  }
  if (error && !context) return <Banner variant="danger">{error}</Banner>;
  if (!context) return <Banner variant="info">{t("common.loading")}</Banner>;

  // Pexels feeds the auto-fill/search box; Apify (VE2E-34) has its own tab. Other visual providers (YouTube/Pinterest) are not selectable here.
  const visualAccounts = usableAccounts(providers, "visual").filter((row) => row.provider === "pexels");
  const apifyAccountId = usableAccounts(providers, "visual").find((row) => row.provider === "apify")?.id ?? null;
  const voiceAccounts = usableAccounts(providers, "tts");
  const renderAccounts = usableAccounts(providers, "render");
  const workspaceGridClass = leftCollapsed && rightCollapsed
    ? "lg:grid-cols-[36px_minmax(0,1fr)_36px]"
    : leftCollapsed
      ? "lg:grid-cols-[36px_minmax(0,1fr)_260px]"
      : rightCollapsed
        ? "lg:grid-cols-[240px_minmax(0,1fr)_36px]"
        : "lg:grid-cols-[240px_minmax(0,1fr)_260px]";
  const mediaScale = MEDIA_SCALE_STEPS[mediaScaleIdx]!;
  const visibleLibrary = libraryExpanded ? mediaLibrary : mediaLibrary.slice(0, LIBRARY_PREVIEW_LIMIT);
  const selectedSceneIndex = selectedScene ? orderedScenes.findIndex((scene) => scene.sceneId === selectedScene.sceneId) : -1;

  return (
    <div className="-m-7 flex min-h-[calc(100vh-var(--lyx-topbar))] flex-col">
      <div className="border-b border-lyx-border bg-lyx-bg px-5 py-3">
      <PageHeader
        title={t("studioPro.pageTitle")}
        breadcrumb={`${timelineStatus === "approved" ? t("studioPro.timelineApproved") : t("studioPro.timelineDraft")} · ${saving ? t("studioPro.saving") : dirty ? t("common.save") : t("studioPro.saved")}`}
        actions={
          <>
            <button
              type="button"
              className={`lyx-btn h-9 w-9 ${leftCollapsed ? "lyx-btn-secondary" : "lyx-btn-ghost"}`}
              title={t(leftCollapsed ? "studioPro.showMediaPanel" : "studioPro.hideMediaPanel")}
              aria-pressed={!leftCollapsed}
              onClick={() => setPanel({ left: !leftCollapsed })}
            >
              {leftCollapsed ? <PanelLeftOpen size={16} strokeWidth={1.9} /> : <PanelLeftClose size={16} strokeWidth={1.9} />}
            </button>
            <button
              type="button"
              className={`lyx-btn h-9 w-9 ${rightCollapsed ? "lyx-btn-secondary" : "lyx-btn-ghost"}`}
              title={t(rightCollapsed ? "studioPro.showInspectorPanel" : "studioPro.hideInspectorPanel")}
              aria-pressed={!rightCollapsed}
              onClick={() => setPanel({ right: !rightCollapsed })}
            >
              {rightCollapsed ? <PanelRightOpen size={16} strokeWidth={1.9} /> : <PanelRightClose size={16} strokeWidth={1.9} />}
            </button>
            <span className="mx-1 h-6 w-px bg-lyx-border" aria-hidden />
            <span className="flex overflow-hidden rounded-[7px] bg-lyx-muted p-0.5">
              <span className="px-3 text-[11.5px] leading-8 text-lyx-fg-muted">{t("studioPro.autoTag")}</span>
              <span className="rounded-[5px] bg-lyx-fg px-3 text-[11.5px] leading-8 text-lyx-bg">{t("studioPro.studioTag")}</span>
            </span>
            <span className="flex overflow-hidden rounded-[7px] border border-lyx-border">
              <button type="button" className="h-9 w-8 text-lyx-fg-muted disabled:opacity-30" title={t("studioPro.undo")} disabled={!undoStack.current.canUndo()} onClick={handleUndo}>↶</button>
              <button type="button" className="h-9 w-8 border-l border-lyx-border text-lyx-fg-muted disabled:opacity-30" title={t("studioPro.redo")} disabled={!undoStack.current.canRedo()} onClick={handleRedo}>↷</button>
            </span>
            {!isVideoProduction ? (
              <Button variant="secondary" onClick={() => navigate(`/jobs/${id}/studio/templates`)}>
                {template ? t("studioPro.changeTemplate") : t("studioPro.openTemplates")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              disabled={approving || dirty || !baseVersionId || timelineStatus === "approved"}
              onClick={() => void submitApprove()}
            >
              {timelineStatus === "approved" ? t("studioPro.timelineApproved") : t("studioPro.approveTimeline")}
            </Button>
            <Button variant="secondary" onClick={() => setShowReview((prev) => !prev)}>
              {t("studioPro.reviewBeforeRender")}
            </Button>
            <Select className="h-9" value={renderAccountId} onChange={(event) => setRenderAccountId(event.target.value)} disabled={renderAccounts.length === 0}>
              {renderAccounts.length === 0 ? <option value="">{t("studioPro.noAccountForRole", { role: "Creatomate" })}</option> : null}
              {renderAccounts.map((account) => (
                <option key={account.id} value={account.id}>{account.name}</option>
              ))}
            </Select>
            <Button
              disabled={renderSubmitting || dirty || timelineStatus !== "approved" || !renderAccountId || (preview ? !preview.ready : false)}
              title={dirty ? t("studioPro.submitRenderDirtyHint") : undefined}
              onClick={() => void submitRender()}
            >
              {t("studioPro.submitRender")}
            </Button>
          </>
        }
      />
      </div>
      <div className="flex flex-col gap-2 px-5 pt-3">
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {conflict ? (
        <Banner variant="warn">
          {t("studioPro.conflict")} <button type="button" className="underline" onClick={reloadAfterConflict}>{t("studioPro.reload")}</button>
        </Banner>
      ) : null}
      {preview && !preview.ready ? <Banner variant="warn">{t("studioPro.approxPreviewMissing", { keys: preview.missingRequiredModificationKeys.join(", ") })}</Banner> : null}
      {renderJob ? <RenderProgress job={renderJob} /> : null}
      </div>

      {/* VE2E-13: resultUrl plays only here, inside Studio - never as direct autoplay from a
          channel/job list (see ChannelsPage.tsx's video grid, which now routes here instead of
          opening resultUrl directly). Explicit loading/error/unsupported-browser states replace
          the previous plain "open in a new tab" link, which some browsers/CDN response headers
          made effectively unviewable (download instead of inline playback, or a silent failure
          with no feedback at all). */}
      {renderJob?.status === "completed" && renderJob.resultUrl ? (
        <div className="mx-5 mb-2 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-3">
          <p className="mb-2 text-[12px] font-medium">{t("studioPro.renderResultTitle")}</p>
          {typeof HTMLVideoElement === "undefined" ? (
            <Banner variant="warn">{t("studioPro.renderPlaybackUnsupported")}</Banner>
          ) : renderPlaybackError ? (
            <Banner variant="danger">{t("studioPro.renderPlaybackError")}</Banner>
          ) : (
            <video
              key={renderJob.resultUrl}
              className="mb-2 max-h-[360px] w-full rounded-[6px] bg-black"
              src={renderJob.resultUrl}
              controls
              onError={() => setRenderPlaybackError(true)}
            />
          )}
          <div className="flex gap-3 text-[11.5px]">
            <a className="underline" href={renderJob.resultUrl} target="_blank" rel="noreferrer">{t("studioPro.openResult")}</a>
            <a className="underline" href={renderJob.resultUrl} download>{t("studioPro.downloadResult")}</a>
          </div>
        </div>
      ) : renderJob && renderJob.status !== "failed" && renderJob.status !== "cancelled" ? (
        <div className="mx-5 mb-2 text-[11.5px] text-lyx-fg-muted">{t("studioPro.renderResultLoading")}</div>
      ) : null}

      {showReview ? (
        <div className="mx-5 mb-2 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[12px] font-medium">{t("studioPro.reviewTitle")}</p>
            <button type="button" className="text-[11px] underline" onClick={() => setShowReview(false)}>{t("studioPro.reviewClose")}</button>
          </div>
          <div className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 lg:grid-cols-6">
            {orderedScenes.map((scene, index) => {
              const bound = draft.scenes.find((row) => row.sceneId === scene.sceneId);
              const url = bound?.mediaAssetVersionId ? thumbCache[bound.mediaAssetVersionId] : undefined;
              const audio = audioBySceneId[scene.sceneId];
              const excluded = Boolean(bound?.excluded);
              return (
                <button
                  key={scene.sceneId}
                  type="button"
                  onClick={() => setSelectedSceneId(scene.sceneId)}
                  className={`border border-lyx-border p-1.5 text-left text-[10px] ${excluded ? "opacity-40" : ""} ${scene.sceneId === selectedSceneId ? "border-lyx-fg" : ""}`}
                >
                  <div className="mb-1 flex h-16 items-center justify-center overflow-hidden rounded-[4px] bg-lyx-muted text-lyx-fg-muted">
                    {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : t("studioPro.noMedia")}
                  </div>
                  <p className="mb-0.5 line-clamp-2 font-medium">{index + 1}. {bound?.screenTextOverride || scene.screenText}</p>
                  <p className="text-lyx-fg-muted">
                    {excluded
                      ? t("studioPro.excludedLabel")
                      : audio
                        ? t("studioPro.audioDuration", { seconds: Math.round(audio.durationMs / 1000) })
                        : bound?.audioVersionId
                          ? t("studioPro.audioStatusCompleted")
                          : t("studioPro.reviewNoAudio")}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className={`mx-5 mb-5 grid min-h-0 flex-1 gap-0 overflow-hidden rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg ${workspaceGridClass}`}>
        {leftCollapsed ? (
          <div className="hidden items-start justify-center border-b border-lyx-border py-2 lg:flex lg:border-b-0 lg:border-r">
            <button type="button" className="lyx-btn lyx-btn-ghost h-8 w-8" title={t("studioPro.showMediaPanel")} onClick={() => setPanel({ left: false })}>
              <PanelLeftOpen size={15} strokeWidth={1.9} />
            </button>
          </div>
        ) : null}
        <div className={`${leftCollapsed ? "lg:hidden" : ""} flex max-h-[calc(100vh-var(--lyx-topbar)-88px)] flex-col border-b border-lyx-border lg:border-b-0 lg:border-r`}>
          <div className="flex gap-4 border-b border-lyx-border px-3 pt-2">
            {(["script", "voice", "media"] as LeftTab[]).map((tabKey) => (
              <button
                key={tabKey}
                type="button"
                onClick={() => setLeftTab(tabKey)}
                className={`pb-2 text-[12px] ${leftTab === tabKey ? "border-b-2 border-lyx-fg font-medium text-lyx-fg" : "text-lyx-fg-muted"}`}
              >
                {t(`studioPro.tab${tabKey.charAt(0).toUpperCase()}${tabKey.slice(1)}`)}
              </button>
            ))}
          </div>

          {leftTab === "media" ? (
            <div className="flex flex-col gap-3 overflow-y-auto p-3">
              <Select value={visualAccountId} onChange={(event) => setVisualAccountId(event.target.value)} disabled={visualAccounts.length === 0}>
                {visualAccounts.length === 0 ? <option value="">{t("studioPro.noAccountForRole", { role: "Pexels" })}</option> : null}
                {visualAccounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </Select>
              <label className="flex items-center justify-between gap-2 text-[11px] text-lyx-fg-muted">
                <span>{t("studioPro.backgroundSegments")}</span>
                <Select value={segmentCount} onChange={(event) => setSegmentCount(event.target.value)} disabled={mediaPlanBusy}>
                  <option value="auto">{t("studioPro.backgroundSegmentsAuto")}</option>
                  {[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{t("studioPro.backgroundSegmentsFixed", { count })}</option>)}
                </Select>
              </label>
              <Button disabled={(!visualAccountId && !apifyAccountId) || mediaPlanBusy} onClick={() => void autoFillAllMedia()}>
                {mediaPlanBusy ? t("studioPro.mediaPlanning") : t("studioPro.autoFillMedia")}
              </Button>
              <p className="text-[10px] text-lyx-fg-muted">{t("studioPro.autoFillMediaHint")}</p>
              {draft.segments.length ? (
                <div className="flex flex-col gap-2 border-y border-lyx-border py-2">
                  <p className="text-[11px] font-medium">{t("studioPro.backgroundSegments")}</p>
                  {draft.scenes.find((row) => row.sceneId === selectedScene?.sceneId)?.segmentId ? (
                    <div role="radiogroup" aria-label={t("studioPro.mediaScope")} className="flex flex-wrap items-center gap-3 text-[10px]">
                      <span className="text-lyx-fg-muted">{t("studioPro.mediaScope")}</span>
                      {(["segment", "scene"] as const).map((scope) => (
                        <label key={scope} className="flex items-center gap-1">
                          <input type="radio" name="media-scope" checked={mediaScope === scope} onChange={() => setMediaScope(scope)} />
                          {t(scope === "scene" ? "studioPro.mediaScopeScene" : "studioPro.mediaScopeSegment")}
                        </label>
                      ))}
                    </div>
                  ) : null}
                  {draft.segments.map((segment, index) => {
                    const sourceId = segment.mediaAssetVersionId ?? draft.scenes.find((scene) => segment.sceneIds.includes(scene.sceneId))?.mediaAssetVersionId ?? null;
                    const source = sourceId ? mediaAssetById.get(sourceId) : undefined;
                    const diagnostic = mediaPlanDiagnostics.find((row) => row.segmentId === segment.segmentId);
                    const visualSegment = context.visualPlan?.segments.find((row) => row.segmentId === segment.segmentId);
                    const selectedInSegment = segment.sceneIds.includes(selectedScene?.sceneId ?? "");
                    return (
                      <div key={segment.segmentId} className={`rounded border p-2 text-[10px] ${selectedInSegment ? "border-lyx-fg" : "border-lyx-border"}`}>
                        <div className="flex items-start justify-between gap-2">
                          <button type="button" className="text-left font-medium" onClick={() => setSelectedSceneId(segment.sceneIds[0] ?? null)}>{index + 1}. {segment.subject || visualSegment?.subject || t("studioPro.segmentFallback")}</button>
                          <span className="text-lyx-fg-muted">{segment.sceneIds.length} {t("studioPro.scenesShort")}</span>
                        </div>
                        {source ? <p className="mt-1 truncate text-lyx-fg-muted">{source.origin === "apify" ? `⚠ ${t("studioPro.ownerAcceptedRisk")}` : source.originalFileName}</p> : null}
                        {diagnostic?.sourcing === "failed" ? <p className="mt-1 text-lyx-danger">{t("studioPro.segmentSourceMissing")}</p> : null}
                        {diagnostic ? <SourceBadge diagnostic={diagnostic} /> : null}
                        {(() => {
                          const shortfall = selectedInSegment && source?.kind === "video" ? inPointShortfall(draft.scenes, segment, source.durationMs, segmentInPoints[segment.segmentId] ?? 0) : null;
                          return shortfall ? <p role="alert" className="mt-1 text-amber-500">⚠ {t("studioPro.inPointShortfall", { seconds: (shortfall.shortByMs / 1000).toFixed(1) })}</p> : null;
                        })()}
                        {selectedInSegment && source?.kind === "video" ? (
                          <label className="mt-2 flex items-center gap-2 text-lyx-fg-muted">
                            {t("studioPro.segmentInPoint")}
                            <input aria-label={t("studioPro.segmentInPoint")} type="number" min={0} max={Math.max(0, source.durationMs ?? 0)} step={500} value={segmentInPoints[segment.segmentId] ?? 0} onChange={(event) => setSegmentInPoints((prev) => ({ ...prev, [segment.segmentId]: Math.max(0, Number(event.target.value) || 0) }))} className="h-7 w-24 rounded border border-lyx-border bg-lyx-muted px-1" /> ms
                            <Button variant="secondary" onClick={() => {
                              mutate((prev) => ({ ...prev, ...replaceSegmentSource(prev.scenes, prev.segments, segment.segmentId, { id: source.id, kind: source.kind as "video" | "image", durationMs: source.durationMs }, segmentInPoints[segment.segmentId] ?? 0) }));
                            }}>{t("studioPro.applyInPoint")}</Button>
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <p className="border-t border-lyx-border pt-2 text-[10px] text-lyx-fg-muted">{t("studioPro.perSceneOverrideHint")}</p>
              <Select aria-label={t("studioPro.manualMediaType")} value={manualMediaType} onChange={(event) => setManualMediaType(event.target.value as PexelsMediaType)}>
                <option value="video">{t("studioPro.videoMedia")}</option>
                <option value="photo">{t("studioPro.photoMedia")}</option>
              </Select>
              <div className="flex gap-1.5">
                <input
                  value={pexelsQuery}
                  onChange={(event) => setPexelsQuery(event.target.value)}
                  placeholder={t("studioPro.pexelsSearchPlaceholder")}
                  className="h-9 flex-1 rounded-[4px] border border-lyx-border bg-lyx-muted px-2 text-[12px]"
                />
                <Button variant="secondary" disabled={pexelsSearching || !visualAccountId} onClick={() => void runPexelsSearch()}>
                  {pexelsSearching ? t("studioPro.aiSearchRunning") : t("studioPro.search")}
                </Button>
              </div>
              {selectedScene ? (
                <div className="flex flex-wrap gap-2 text-[10px] text-lyx-fg-muted">
                  {(() => {
                    const visualSegment = context.visualPlan?.segments.find((row) => row.sceneIds.includes(selectedScene.sceneId));
                    const keywords = [{ lang: "en", value: visualSegment?.keywords.en }, { lang: "ja", value: visualSegment?.keywords.ja }].filter((row): row is { lang: string; value: string } => Boolean(row.value?.trim()));
                    const queries = keywords.length ? keywords : [{ lang: "", value: selectedScene.visualQuery }];
                    return queries.map((row) => <button key={row.lang || row.value} type="button" className="underline" onClick={() => { setPexelsQuery(row.value); void runPexelsSearch(row.value); }}>{row.lang ? `${row.lang}: ` : ""}{row.value}</button>);
                  })()}
                </div>
              ) : null}
              <details className="rounded-[4px] border border-lyx-border p-2">
                <summary className="cursor-pointer text-[11px] font-medium">{t("studioPro.apifyTab")}</summary>
                <div className="mt-2">
                  <ApifyMediaTab
                    projectId={context.projectId}
                    accountId={apifyAccountId}
                    visualPlan={context.visualPlan}
                    selectedSceneId={selectedSceneId}
                    onImported={(asset, label) => {
                      setMediaLibrary((prev) => [asset, ...prev]);
                      applyImportedAsset(asset, label);
                    }}
                  />
                </div>
              </details>
              <Button variant="secondary" disabled title={t("common.comingSoon")} onClick={() => fileInputRef.current?.click()}>
                {t("studioPro.uploadReplace")}
              </Button>
              <input ref={fileInputRef} type="file" accept="image/*,video/*" className="hidden" disabled />

              {pexelsResults ? (
                <div>
                  <p className="mb-1 text-[11px] text-lyx-fg-muted">{t("studioPro.suggested")}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {pexelsResults.videos.map((video) => (
                      <button
                        key={video.externalId}
                        type="button"
                        onClick={() => void importPexelsResult(video.externalId, `Pexels ${video.attribution.photographerName}`, "video")}
                        className="relative overflow-hidden rounded-[4px] border border-lyx-border bg-lyx-muted"
                        style={{ aspectRatio: "9 / 16" }}
                        title={`${video.attribution.photographerName} · ${video.attribution.pexelsPageUrl}`}
                      >
                        <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                        <span className="absolute bottom-1 left-1 rounded-[3px] bg-lyx-bg/90 px-1 text-[8px]">{video.attribution.photographerName}</span>
                      </button>
                    ))}
                    {pexelsResults.photos.map((photo) => (
                      <button
                        key={photo.externalId}
                        type="button"
                        onClick={() => void importPexelsResult(photo.externalId, `Pexels ${photo.attribution.photographerName}`, "photo")}
                        className="relative overflow-hidden rounded-[4px] border border-lyx-border bg-lyx-muted"
                        style={{ aspectRatio: "9 / 16" }}
                        title={`${photo.attribution.photographerName} · ${photo.attribution.pexelsPageUrl}`}
                      >
                        <img src={photo.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                        <span className="absolute bottom-1 left-1 rounded-[3px] bg-lyx-bg/90 px-1 text-[8px]">{photo.attribution.photographerName}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-[11px] text-lyx-fg-muted">{t("studioPro.library")}</p>
                  {mediaLibrary.length > LIBRARY_PREVIEW_LIMIT ? (
                    <button type="button" className="text-[10px] underline" onClick={() => setLibraryExpanded((prev) => !prev)}>
                      {libraryExpanded ? t("studioPro.libraryCollapse") : t("studioPro.libraryShowAll", { count: mediaLibrary.length })}
                    </button>
                  ) : null}
                </div>
                <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto">
                  {visibleLibrary.map((asset) => {
                    const url = thumbCache[asset.id];
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => assignMediaToSelectedScene({ id: asset.id, label: asset.originalFileName })}
                        className={`relative flex aspect-[9/16] items-center justify-center overflow-hidden rounded-[7px] border bg-lyx-muted text-[9px] text-lyx-fg-muted ${
                          selectedSceneDraft?.mediaAssetVersionId === asset.id ? "border-2 border-lyx-fg" : "border-lyx-border"
                        }`}
                        title={asset.originalFileName}
                      >
                        {url && (asset.kind === "image" || asset.kind === "video") ? <LazyThumb kind={asset.kind} url={url} className="h-full w-full" /> : null}
                        <span className="absolute bottom-1 left-1 rounded-[3px] bg-lyx-bg/90 px-1 text-[8px] font-bold">{asset.origin}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}

          {leftTab === "script" ? (
            <div className="flex flex-col gap-2 overflow-y-auto p-3 text-[12px]">
              {scenes.map((scene) => (
                <p key={scene.sceneId} className={scene.sceneId === selectedSceneId ? "font-medium text-lyx-fg" : "text-lyx-fg-muted"}>
                  {scene.narration}
                </p>
              ))}
            </div>
          ) : null}

          {leftTab === "voice" ? (
            <div className="flex flex-col gap-2 overflow-y-auto p-3 text-[12px]">
              <Select value={voiceAccountId} onChange={(event) => setVoiceAccountId(event.target.value)} disabled={voiceAccounts.length === 0}>
                {voiceAccounts.length === 0 ? <option value="">{t("studioPro.noAccountForRole", { role: "ElevenLabs" })}</option> : null}
                {voiceAccounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </Select>
              <Select value={selectedVoiceId} onChange={(event) => setSelectedVoiceId(event.target.value)} disabled={voices.length === 0}>
                {voices.map((voice) => (
                  <option key={voice.voiceId} value={voice.voiceId}>{voice.name}</option>
                ))}
              </Select>
              <Button variant="secondary" disabled={!voices.find((row) => row.voiceId === selectedVoiceId)?.previewUrl} onClick={playVoicePreview}>
                {t("studioPro.previewVoice")}
              </Button>
              <Button disabled={!voiceAccountId || !selectedVoiceId || !!voiceApplyBusy} onClick={() => void applyVoiceToAllScenes()}>
                {voiceApplyBusy ? t("studioPro.applyingVoiceAll", { done: voiceApplyBusy.done, total: voiceApplyBusy.total }) : t("studioPro.applyVoiceAll")}
              </Button>
              {audioNotice ? <p className="text-lyx-danger">{audioNotice}</p> : null}

              <p className="border-t border-lyx-border pt-2 text-[10px] text-lyx-fg-muted">{t("studioPro.perSceneOverrideHint")}</p>
              <Button
                variant="secondary"
                disabled={!selectedScene || !voiceAccountId || !selectedVoiceId || audioBusySceneId === selectedScene?.sceneId}
                onClick={() => void generateAudioForSelectedScene()}
              >
                {audioBusySceneId === selectedScene?.sceneId ? t("studioPro.generatingAudio") : t("studioPro.generateAudio")}
              </Button>
              {selectedScene && audioBySceneId[selectedScene.sceneId] ? (
                <p className="text-lyx-fg-muted">{t("studioPro.audioStatusCompleted")} · {t("studioPro.audioDuration", { seconds: Math.round(audioBySceneId[selectedScene.sceneId]!.durationMs / 1000) })}</p>
              ) : selectedSceneDraft?.audioVersionId ? (
                <p className="text-lyx-fg-muted">{t("studioPro.audioStatusCompleted")}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-lyx-border px-3 py-1.5">
            <div className="flex items-center gap-1.5">
              <button type="button" className="lyx-btn lyx-btn-ghost h-8 w-8" title={playing ? t("studioPro.pause") : t("studioPro.play")} onClick={togglePlay} disabled={!selectedMediaAsset && !selectedAudio}>
                {playing ? <Pause size={15} strokeWidth={1.9} /> : <Play size={15} strokeWidth={1.9} />}
              </button>
              <span className="hidden text-[11px] text-lyx-fg-muted xl:inline">{t("studioPro.previewPlaybackHint")}</span>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                className={`lyx-btn h-8 gap-1.5 px-2.5 text-[11.5px] ${sdkState !== "off" ? "lyx-btn-secondary" : "lyx-btn-ghost"}`}
                aria-pressed={sdkState !== "off"}
                onClick={toggleSdkPreview}
                title={t("studioPro.sdkPreviewToggleHint")}
              >
                {t("studioPro.sdkPreviewToggle")}
              </button>
              <button
                type="button"
                className={`lyx-btn h-8 gap-1.5 px-2.5 text-[11.5px] ${tiktokFrame ? "lyx-btn-secondary" : "lyx-btn-ghost"}`}
                aria-pressed={tiktokFrame}
                onClick={() => setTiktokFrame((prev) => !prev)}
                title={t("studioPro.tiktokFrameHint")}
              >
                <Smartphone size={14} strokeWidth={1.9} /> {t("studioPro.tiktokFrame")}
              </button>
              <div className="flex items-center overflow-hidden rounded-[7px] border border-lyx-border" title={t("studioPro.scaleScene")}>
                <button type="button" className="flex h-8 w-7 items-center justify-center text-lyx-fg-muted disabled:opacity-30" disabled={mediaScaleIdx === 0} onClick={() => zoomMediaScale(-1)}>
                  <ZoomOut size={13} strokeWidth={1.9} />
                </button>
                <span className="w-14 border-x border-lyx-border text-center text-[10.5px] text-lyx-fg-muted">{t("studioPro.scaleSceneShort")} {Math.round(mediaScale * 100)}%</span>
                <button type="button" className="flex h-8 w-7 items-center justify-center text-lyx-fg-muted disabled:opacity-30" disabled={mediaScaleIdx === MEDIA_SCALE_STEPS.length - 1} onClick={() => zoomMediaScale(1)}>
                  <ZoomIn size={13} strokeWidth={1.9} />
                </button>
              </div>
              <div className="flex items-center overflow-hidden rounded-[7px] border border-lyx-border" title={t("studioPro.previewZoom")}>
                <button type="button" className="flex h-8 w-7 items-center justify-center text-lyx-fg-muted disabled:opacity-30" disabled={previewZoomIdx === 0} onClick={() => zoomPreview(-1)}>
                  <ZoomOut size={13} strokeWidth={1.9} />
                </button>
                <span className="w-10 border-x border-lyx-border text-center text-[10.5px] text-lyx-fg-muted">{Math.round((PREVIEW_ZOOM_STEPS[previewZoomIdx]! / PREVIEW_ZOOM_STEPS[1]!) * 100)}%</span>
                <button type="button" className="flex h-8 w-7 items-center justify-center text-lyx-fg-muted disabled:opacity-30" disabled={previewZoomIdx === PREVIEW_ZOOM_STEPS.length - 1} onClick={() => zoomPreview(1)}>
                  <ZoomIn size={13} strokeWidth={1.9} />
                </button>
              </div>
            </div>
          </div>

          <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center overflow-auto bg-lyx-muted px-4 py-5">
            <div
              className="relative overflow-hidden rounded-[14px] bg-[#161616] text-center shadow-[0_12px_28px_rgba(0,0,0,0.18)]"
              style={{ width: PREVIEW_ZOOM_STEPS[previewZoomIdx], aspectRatio: "1080 / 1920" }}
            >
              {/* VE2E-13: always mounted (never conditionally unmounted) once the user opts in, so
                  the underlying Creatomate iframe/state survives toggling other preview controls -
                  only `display` changes with `sdkState`. */}
              <div
                ref={sdkContainerRef}
                className="absolute inset-0"
                style={{ display: sdkState === "loading" || sdkState === "empty" || sdkState === "ready" ? "block" : "none" }}
              />
              {sdkState === "loading" || sdkState === "empty" ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/55 text-[11px] text-white/80">
                  {sdkState === "loading" ? t("studioPro.sdkLoading") : t("studioPro.sdkEmpty")}
                </div>
              ) : null}
              {sdkState !== "ready" ? (
                <>
                  <div className="absolute inset-0 flex items-center justify-center" style={{ transform: `scale(${mediaScale})`, transformOrigin: "center center" }}>
                    {selectedMediaAsset?.kind === "video" && thumbCache[selectedMediaAsset.id] ? (
                      <video
                        key={selectedMediaAsset.id}
                        ref={previewVideoRef}
                        src={thumbCache[selectedMediaAsset.id]}
                        muted
                        playsInline
                        loop
                        onLoadedMetadata={(event) => {
                          const start = selectedSceneDraft?.sourceStartMs ?? 0;
                          const duration = selectedSceneDraft?.sourceDurationMs;
                          event.currentTarget.currentTime = start / 1000;
                          if (duration != null) event.currentTarget.loop = false;
                        }}
                        onTimeUpdate={(event) => {
                          const start = selectedSceneDraft?.sourceStartMs ?? 0;
                          const duration = selectedSceneDraft?.sourceDurationMs;
                          if (duration != null && event.currentTarget.currentTime >= (start + duration) / 1000) {
                            event.currentTarget.pause();
                            event.currentTarget.currentTime = start / 1000;
                            setPlaying(false);
                          }
                        }}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : selectedMediaAsset?.kind === "image" && thumbCache[selectedMediaAsset.id] ? (
                      <img src={thumbCache[selectedMediaAsset.id]} alt="" className="absolute inset-0 h-full w-full object-cover" />
                    ) : (
                      <span className="px-4 text-[11px] text-white/40">{t("common.previewLabel")}</span>
                    )}
                  </div>
                  {selectedAudio ? <audio key={selectedAudio.id} ref={previewAudioTrackRef} src={thumbCache[selectedAudio.mediaAssetVersionId]} className="hidden" /> : null}
                  {tiktokFrame ? (
                    <>
                      <div className="absolute inset-x-0 top-0 flex h-[12%] items-center justify-center border-b border-dashed border-white/50 bg-black/10">
                        <span className="rounded bg-black/45 px-1.5 py-0.5 text-[8px] text-white">{t("studioPro.tiktokZoneTop")}</span>
                      </div>
                      <div className="absolute inset-y-0 right-0 flex w-[16%] items-center justify-center border-l border-dashed border-white/50 bg-black/10">
                        <span className="rotate-90 whitespace-nowrap rounded bg-black/45 px-1.5 py-0.5 text-[8px] text-white">{t("studioPro.tiktokZoneActions")}</span>
                      </div>
                      <div className="absolute inset-x-0 bottom-0 right-[16%] flex h-[20%] items-end justify-center border-t border-dashed border-white/50 bg-black/10 pb-2">
                        <span className="rounded bg-black/45 px-1.5 py-0.5 text-[8px] text-white">{t("studioPro.tiktokZoneCaption")}</span>
                      </div>
                    </>
                  ) : null}
                  {selectedScene ? (
                    <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-3 pb-3 pt-8 text-[12px] font-bold text-white">
                      {selectedSceneDraft?.screenTextOverride || selectedScene.screenText || "…"}
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
            <p className="mt-2 text-center text-[10px] text-lyx-fg-subtle">
              {sdkState === "ready" ? t("studioPro.sdkReadyHint") : t("studioPro.scaleHint")}
            </p>
            {sdkState === "unsupported" ? <p className="text-center text-[10px] text-lyx-warn">{t("studioPro.sdkUnsupported")}</p> : null}
            {sdkState === "not_configured" ? <p className="text-center text-[10px] text-lyx-warn">{t("studioPro.sdkNotConfigured")}</p> : null}
            {sdkState === "error" ? <p className="text-center text-[10px] text-lyx-danger">{t("studioPro.sdkError")}</p> : null}
          </div>

          <div className="shrink-0 border-t border-lyx-border bg-lyx-bg px-3 pb-3 pt-2">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-lyx-fg-muted">
              <div className="flex flex-wrap items-center gap-2">
                <span>{t("studioPro.timelineSummary", { scenes: orderedScenes.length, seconds: totalSeconds })}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf2e3] px-2 py-0.5 text-[10.5px] font-semibold text-[#b45309]">
                  🔇 {t("studioPro.muteNote")}
                </span>
              </div>
              <div className="flex items-center overflow-hidden rounded-[7px] border border-lyx-border">
                <button type="button" className="flex h-7 w-7 items-center justify-center text-lyx-fg-muted disabled:opacity-30" disabled={timelineZoomIdx === 0} onClick={() => zoomTimeline(-1)}>
                  <ZoomOut size={12} strokeWidth={1.9} />
                </button>
                <button type="button" className="flex h-7 w-7 items-center justify-center border-l border-lyx-border text-lyx-fg-muted disabled:opacity-30" disabled={timelineZoomIdx === TIMELINE_PX_PER_SECOND.length - 1} onClick={() => zoomTimeline(1)}>
                  <ZoomIn size={12} strokeWidth={1.9} />
                </button>
              </div>
            </div>

            <div className="flex gap-2">
              <div className="flex w-[84px] shrink-0 flex-col gap-1 text-[10px] font-bold uppercase tracking-wide text-lyx-fg-subtle">
                <div className="flex h-[52px] items-center">{t("studioPro.trackVideo")}</div>
                <div className="flex h-[30px] items-center">{t("studioPro.trackVoice")}</div>
                <div className="flex h-4 items-center">{t("studioPro.trackMusic")}</div>
              </div>
              <div className="min-w-0 flex-1 overflow-x-auto">
                <div className="flex w-max flex-col gap-1">
                  <div className="flex gap-1">
                    {orderedScenes.map((scene, index) => {
                      const bound = draft.scenes.find((row) => row.sceneId === scene.sceneId);
                      const url = bound?.mediaAssetVersionId ? thumbCache[bound.mediaAssetVersionId] : undefined;
                      const asset = bound?.mediaAssetVersionId ? mediaAssetById.get(bound.mediaAssetVersionId) : undefined;
                      const segmentIndex = bound?.segmentId ? draft.segments.findIndex((row) => row.segmentId === bound.segmentId) : -1;
                      const excluded = Boolean(bound?.excluded);
                      const clipWidth = Math.max(56, Math.round((scene.durationHintMs / 1000) * TIMELINE_PX_PER_SECOND[timelineZoomIdx]! * 4));
                      return (
                        <button
                          key={scene.sceneId}
                          type="button"
                          onClick={() => setSelectedSceneId(scene.sceneId)}
                          title={`${index + 1} · ${Math.round(scene.durationHintMs / 1000)}s${segmentIndex >= 0 ? ` · ${t("studioPro.backgroundSegments")} ${segmentIndex + 1}` : ""}`}
                          className={`relative h-[52px] shrink-0 overflow-hidden rounded-[6px] border text-left ${segmentIndex >= 0 ? "border-violet-400" : ""} ${excluded ? "opacity-35" : ""} ${
                            scene.sceneId === selectedScene?.sceneId ? "outline outline-2 outline-offset-1 outline-lyx-fg" : "border-lyx-border"
                          }`}
                          style={{ width: clipWidth, background: "linear-gradient(160deg,#3a3a38,#1c1c1b)" }}
                        >
                          {url ? (
                            <LazyThumb kind={asset?.kind === "video" ? "video" : "image"} url={url} className="absolute inset-0 h-full w-full opacity-80" />
                          ) : null}
                          {asset?.kind === "video" || (!asset && bound?.mediaAssetVersionId) ? (
                            <span className="absolute right-1 top-1 rounded bg-black/50 px-1 text-[9px] text-white" title={t("studioPro.originalAudioMutedHint")}>🔇</span>
                          ) : null}
                          {segmentIndex >= 0 ? <span className="absolute left-1 top-1 rounded bg-violet-700/85 px-1 text-[8px] font-semibold text-white">B{segmentIndex + 1}</span> : null}
                          <span className="absolute bottom-1 left-1 rounded bg-black/35 px-1 text-[9px] font-bold text-white">
                            {index + 1} · {Math.round(scene.durationHintMs / 1000)}s
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex gap-1">
                    {orderedScenes.map((scene) => {
                      const bound = draft.scenes.find((row) => row.sceneId === scene.sceneId);
                      const audio = audioBySceneId[scene.sceneId];
                      const hasAudio = Boolean(bound?.audioVersionId);
                      const excluded = Boolean(bound?.excluded);
                      const clipWidth = Math.max(56, Math.round((scene.durationHintMs / 1000) * TIMELINE_PX_PER_SECOND[timelineZoomIdx]! * 4));
                      return (
                        <button
                          key={scene.sceneId}
                          type="button"
                          title={hasAudio ? t("studioPro.audioStatusCompleted") : t("studioPro.trackVoiceEmptyHint")}
                          onClick={() => {
                            setSelectedSceneId(scene.sceneId);
                            setLeftTab("voice");
                          }}
                          className={`flex h-[30px] shrink-0 items-center justify-center rounded-[6px] text-[9px] ${excluded ? "opacity-35" : ""} ${
                            scene.sceneId === selectedScene?.sceneId ? "outline outline-2 outline-offset-1 outline-lyx-fg" : "border border-lyx-border"
                          } ${hasAudio ? "bg-[repeating-linear-gradient(90deg,#dfe6e2_0,#dfe6e2_2px,#eef3f1_2px,#eef3f1_5px)]" : "border-dashed bg-lyx-muted text-lyx-fg-subtle"}`}
                          style={{ width: clipWidth }}
                        >
                          {hasAudio ? (audio ? `${Math.round(audio.durationMs / 1000)}s` : "···") : t("studioPro.trackVoiceEmpty")}
                        </button>
                      );
                    })}
                  </div>
                  <div
                    className="h-4 rounded-[5px] border border-lyx-border"
                    style={{
                      width: Math.max(120, orderedScenes.reduce((sum, scene) => sum + Math.max(56, Math.round((scene.durationHintMs / 1000) * TIMELINE_PX_PER_SECOND[timelineZoomIdx]! * 4)), 0) + Math.max(0, orderedScenes.length - 1)),
                      background: "repeating-linear-gradient(90deg,#e7e0f2,#e7e0f2 3px,#f3eef9 3px,#f3eef9 7px)",
                    }}
                    title={t("studioPro.trackMusicHint")}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {rightCollapsed ? (
          <div className="hidden items-start justify-center border-t border-lyx-border py-2 lg:flex lg:border-t-0 lg:border-l">
            <button type="button" className="lyx-btn lyx-btn-ghost h-8 w-8" title={t("studioPro.showInspectorPanel")} onClick={() => setPanel({ right: false })}>
              <PanelRightOpen size={15} strokeWidth={1.9} />
            </button>
          </div>
        ) : null}
        <div className={`${rightCollapsed ? "lg:hidden" : ""} overflow-y-auto border-t border-lyx-border p-3 lg:border-t-0 lg:border-l`}>
          {selectedScene && selectedSceneDraft ? (
            <>
              <p className="mb-0.5 text-[13px] font-bold">
                {t("studioPro.inspectorTitle", { index: selectedSceneIndex + 1 })}
              </p>
              <p className="mb-3 text-[11px] text-lyx-fg-muted">
                {template ? `${t("studioPro.templateLabel")}: ${template.name}` : t("studioPro.noTemplate")}
              </p>
              {template?.warnings?.length ? (
                <p role="alert" className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-300">
                  {t("studioPro.templateTtsWarning", { names: template.warnings.map((warning) => warning.elementName).join(", ") })}
                </p>
              ) : null}

              <div className="mb-3 flex gap-1">
                <button type="button" title={t("studioPro.moveEarlier")} disabled={selectedSceneIndex <= 0} className="lyx-btn lyx-btn-ghost h-8 flex-1 text-[11px] disabled:opacity-30" onClick={() => moveScene(selectedScene.sceneId, -1)}>◀</button>
                <button
                  type="button"
                  title={selectedSceneDraft.excluded ? t("studioPro.includeScene") : t("studioPro.excludeScene")}
                  className="lyx-btn lyx-btn-ghost h-8 flex-1 text-[11px]"
                  onClick={() => toggleSceneExcluded(selectedScene.sceneId)}
                >
                  {selectedSceneDraft.excluded ? "↩" : "🗑"}
                </button>
                <button type="button" title={t("studioPro.moveLater")} disabled={selectedSceneIndex < 0 || selectedSceneIndex >= orderedScenes.length - 1} className="lyx-btn lyx-btn-ghost h-8 flex-1 text-[11px] disabled:opacity-30" onClick={() => moveScene(selectedScene.sceneId, 1)}>▶</button>
              </div>

              <div className="flex flex-col gap-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("studioPro.inspectorContent")}</p>
                <div>
                  <label className="mb-1 block text-[10px] text-lyx-fg-muted">{t("studioPro.fieldVideoSource")}</label>
                  <p className="truncate text-[11px]" title={selectedSceneDraft.mediaLabel ?? selectedSceneDraft.mediaAssetVersionId ?? undefined}>
                    {selectedSceneDraft.mediaLabel ?? (selectedSceneDraft.mediaAssetVersionId ? selectedSceneDraft.mediaAssetVersionId.slice(0, 8) + "…" : t("studioPro.noMedia"))}
                  </p>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] text-lyx-fg-muted">{t("studioPro.fieldCaption")}</label>
                  <TextArea
                    className="w-full"
                    value={selectedSceneDraft.screenTextOverride ?? selectedScene.screenText}
                    onChange={(event) => setScreenTextOverride(selectedScene.sceneId, event.target.value)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] text-lyx-fg-muted">{t("studioPro.fieldAnnotation")}</label>
                  <TextArea
                    className="w-full"
                    value={selectedSceneDraft.annotation ?? ""}
                    onChange={(event) => setAnnotation(selectedScene.sceneId, event.target.value)}
                  />
                </div>

                {template ? (
                  selectedSceneOptions.length > 0 || sceneOptionGroups.leftover.length > 0 ? (
                    <>
                      <p className="border-t border-lyx-border pt-2 text-[10px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("studioPro.inspectorTemplate")}</p>
                      {selectedSceneOptions.length > 0 ? (
                        selectedSceneOptions.map(renderModField)
                      ) : (
                        <p className="text-[11px] text-lyx-fg-muted">{t("studioPro.noSceneTemplateOptions")}</p>
                      )}
                      {sceneOptionGroups.leftover.length > 0 ? (
                        <>
                          <p className="border-t border-lyx-border pt-2 text-[10px] text-lyx-fg-muted">{t("studioPro.otherTemplateOptions")}</p>
                          {sceneOptionGroups.leftover.map(renderModField)}
                        </>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-[11px] text-lyx-fg-muted">{t("studioPro.noSceneTemplateOptions")}</p>
                  )
                ) : (
                  <p className="text-[11px] text-lyx-fg-muted">{t("templates.pinNote")}</p>
                )}

                {/* VE2E-26: whole-video style overrides for the dynamic render path Studio
                    actually submits through (submitDynamicRenderFromTimeline) - schema-backed
                    against the same fixed key/value whitelist the server validates on save
                    and applies identically in both the SDK preview and the final render
                    payload (`applyDynamicStyleOverrides` in @lyonix/providers). Unlike the
                    per-scene template modification fields above, these apply to every scene
                    at once (they override the template-derived caption/animation style, not
                    a specific Creatomate element), so they are not scene-dependent. */}
                {template ? (
                  <div className="flex flex-col gap-2 border-t border-lyx-border pt-2">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-lyx-fg-subtle">{t("studioPro.dynamicStyleOverrides")}</p>
                    <p className="text-[10px] text-lyx-fg-muted">{t("studioPro.dynamicStyleOverridesHint")}</p>
                    <div>
                      <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{t("studioPro.overrideCaptionFont")}</label>
                      <Select
                        className="w-full"
                        value={draft.optionValues["dynamicStyle.captionFontFamily"] ?? ""}
                        onChange={(event) => setOptionValue("dynamicStyle.captionFontFamily", event.target.value)}
                      >
                        <option value="">{t("studioPro.overrideUseTemplateDefault")}</option>
                        <option>Inter Bold</option>
                        <option>Inter Medium</option>
                        <option>Noto Sans</option>
                      </Select>
                    </div>
                    <div>
                      <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{t("studioPro.overrideCaptionColor")}</label>
                      <div className="flex items-center gap-1.5">
                        {["", "#ffffff", "#f5f5f5", "#facc15"].map((hex) => (
                          <button
                            key={hex || "default"}
                            type="button"
                            aria-label={hex || t("studioPro.overrideUseTemplateDefault")}
                            onClick={() => setOptionValue("dynamicStyle.captionFillColor", hex)}
                            className={`h-[22px] w-[22px] rounded-[4px] border ${(draft.optionValues["dynamicStyle.captionFillColor"] ?? "") === hex ? "border-lyx-fg" : "border-lyx-border"}`}
                            style={hex ? { backgroundColor: hex } : { background: "repeating-linear-gradient(45deg,#ccc,#ccc 2px,#fff 2px,#fff 4px)" }}
                          />
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{t("studioPro.overrideImageAnimation")}</label>
                      <Select
                        className="w-full"
                        value={draft.optionValues["dynamicStyle.imageAnimation"] ?? ""}
                        onChange={(event) => setOptionValue("dynamicStyle.imageAnimation", event.target.value)}
                      >
                        <option value="">{t("studioPro.overrideUseTemplateDefault")}</option>
                        <option value="pan">{t("studioPro.overrideAnimationPan")}</option>
                        <option value="none">{t("studioPro.overrideAnimationNone")}</option>
                      </Select>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <StatusPill tone="neutral">{t("common.empty")}</StatusPill>
          )}
        </div>
      </div>
    </div>
  );
}
