import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { Button, Select, TextArea } from "../components/ui";
import { api, ApiError } from "../api";
import type { ApiProvider } from "../jobs-api";
import type {
  AudioVersionResponse,
  ElevenLabsVoiceSummaryResponse,
  MediaAssetVersionSummary,
  PexelsSearchResponse,
  RenderJobResponse,
  StudioContextResponse,
  TemplateSnapshotResponse,
  TimelineOptionValues,
  TimelineRenderPreviewResponse,
} from "@lyonix/contracts";
import {
  approveTimelineVersion,
  fetchStudioContext,
  generateSceneAudio,
  getAudioGenerationOperation,
  getRenderJob,
  getTemplateSnapshot,
  importPexels,
  issueMediaDeliveryToken,
  listElevenLabsVoices,
  listProjectMedia,
  previewTimelineVersion,
  saveTimelineVersion,
  searchPexels,
  submitRenderFromTimeline,
} from "../studio/timeline-api";
import { UndoStack } from "../studio/undo-stack";

type LeftTab = "media" | "script" | "voice";

type SceneDraft = {
  sceneId: string;
  mediaAssetVersionId: string | null;
  mediaLabel: string | null;
  audioVersionId: string | null;
  subtitleVersionId: string | null;
  screenTextOverride: string | null;
  annotation: string | null;
};

type TimelineDraft = {
  templateSnapshotId: string | null;
  scenes: SceneDraft[];
  optionValues: TimelineOptionValues;
};

