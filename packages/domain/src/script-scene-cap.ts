/**
 * Caps the number of scenes of a script draft (pure). A fixed-page template (Orshot) carries one scene per page, so a draft with more
 * scenes than pages is shortened by merging ADJACENT scenes instead of failing the run: the two neighbours with the least combined
 * narration are merged first (narration joined, on-screen text and visual query of the first kept, duration hints summed), and every
 * visual-plan segment is remapped to the surviving scene ids. No text is dropped.
 */

type CappableScene = { sceneId: string; narration: string; screenText: string; visualQuery: string; durationHintMs: number };
type CappableSegment = { segmentId: string; sceneIds: string[] };
export type CappableDraft<S extends CappableScene = CappableScene, G extends CappableSegment = CappableSegment> = {
  scenes: S[];
  visualPlan?: { segments: G[] } | null;
};

const joinText = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(" ");

export function mergeScenesToCap<S extends CappableScene, G extends CappableSegment, D extends CappableDraft<S, G>>(draft: D, cap: number): D {
  const limit = Math.max(1, Math.floor(cap));
  if (draft.scenes.length <= limit) return draft;
  const scenes = draft.scenes.map((scene) => ({ ...scene }));
  const absorbed = new Map<string, string>();
  while (scenes.length > limit) {
    let best = 0;
    let bestSize = Number.POSITIVE_INFINITY;
    for (let index = 0; index < scenes.length - 1; index += 1) {
      const size = scenes[index]!.narration.length + scenes[index + 1]!.narration.length;
      if (size < bestSize) { best = index; bestSize = size; }
    }
    const keep = scenes[best]!;
    const gone = scenes[best + 1]!;
    keep.narration = joinText(keep.narration, gone.narration);
    keep.durationHintMs += gone.durationHintMs;
    if (!keep.screenText.trim()) keep.screenText = gone.screenText;
    absorbed.set(gone.sceneId, keep.sceneId);
    for (const [from, to] of absorbed) if (to === gone.sceneId) absorbed.set(from, keep.sceneId);
    scenes.splice(best + 1, 1);
  }
  const survivor = (sceneId: string) => absorbed.get(sceneId) ?? sceneId;
  const plan = draft.visualPlan;
  const segments = plan
    ? plan.segments
        .map((segment) => ({ ...segment, sceneIds: [...new Set(segment.sceneIds.map(survivor))] }))
        .filter((segment) => segment.sceneIds.length > 0)
    : null;
  return { ...draft, scenes, ...(plan && segments ? { visualPlan: { ...plan, segments } } : {}) };
}
