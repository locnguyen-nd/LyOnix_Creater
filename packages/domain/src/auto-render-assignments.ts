/**
 * VE2E-06: pure, positional best-effort mapping from a pinned Creatomate template's
 * modification slots to per-scene media/text/audio, used by the Auto orchestrator
 * (`WorkflowRunnerService`) since Auto mode has no human building a timeline. This is
 * NOT a general timeline editor — it never reorders/trims/crops, just fills each
 * slot queue (by kind, in the template's own element order) with the next scene that
 * has a matching asset, in scene order. Since VE2E-42 the Auto runner uses this only as a
 * preflight (exact missing required keys) and persists its bindings as an auto-approved
 * `TimelineVersion` rendered through the shared timeline mapping; `buildAutoTimelineOptionValues`
 * below keeps the title/caption leftover-slot fill identical on that path.
 *
 * Known limitation (documented, not silently worked around): a template with a
 * single audio element only ever receives the first scene's narration clip, because
 * concatenating multiple per-scene audio files into one track requires FFmpeg, which
 * must never run in `apps/api`/`apps/worker` HTTP-reachable code (only `media-worker`
 * may run FFmpeg, and this pure module has no I/O at all). Templates intended for Auto
 * narration should define one audio element per scene.
 */
import { orshotPageCount } from "./orshot-page-slots.js";

export type AutoModificationKind = "text" | "video" | "image" | "audio" | "color" | "font" | "volume";

export type AutoTemplateSlot = {
  key: string;
  kind: AutoModificationKind;
  required: boolean;
};

export type AutoSceneMedia = {
  sceneId: string;
  orderIndex: number;
  /**
   * The exact text this scene's caption/subtitle slot renders. The caller must pass the
   * scene's own `narration` here, not the separately LLM-authored `screenText` field on
   * `ScriptDraftSceneV2` - Auto has no human review step, so the only way to guarantee the
   * on-screen caption fully matches what the voice actually says (owner requirement: "hiển
   * thị đầy đủ theo voice") is to render the exact string that was fed to TTS, not a second,
   * independently-written copy of it that could diverge (paraphrase, drop words, reformat).
   */
  displayText: string;
  /** Short on-screen label for Orshot pageN@tag; falls back to displayText. */
  tagText?: string;
  visualMediaAssetVersionId: string | null;
  visualKind: "video" | "image" | null;
  audioMediaAssetVersionId: string | null;
};

export type AutoRenderAssignment =
  | { modificationKey: string; kind: "text"; text: string }
  | { modificationKey: string; kind: "video" | "image" | "audio"; mediaAssetVersionId: string };

export type AutoRenderAssignmentsResult =
  | { ok: true; assignments: AutoRenderAssignment[] }
  | { ok: false; reason: "no_scenes" }
  | { ok: false; reason: "missing_required_slot"; missingKeys: string[] };

/**
 * `extraText` (e.g. script title/caption) fills any leftover required text slots once
 * every scene's own `displayText` has been consumed — some templates have more text
 * elements (e.g. a title card) than there are scenes.
 */
