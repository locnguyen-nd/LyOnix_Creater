import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { Button, Select, TextArea } from "../components/ui";
import { api, ApiError } from "../api";
import type { ApiJob } from "../jobs-api";
import {
  PLACEHOLDER_MEDIA_POOL,
  PLACEHOLDER_TEMPLATES,
  type MediaCandidate,
} from "../studio/creatomate-placeholder";
import { loadScaffold, saveScaffold, type StudioScaffold } from "../studio/scaffold";

type LeftTab = "media" | "script" | "voice";

function secondsOf(scene: { estimatedDurationMs?: number }): number {
  return Math.round((scene.estimatedDurationMs ?? 5000) / 1000);
}

export function StudioProPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [job, setJob] = useState<ApiJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>("media");
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [scaffold, setScaffold] = useState<StudioScaffold>({ templateId: null, sceneMedia: {} });
  const [aiSearching, setAiSearching] = useState(false);
  const [suggestionsVisible, setSuggestionsVisible] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!id) return;
    void api<ApiJob>(`/jobs/${id}`)
      .then((row) => {
        setJob(row);
        setSelectedSceneId((current) => current ?? row.script.scenes[0]?.sceneId ?? null);
        setScaffold(loadScaffold(row.id));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
  }, [id]);

  const template = useMemo(
    () => PLACEHOLDER_TEMPLATES.find((item) => item.id === scaffold.templateId) ?? null,
    [scaffold.templateId],
  );

  const scenes = job?.script.scenes ?? [];
  const selectedScene = scenes.find((scene) => scene.sceneId === selectedSceneId) ?? scenes[0] ?? null;
  const totalSeconds = scenes.reduce((sum, scene) => sum + secondsOf(scene), 0);

  const mediaPool: MediaCandidate[] = PLACEHOLDER_MEDIA_POOL;
  const suggested = mediaPool.filter((item) => item.source !== "upload" && item.source !== "project");
  const library = mediaPool.filter((item) => item.source === "project");

  const persistScaffold = (next: StudioScaffold) => {
    if (!job) return;
    setScaffold(next);
    saveScaffold(job.id, next);
  };

  const assignMedia = (candidate: MediaCandidate) => {
    if (!job || !selectedScene) return;
    persistScaffold({
      ...scaffold,
      sceneMedia: { ...scaffold.sceneMedia, [selectedScene.sceneId]: { mediaId: candidate.id, label: candidate.label } },
    });
  };

  const onUploadFile = (file: File) => {
    const candidate: MediaCandidate = { id: crypto.randomUUID(), label: file.name, source: "upload" };
    assignMedia(candidate);
  };

  const setField = (key: string, value: string) => setFieldValues((prev) => ({ ...prev, [key]: value }));

  const updateSceneText = (sceneId: string, screenText: string) => {
    if (!job) return;
    setJob({
      ...job,
      script: {
        ...job.script,
        scenes: job.script.scenes.map((scene) => (scene.sceneId === sceneId ? { ...scene, screenText } : scene)),
      },
    });
  };

  if (error && !job) return <Banner variant="danger">{error}</Banner>;
  if (!job) return <Banner variant="info">{t("common.loading")}</Banner>;

  return (
    <>
      <PageHeader
        title={job.topic}
        breadcrumb={`${job.code} · ${t("studioPro.savedDraft")}`}
        actions={
          <>
            <span className="flex overflow-hidden rounded-[4px] border border-lyx-strong">
              <span className="px-3 text-[12px] leading-10 text-lyx-fg-muted">{t("studioPro.autoTag")}</span>
              <span className="bg-lyx-fg px-3 text-[12px] leading-10 text-lyx-bg">{t("studioPro.studioTag")}</span>
            </span>
            <button type="button" className="lyx-btn lyx-btn-ghost h-10 w-10" title={t("studioPro.undo")} disabled>
              ↶
            </button>
            <button type="button" className="lyx-btn lyx-btn-ghost h-10 w-10" title={t("studioPro.redo")} disabled>
              ↷
            </button>
            <Button variant="secondary" onClick={() => navigate(`/jobs/${job.id}/studio/templates`)}>
              {template ? t("studioPro.changeTemplate") : t("studioPro.openTemplates")}
            </Button>
            <Button disabled title={t("studioPro.scaffoldBanner")}>{t("studioPro.submitRender")}</Button>
          </>
        }
      />
      <Banner variant="info">{t("studioPro.scaffoldBanner")}</Banner>
      {error ? <Banner variant="danger">{error}</Banner> : null}

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
              <Button
                variant="primary"
                disabled={aiSearching}
                onClick={() => {
                  setAiSearching(true);
                  window.setTimeout(() => {
                    setAiSearching(false);
                    setSuggestionsVisible(true);
                  }, 500);
                }}
              >
                {aiSearching ? t("studioPro.aiSearchRunning") : t("studioPro.aiSearch")}
              </Button>
              <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
                {t("studioPro.uploadReplace")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUploadFile(file);
                  event.target.value = "";
                }}
              />
              <p className="text-[10px] leading-4 text-lyx-fg-muted">{t("studioPro.aiSearchHint")}</p>

              {suggestionsVisible ? (
                <div>
                  <p className="mb-1 text-[11px] text-lyx-fg-muted">{t("studioPro.suggested")}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {suggested.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        onClick={() => assignMedia(candidate)}
                        className="relative flex items-center justify-center rounded-[4px] border border-lyx-border bg-lyx-muted text-[9px] text-lyx-fg-muted"
                        style={{ aspectRatio: "9 / 16" }}
                        title={candidate.label}
                      >
                        <span className="absolute bottom-1 left-1 rounded-[3px] border border-lyx-border bg-lyx-bg px-1 text-[8px]">
                          {candidate.source}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <p className="mb-1 text-[11px] text-lyx-fg-muted">{t("studioPro.library")}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {library.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => assignMedia(candidate)}
                      className="relative flex items-center justify-center rounded-[4px] border border-lyx-border bg-lyx-muted text-[9px] text-lyx-fg-muted"
                      style={{ aspectRatio: "9 / 16" }}
                      title={candidate.label}
                    >
                      <span className="absolute bottom-1 left-1 rounded-[3px] border border-lyx-border bg-lyx-bg px-1 text-[8px]">
                        {candidate.source}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {leftTab === "script" ? (
            <div className="flex flex-col gap-2 overflow-y-auto p-3 text-[12px]">
              <p className="text-lyx-fg-muted">{job.script.hook}</p>
              <p>{job.script.body}</p>
              <p className="text-lyx-fg-muted">{job.script.cta}</p>
            </div>
          ) : null}

          {leftTab === "voice" ? (
            <div className="p-3 text-[12px] text-lyx-fg-muted">{t("common.comingSoon")}</div>
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
                  {selectedScene.screenText || "…"}
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
              {scenes.map((scene, index) => (
                <button
                  key={scene.sceneId}
                  type="button"
                  onClick={() => setSelectedSceneId(scene.sceneId)}
                  className="w-16 flex-shrink-0"
                >
                  <div
                    className={`flex items-center justify-center rounded-[4px] bg-lyx-muted text-[9px] text-lyx-fg-muted ${
                      scene.sceneId === selectedScene?.sceneId ? "border-2 border-lyx-fg" : "border border-lyx-border"
                    }`}
                    style={{ aspectRatio: "9 / 16" }}
                  >
                    {scaffold.sceneMedia[scene.sceneId] ? "" : t("studioPro.noMedia")}
                  </div>
                  <div className={`mt-1 text-center text-[9px] ${scene.sceneId === selectedScene?.sceneId ? "font-medium text-lyx-fg" : "text-lyx-fg-muted"}`}>
                    {index + 1} · {secondsOf(scene)}s
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-y-auto border-t border-lyx-border p-3 lg:border-t-0 lg:border-l">
          {selectedScene ? (
            <>
              <p className="mb-0.5 text-[12px] font-medium">
                {t("studioPro.inspectorTitle", { index: scenes.findIndex((scene) => scene.sceneId === selectedScene.sceneId) + 1 })}
              </p>
              <p className="mb-3 text-[10px] text-lyx-fg-muted">
                {template ? `${template.name} · ${template.templateSnapshotId}` : t("studioPro.noTemplate")}
              </p>

              {!template ? (
                <p className="text-[11px] text-lyx-fg-muted">{t("templates.pinNote")}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {template.modifications.map((mod) => {
                    const isFirstVideoLike = mod.kind === "video" || mod.kind === "image";
                    if (isFirstVideoLike) {
                      const assigned = scaffold.sceneMedia[selectedScene.sceneId];
                      return (
                        <div key={mod.key}>
                          <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{mod.key}</label>
                          <Select
                            className="w-full"
                            value={assigned?.mediaId ?? ""}
                            onChange={(event) => {
                              const candidate = mediaPool.find((item) => item.id === event.target.value);
                              if (candidate) assignMedia(candidate);
                            }}
                          >
                            <option value="">{t("studioPro.noMedia")}</option>
                            {mediaPool.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                      );
                    }
                    if (mod.kind === "text") {
                      const isPrimary = mod.key === template.modifications.find((m) => m.kind === "text")?.key;
                      return (
                        <div key={mod.key}>
                          <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{mod.key}</label>
                          {isPrimary ? (
                            <TextArea
                              className="w-full"
                              value={selectedScene.screenText}
                              onChange={(event) => updateSceneText(selectedScene.sceneId, event.target.value)}
                            />
                          ) : (
                            <TextArea
                              className="w-full"
                              value={fieldValues[`${selectedScene.sceneId}:${mod.key}`] ?? ""}
                              onChange={(event) => setField(`${selectedScene.sceneId}:${mod.key}`, event.target.value)}
                            />
                          )}
                        </div>
                      );
                    }
                    if (mod.kind === "font") {
                      return (
                        <div key={mod.key}>
                          <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{mod.key}</label>
                          <Select
                            className="w-full"
                            value={fieldValues[`${selectedScene.sceneId}:${mod.key}`] ?? "Inter Bold"}
                            onChange={(event) => setField(`${selectedScene.sceneId}:${mod.key}`, event.target.value)}
                          >
                            <option>Inter Bold</option>
                            <option>Inter Medium</option>
                            <option>Noto Sans</option>
                          </Select>
                        </div>
                      );
                    }
                    if (mod.kind === "color") {
                      const fieldKey = `${selectedScene.sceneId}:${mod.key}`;
                      const value = fieldValues[fieldKey] ?? "#161616";
                      return (
                        <div key={mod.key}>
                          <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{mod.key}</label>
                          <div className="flex items-center gap-1.5">
                            {["#161616", "#F5F5F5", "#0A7A3E"].map((hex) => (
                              <button
                                key={hex}
                                type="button"
                                aria-label={hex}
                                onClick={() => setField(fieldKey, hex)}
                                className={`h-[22px] w-[22px] rounded-[4px] border ${value === hex ? "border-lyx-fg" : "border-lyx-border"}`}
                                style={{ backgroundColor: hex }}
                              />
                            ))}
                            <input
                              value={value}
                              onChange={(event) => setField(fieldKey, event.target.value)}
                              className="h-8 flex-1 rounded-[4px] border border-lyx-border bg-lyx-muted px-2 text-[11px]"
                            />
                          </div>
                        </div>
                      );
                    }
                    const fieldKey = `${selectedScene.sceneId}:${mod.key}`;
                    return (
                      <div key={mod.key}>
                        <label className="mb-1 block font-mono text-[10px] text-lyx-fg-muted">{mod.key}</label>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={fieldValues[fieldKey] ?? "80"}
                          onChange={(event) => setField(fieldKey, event.target.value)}
                          className="w-full"
                        />
                      </div>
                    );
                  })}
                  <p className="border-t border-lyx-border pt-2 text-[10px] text-lyx-fg-muted">{t("studioPro.inspectorHint")}</p>
                </div>
              )}
            </>
          ) : (
            <StatusPill tone="neutral">{t("common.empty")}</StatusPill>
          )}
        </div>
      </div>
    </>
  );
}
