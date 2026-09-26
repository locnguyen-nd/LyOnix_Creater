import type { TemplateModificationSlotResponse } from "@lyonix/contracts";

const PRIMARY_KINDS = new Set<TemplateModificationSlotResponse["kind"]>(["video", "image", "audio", "text"]);
const SECONDARY_KINDS = new Set<TemplateModificationSlotResponse["kind"]>(["color", "font", "volume"]);
type PrimaryKind = "video" | "image" | "audio" | "text";

const prefixOf = (key: string) => {
  const idx = key.lastIndexOf(".");
  return idx === -1 ? key : key.slice(0, idx);
};

export type SceneOptionGroups = {
  /** Secondary (color/font/volume) slots that belong to the scene currently occupying each template element, keyed by `sceneId`. Never includes the element's own primary video/image/audio/text slot — the scene-content fields (source/caption/annotation) already cover that. */
  bySceneId: Map<string, TemplateModificationSlotResponse[]>;
  /** Secondary slots left over when the template has more elements of a kind than there are scenes. */
  leftover: TemplateModificationSlotResponse[];
};

/**
 * Mirrors the server's positional-cursor scene<->slot pairing
 * (`apps/api/src/timeline-render-mapping.ts` `buildRenderAssignmentsFromTimeline`) purely for
 * display grouping. A Creatomate template names an element's secondary properties with the same
 * prefix as its primary slot (`Subtitles-2.text` / `Subtitles-2.font_family` /
 * `Subtitles-2.fill_color` are one element), and the server fills primary slots onto scenes in
 * source-tree order, one per scene. Grouping the same way lets the Inspector show only the handful
 * of options that actually apply to the scene currently selected, instead of every scene's fields
 * flattened into one list (the exact "loạn UI" a real Creatomate template with several
 * Subtitles-N/Voiceover-N elements produced before this grouping existed).
 */
export function groupTemplateOptionsByScene(
  slots: TemplateModificationSlotResponse[],
  orderedScenes: Array<{ sceneId: string }>,
): SceneOptionGroups {
  const byPrefix = new Map<string, TemplateModificationSlotResponse[]>();
  const prefixOrder: string[] = [];
  for (const slot of slots) {
    const prefix = prefixOf(slot.key);
    if (!byPrefix.has(prefix)) {
      byPrefix.set(prefix, []);
      prefixOrder.push(prefix);
    }
    byPrefix.get(prefix)!.push(slot);
  }

  const primaryKindOf = (prefix: string): PrimaryKind | null => {
    const found = byPrefix.get(prefix)!.find((slot) => PRIMARY_KINDS.has(slot.kind));
    return (found?.kind as PrimaryKind | undefined) ?? null;
  };

  const buckets: Record<PrimaryKind, string[]> = { video: [], image: [], audio: [], text: [] };
  for (const prefix of prefixOrder) {
    const kind = primaryKindOf(prefix);
    if (kind) buckets[kind].push(prefix);
  }

  const kinds: PrimaryKind[] = ["video", "image", "audio", "text"];
  const cursors: Record<PrimaryKind, number> = { video: 0, image: 0, audio: 0, text: 0 };
  const bySceneId = new Map<string, TemplateModificationSlotResponse[]>();
  for (const scene of orderedScenes) {
    const options: TemplateModificationSlotResponse[] = [];
    for (const kind of kinds) {
      const prefix = buckets[kind][cursors[kind]];
      if (prefix !== undefined) {
        cursors[kind] += 1;
        for (const slot of byPrefix.get(prefix)!) {
          if (SECONDARY_KINDS.has(slot.kind)) options.push(slot);
        }
      }
    }
    bySceneId.set(scene.sceneId, options);
  }

  const consumedPrefixes = new Set<string>();
  for (const kind of kinds) {
    for (let i = 0; i < cursors[kind]; i++) consumedPrefixes.add(buckets[kind][i]!);
  }
  const leftover: TemplateModificationSlotResponse[] = [];
  for (const prefix of prefixOrder) {
    if (consumedPrefixes.has(prefix)) continue;
    for (const slot of byPrefix.get(prefix)!) {
      if (SECONDARY_KINDS.has(slot.kind)) leftover.push(slot);
    }
  }
  return { bySceneId, leftover };
}
