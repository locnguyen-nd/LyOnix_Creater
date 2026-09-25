/**
 * VE2E-07a scaffold only. Client-side draft of Studio scene/template/media
 * selections, keyed per job in localStorage so the layout is genuinely
 * operable before the backend exists. Not synced to any API — TODO-wire once
 * VE2E-00 (project/version schema), VE2E-04 (media) and VE2E-05 (Creatomate
 * render) are code_done: replace load/save with real GET/PATCH calls.
 */

export type SceneMediaAssignment = { mediaId: string; label: string };

export type StudioScaffold = {
  templateId: string | null;
  sceneMedia: Record<string, SceneMediaAssignment>;
};

const KEY_PREFIX = "lyx-studio-scaffold:";

const empty: StudioScaffold = { templateId: null, sceneMedia: {} };

export function loadScaffold(jobId: string): StudioScaffold {
  if (typeof localStorage === "undefined") return empty;
  const raw = localStorage.getItem(KEY_PREFIX + jobId);
  if (!raw) return empty;
  try {
    return { ...empty, ...(JSON.parse(raw) as Partial<StudioScaffold>) };
  } catch {
    return empty;
  }
}

export function saveScaffold(jobId: string, scaffold: StudioScaffold) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY_PREFIX + jobId, JSON.stringify(scaffold));
}