export function buildAutoRenderAssignments(
  slots: AutoTemplateSlot[],
  scenes: AutoSceneMedia[],
  extraText: { title?: string; caption?: string } = {},
): AutoRenderAssignmentsResult {
  if (scenes.length === 0) return { ok: false, reason: "no_scenes" };
  const orderedScenes = [...scenes].sort((a, b) => a.orderIndex - b.orderIndex);
  const pageCount = orshotPageCount(slots);
  if (pageCount !== null) {
    const assignments: AutoRenderAssignment[] = [];
    const assigned = new Set<string>();
    const slotByKey = new Map(slots.map((slot) => [slot.key, slot]));
    for (const [index, scene] of orderedScenes.entries()) {
      const page = index + 1;
      if (page > pageCount) break;
      const putText = (key: string, value: string) => {
        if (slotByKey.get(key)?.kind !== "text" || !value.trim()) return;
        assignments.push({ modificationKey: key, kind: "text", text: value.trim() });
        assigned.add(key);
      };
      const mediaKey = `page${page}@media`;
      if (scene.visualMediaAssetVersionId && scene.visualKind === slotByKey.get(mediaKey)?.kind) {
        assignments.push({ modificationKey: mediaKey, kind: scene.visualKind, mediaAssetVersionId: scene.visualMediaAssetVersionId });
        assigned.add(mediaKey);
      }
      putText(`page${page}@subtitle`, scene.displayText);
      putText(`page${page}@tag`, scene.tagText?.trim() || scene.displayText);
    }
    const missingKeys = slots.filter((slot) => slot.required && !assigned.has(slot.key)).map((slot) => slot.key);
    return missingKeys.length ? { ok: false, reason: "missing_required_slot", missingKeys } : { ok: true, assignments };
  }

  const videoQueue = slots.filter((s) => s.kind === "video");
  const imageQueue = slots.filter((s) => s.kind === "image");
  const audioQueue = slots.filter((s) => s.kind === "audio");
  const textQueue = slots.filter((s) => s.kind === "text");

  const assignments: AutoRenderAssignment[] = [];
  const assignedKeys = new Set<string>();

  const assign = (slot: AutoTemplateSlot | undefined, value: AutoRenderAssignment | null) => {
    if (!slot || !value) return;
    assignments.push(value);
    assignedKeys.add(slot.key);
  };

  for (const scene of orderedScenes) {
    if (scene.visualMediaAssetVersionId && scene.visualKind) {
      const queue = scene.visualKind === "video" ? videoQueue : imageQueue;
      const slot = queue.shift();
      assign(slot, slot ? { modificationKey: slot.key, kind: scene.visualKind, mediaAssetVersionId: scene.visualMediaAssetVersionId } : null);
    }
    if (scene.audioMediaAssetVersionId) {
      const slot = audioQueue.shift();
      assign(slot, slot ? { modificationKey: slot.key, kind: "audio", mediaAssetVersionId: scene.audioMediaAssetVersionId } : null);
    }
    const displayText = scene.displayText.trim();
    if (displayText) {
      const slot = textQueue.shift();
      assign(slot, slot ? { modificationKey: slot.key, kind: "text", text: displayText } : null);
    }
  }

  for (const text of [extraText.title?.trim(), extraText.caption?.trim()]) {
    if (!text) continue;
    const slot = textQueue.shift();
    if (!slot) break;
    assign(slot, { modificationKey: slot.key, kind: "text", text });
  }

  const missingKeys = slots.filter((slot) => slot.required && !assignedKeys.has(slot.key)).map((slot) => slot.key);
  if (missingKeys.length > 0) return { ok: false, reason: "missing_required_slot", missingKeys };
  return { ok: true, assignments };
}

/**
 * VE2E-42: the Auto runner now persists its bindings as a `TimelineVersion` and renders through
 * the shared timeline mapping, which fills one text slot per scene (from the scene's text) and
 * then any still-unclaimed slot from the timeline's `optionValues`. This returns exactly the
 * leftover-text-slot fill `buildAutoRenderAssignments` applies for `extraText` (title, then
 * caption, into the text slots left after every scene with non-empty `displayText` took one), as
 * `optionValues`, so the rendered text is identical on both paths.
 */
export function buildAutoTimelineOptionValues(
  slots: AutoTemplateSlot[],
  scenes: AutoSceneMedia[],
  extraText: { title?: string; caption?: string } = {},
): Record<string, string> {
  if (orshotPageCount(slots) !== null) return {};
  const textSlots = slots.filter((slot) => slot.kind === "text");
  const sceneTextCount = scenes.filter((scene) => scene.displayText.trim()).length;
  const leftover = textSlots.slice(Math.min(sceneTextCount, textSlots.length));
  const values: Record<string, string> = {};
  for (const text of [extraText.title?.trim(), extraText.caption?.trim()]) {
    if (!text) continue;
    const slot = leftover.shift();
    if (!slot) break;
    values[slot.key] = text;
  }
  return values;
}