const draftFromContext = (context: StudioContextResponse): TimelineDraft => {
  const saved = context.latestTimelineVersion;
  const byId = new Map((saved?.scenes ?? []).map((scene) => [scene.sceneId, scene]));
  return {
    templateSnapshotId: saved?.templateSnapshotId ?? null,
    optionValues: saved?.optionValues ?? {},
    scenes: context.scenes.map((scene) => {
      const bound = byId.get(scene.sceneId);
      return {
        sceneId: scene.sceneId,
        mediaAssetVersionId: bound?.mediaAssetVersionId ?? null,
        mediaLabel: null,
        audioVersionId: bound?.audioVersionId ?? null,
        subtitleVersionId: bound?.subtitleVersionId ?? null,
        screenTextOverride: bound?.screenTextOverride ?? null,
        annotation: bound?.annotation ?? null,
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const undoStack = useRef(new UndoStack<TimelineDraft>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [context, setContext] = useState<StudioContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [mediaLibrary, setMediaLibrary] = useState<MediaAssetVersionSummary[]>([]);
  const [thumbCache, setThumbCache] = useState<Record<string, string>>({});

  const [draft, setDraft] = useState<TimelineDraft>({ templateSnapshotId: null, scenes: [], optionValues: {} });
  const [baseVersionId, setBaseVersionId] = useState<string | null>(null);
  const [timelineStatus, setTimelineStatus] = useState<"draft" | "approved" | null>(null);
  const [lastSavedJson, setLastSavedJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [approving, setApproving] = useState(false);
  const [preview, setPreview] = useState<TimelineRenderPreviewResponse | null>(null);

  const [leftTab, setLeftTab] = useState<LeftTab>("media");
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [template, setTemplate] = useState<TemplateSnapshotResponse | null>(null);

  const [visualAccountId, setVisualAccountId] = useState("");
  const [pexelsQuery, setPexelsQuery] = useState("");
  const [pexelsResults, setPexelsResults] = useState<PexelsSearchResponse | null>(null);
  const [pexelsSearching, setPexelsSearching] = useState(false);

  const [voiceAccountId, setVoiceAccountId] = useState("");
  const [voices, setVoices] = useState<ElevenLabsVoiceSummaryResponse[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [audioBySceneId, setAudioBySceneId] = useState<Record<string, AudioVersionResponse>>({});
  const [audioBusySceneId, setAudioBusySceneId] = useState<string | null>(null);
  const [audioNotice, setAudioNotice] = useState<string | null>(null);

  const [renderAccountId, setRenderAccountId] = useState("");
  const [renderJob, setRenderJob] = useState<RenderJobResponse | null>(null);
  const [renderSubmitting, setRenderSubmitting] = useState(false);

  const dirty = useMemo(() => JSON.stringify(draft) !== lastSavedJson, [draft, lastSavedJson]);

  useEffect(() => {
    if (!id) return;
    void fetchStudioContext(id)
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
    setVisualAccountId((current) => current || usableAccounts(providers, "visual")[0]?.id || "");
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

  const persist = async () => {
    if (!context) return;
    setSaving(true);
    try {
      const result = await saveTimelineVersion(context.projectId, {
        supersedesId: baseVersionId,
        templateSnapshotId: draft.templateSnapshotId,
        scenes: draft.scenes.map((scene) => ({
          sceneId: scene.sceneId,
          mediaAssetVersionId: scene.mediaAssetVersionId,
          audioVersionId: scene.audioVersionId,
          subtitleVersionId: scene.subtitleVersionId,
          screenTextOverride: scene.screenTextOverride,
          annotation: scene.annotation,
        })),
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
  const selectedScene = scenes.find((scene) => scene.sceneId === selectedSceneId) ?? scenes[0] ?? null;
  const selectedSceneDraft = draft.scenes.find((scene) => scene.sceneId === selectedSceneId) ?? null;
  const totalSeconds = Math.round(scenes.reduce((sum, scene) => sum + scene.durationHintMs, 0) / 1000);

  const assignMediaToSelectedScene = (asset: { id: string; label: string }) => {
    if (!selectedSceneId) return;
    mutate((prev) => ({
      ...prev,
      scenes: prev.scenes.map((scene) => (scene.sceneId === selectedSceneId ? { ...scene, mediaAssetVersionId: asset.id, mediaLabel: asset.label } : scene)),
    }));
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
      const results = await searchPexels(context.projectId, visualAccountId, "video", q);
      setPexelsResults(results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setPexelsSearching(false);
    }
  };

  const importPexelsResult = async (externalId: string, label: string) => {
    if (!context || !visualAccountId) return;
    try {
      const { asset } = await importPexels(context.projectId, { providerAccountId: visualAccountId, type: "video", externalId, sceneId: selectedSceneId });
      setMediaLibrary((prev) => [asset, ...prev]);
      assignMediaToSelectedScene({ id: asset.id, label });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    }
  };

  const generateAudioForSelectedScene = async () => {
    if (!context || !selectedScene || !voiceAccountId || !selectedVoiceId) return;
    setAudioBusySceneId(selectedScene.sceneId);
    setAudioNotice(null);
    try {
      const accepted = await generateSceneAudio(selectedScene.id, { providerAccountId: voiceAccountId, voiceId: selectedVoiceId }, crypto.randomUUID());
      const poll = async (operationId: string): Promise<void> => {
        const result = await getAudioGenerationOperation(operationId);
        if (result.status === "completed" && result.audioVersion) {
          setAudioBySceneId((prev) => ({ ...prev, [selectedScene.sceneId]: result.audioVersion! }));
          mutate((prev) => ({
            ...prev,
            scenes: prev.scenes.map((scene) =>
              scene.sceneId === selectedScene.sceneId
                ? { ...scene, audioVersionId: result.audioVersion!.id, subtitleVersionId: result.audioVersion!.subtitleVersion?.id ?? null }
                : scene,
            ),
          }));
          setAudioBusySceneId(null);
          return;
        }
        if (result.status === "failed") {
          setAudioNotice(t("studioPro.audioStatusFailed"));
          setAudioBusySceneId(null);
          return;
        }
        setTimeout(() => void poll(operationId), 2000);
      };
      void poll(accepted.operationId);
    } catch (err) {
      setAudioBusySceneId(null);
      setError(err instanceof ApiError ? err.message : t("common.error"));
    }
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
    if (!context || !baseVersionId || !renderAccountId) return;
    setRenderSubmitting(true);
    try {
      const job = await submitRenderFromTimeline(context.projectId, baseVersionId, { providerAccountId: renderAccountId });
      setRenderJob(job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setRenderSubmitting(false);
    }
  };

  const loadThumb = (mediaAssetVersionId: string) => {
    if (thumbCache[mediaAssetVersionId]) return;
    void issueMediaDeliveryToken(mediaAssetVersionId).then(({ url }) => setThumbCache((prev) => ({ ...prev, [mediaAssetVersionId]: url }))).catch(() => undefined);
  };

  if (needsApproval) {
    return (
      <>
        <Banner variant="warn">{t("studioPro.needScriptApproved")}</Banner>
        <Button variant="secondary" onClick={() => navigate(`/jobs/${id}`)}>{t("studioPro.backToJob")}</Button>
      </>
    );
  }
  if (error && !context) return <Banner variant="danger">{error}</Banner>;
  if (!context) return <Banner variant="info">{t("common.loading")}</Banner>;

  const visualAccounts = usableAccounts(providers, "visual");
  const voiceAccounts = usableAccounts(providers, "tts");
  const renderAccounts = usableAccounts(providers, "render");

  return (
    <>
      <PageHeader
        title={t("jobsByChannel.title")}
        breadcrumb={`${timelineStatus === "approved" ? t("studioPro.timelineApproved") : t("studioPro.timelineDraft")} · ${saving ? t("studioPro.saving") : dirty ? t("common.save") : t("studioPro.saved")}`}
        actions={
          <>
            <span className="flex overflow-hidden rounded-[4px] border border-lyx-strong">
              <span className="px-3 text-[12px] leading-10 text-lyx-fg-muted">{t("studioPro.autoTag")}</span>
              <span className="bg-lyx-fg px-3 text-[12px] leading-10 text-lyx-bg">{t("studioPro.studioTag")}</span>
            </span>
            <button type="button" className="lyx-btn lyx-btn-ghost h-10 w-10" title={t("studioPro.undo")} disabled={!undoStack.current.canUndo()} onClick={handleUndo}>
              ↶
            </button>
            <button type="button" className="lyx-btn lyx-btn-ghost h-10 w-10" title={t("studioPro.redo")} disabled={!undoStack.current.canRedo()} onClick={handleRedo}>
              ↷
            </button>
            <Button variant="secondary" onClick={() => navigate(`/jobs/${id}/studio/templates`)}>
              {template ? t("studioPro.changeTemplate") : t("studioPro.openTemplates")}
            </Button>
            <Button
              variant="secondary"
              disabled={approving || dirty || !baseVersionId || timelineStatus === "approved"}
              onClick={() => void submitApprove()}
            >
              {timelineStatus === "approved" ? t("studioPro.timelineApproved") : t("studioPro.approveTimeline")}
            </Button>
            <Select value={renderAccountId} onChange={(event) => setRenderAccountId(event.target.value)} disabled={renderAccounts.length === 0}>
              {renderAccounts.length === 0 ? <option value="">{t("studioPro.noAccountForRole", { role: "Creatomate" })}</option> : null}
              {renderAccounts.map((account) => (
                <option key={account.id} value={account.id}>{account.name}</option>
              ))}
            </Select>
            <Button
              disabled={renderSubmitting || timelineStatus !== "approved" || !renderAccountId || (preview ? !preview.ready : false)}
              onClick={() => void submitRender()}
            >
              {t("studioPro.submitRender")}
            </Button>
          </>
        }
      />
      <Banner variant="info">{t("studioPro.scaffoldBanner")}</Banner>
      {conflict ? (
        <Banner variant="warn">
          {t("studioPro.conflict")} <button type="button" className="underline" onClick={reloadAfterConflict}>{t("studioPro.reload")}</button>
        </Banner>
      ) : null}
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {preview && !preview.ready ? <Banner variant="warn">{t("studioPro.approxPreviewMissing", { keys: preview.missingRequiredModificationKeys.join(", ") })}</Banner> : null}
      {preview?.ready ? <Banner variant="info">{t("studioPro.approxPreviewReady")}</Banner> : null}
      {renderJob ? (
        <Banner variant={renderJob.status === "failed" ? "danger" : "info"}>
          {t("studioPro.renderStatusLabel", { status: renderJob.status })}
          {renderJob.status === "completed" && renderJob.resultUrl ? (
            <>
              {" "}
              <a className="underline" href={renderJob.resultUrl} target="_blank" rel="noreferrer">{t("studioPro.openResult")}</a>
            </>
          ) : null}
        </Banner>
      ) : null}

      <div className="grid gap-0 border border-lyx-border lg:grid-cols-[216px_1fr_250px]">
        <div className="flex flex-col border-b border-lyx-border lg:border-b-0 lg:border-r">
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
                <button type="button" className="text-left text-[10px] text-lyx-fg-muted underline" onClick={() => { setPexelsQuery(selectedScene.visualQuery); void runPexelsSearch(selectedScene.visualQuery); }}>
                  {selectedScene.visualQuery}
                </button>
              ) : null}
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
                        onClick={() => void importPexelsResult(video.externalId, `Pexels ${video.attribution.photographerName}`)}
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
                        onClick={() => void importPexelsResult(photo.externalId, `Pexels ${photo.attribution.photographerName}`)}
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
                <p className="mb-1 text-[11px] text-lyx-fg-muted">{t("studioPro.library")}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {mediaLibrary.map((asset) => {
                    loadThumb(asset.id);
                    const url = thumbCache[asset.id];
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => assignMediaToSelectedScene({ id: asset.id, label: asset.originalFileName })}
                        className="relative flex items-center justify-center overflow-hidden rounded-[4px] border border-lyx-border bg-lyx-muted text-[9px] text-lyx-fg-muted"
                        style={{ aspectRatio: "9 / 16" }}
                        title={asset.originalFileName}
                      >
                        {url && asset.kind === "image" ? <img src={url} alt="" className="h-full w-full object-cover" /> : null}
                        {url && asset.kind === "video" ? <video src={url} muted className="h-full w-full object-cover" /> : null}
                        <span className="absolute bottom-1 left-1 rounded-[3px] border border-lyx-border bg-lyx-bg px-1 text-[8px]">{asset.origin}</span>
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
              <Button
                variant="secondary"
                disabled={!selectedScene || !voiceAccountId || !selectedVoiceId || audioBusySceneId === selectedScene?.sceneId}
                onClick={() => void generateAudioForSelectedScene()}
              >
                {audioBusySceneId === selectedScene?.sceneId ? t("studioPro.generatingAudio") : t("studioPro.generateAudio")}
              </Button>
              {audioNotice ? <p className="text-lyx-danger">{audioNotice}</p> : null}
              {selectedScene && audioBySceneId[selectedScene.sceneId] ? (
                <p className="text-lyx-fg-muted">{t("studioPro.audioStatusCompleted")} · {t("studioPro.audioDuration", { seconds: Math.round(audioBySceneId[selectedScene.sceneId]!.durationMs / 1000) })}</p>
              ) : selectedSceneDraft?.audioVersionId ? (
                <p className="text-lyx-fg-muted">{t("studioPro.audioStatusCompleted")}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col">
          <div className="flex flex-1 items-center justify-center bg-lyx-muted p-6">
            <div
              className="relative flex flex-col items-center justify-center border border-lyx-border bg-lyx-bg text-center"
              style={{ width: 220, aspectRatio: "1080 / 1920" }}
            >
              <span className="absolute inset-3.5 border border-dashed border-lyx-border" aria-hidden />
              <span className="px-4 text-[11px] text-lyx-fg-subtle">{t("common.previewLabel")}</span>
              {selectedScene ? (
                <p className="absolute inset-x-3 bottom-3 border-t border-lyx-border px-1 pt-1.5 text-[10px] text-lyx-fg-muted">
                  {selectedSceneDraft?.screenTextOverride || selectedScene.screenText || "…"}
                </p>
              ) : null}
            </div>
          </div>

          <div className="border-t border-lyx-border p-3">
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-lyx-fg-muted">
              <span>{t("studioPro.sceneBoardHint")}</span>
              <span>{t("studioPro.totalDuration", { seconds: totalSeconds })}</span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {scenes.map((scene, index) => {
                const bound = draft.scenes.find((row) => row.sceneId === scene.sceneId);
                if (bound?.mediaAssetVersionId) loadThumb(bound.mediaAssetVersionId);
                const url = bound?.mediaAssetVersionId ? thumbCache[bound.mediaAssetVersionId] : undefined;
                return (
                  <button
                    key={scene.sceneId}
                    type="button"
                    onClick={() => setSelectedSceneId(scene.sceneId)}
                    className="w-16 flex-shrink-0"
                  >
                    <div
                      className={`flex items-center justify-center overflow-hidden rounded-[4px] bg-lyx-muted text-[9px] text-lyx-fg-muted ${
                        scene.sceneId === selectedScene?.sceneId ? "border-2 border-lyx-fg" : "border border-lyx-border"
                      }`}
                      style={{ aspectRatio: "9 / 16" }}
                    >
                      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : bound?.mediaAssetVersionId ? "" : t("studioPro.noMedia")}
                    </div>
                    <div className={`mt-1 text-center text-[9px] ${scene.sceneId === selectedScene?.sceneId ? "font-medium text-lyx-fg" : "text-lyx-fg-muted"}`}>
                      {index + 1} · {Math.round(scene.durationHintMs / 1000)}s
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="overflow-y-auto border-t border-lyx-border p-3 lg:border-t-0 lg:border-l">
          {selectedScene && selectedSceneDraft ? (
            <>
              <p className="mb-0.5 text-[12px] font-medium">
                {t("studioPro.inspectorTitle", { index: scenes.findIndex((scene) => scene.sceneId === selectedScene.sceneId) + 1 })}
              </p>
              <p className="mb-3 text-[10px] text-lyx-fg-muted">
                {template ? `${template.name} · ${template.id}` : t("studioPro.noTemplate")}
              </p>

              <div className="flex flex-col gap-3">
                <div>
                  <label className="mb-1 block text-[10px] text-lyx-fg-muted">{t("studioPro.fieldVideoSource")}</label>
                  <p className="text-[11px]">{selectedSceneDraft.mediaLabel ?? (selectedSceneDraft.mediaAssetVersionId ? selectedSceneDraft.mediaAssetVersionId : t("studioPro.noMedia"))}</p>
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
                  <label className="mb-1 block text-[10px] text-lyx-fg-muted">Annotation</label>
                  <TextArea
                    className="w-full"
                    value={selectedSceneDraft.annotation ?? ""}
                    onChange={(event) => setAnnotation(selectedScene.sceneId, event.target.value)}
                  />
                </div>

                {template ? (
                  <>
                    <p className="border-t border-lyx-border pt-2 text-[10px] text-lyx-fg-muted">{t("studioPro.inspectorHint")}</p>
                    {template.modifications
                      .filter((mod) => mod.kind === "color" || mod.kind === "font" || mod.kind === "volume" || mod.kind === "text")
                      .map((mod) => {
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
                        if (mod.kind === "volume") {
                          return (
                            <div key={mod.key}>
                              <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{mod.key}</label>
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
                        }
                        return (
                          <div key={mod.key}>
                            <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{mod.key}</label>
                            <TextArea className="w-full" value={value} onChange={(event) => setOptionValue(mod.key, event.target.value)} />
                          </div>
                        );
                      })}
                  </>
                ) : (
                  <p className="text-[11px] text-lyx-fg-muted">{t("templates.pinNote")}</p>
                )}
              </div>
            </>
          ) : (
            <StatusPill tone="neutral">{t("common.empty")}</StatusPill>
          )}
        </div>
      </div>
    </>
  );
}
