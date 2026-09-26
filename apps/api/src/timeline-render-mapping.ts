/**
 * VE2E-07: pure mapping from a persisted `TimelineVersion` (ordered scene bindings +
 * template-level option values) to the whitelisted `RenderAssignmentInput[]` shape
 * `RenderJobsService.submit()` already validates and resolves into a real Creatomate
 * `modifications` object. No provider/DB call happens here - this is intentionally a pure
 * function so both the render submit path (`RenderJobsService.submitFromTimelineVersion`)
 * and the no-charge preview path (`TimelineVersionsService.preview`) share one mapping
 * with no duplicated logic.
 *
 * A Creatomate template's modification slots are a fixed small set the user designed in
 * Creatomate's own editor (e.g. `Video-1.source`/`Video-2.source` for a two-shot
 * template) - they are not automatically one-per-LyOnix-scene. This function zips ordered
 * scenes onto same-kind slots positionally (independent cursors per kind), which matches
 * how a template with N video/text elements is meant to be filled from N scenes, while a
 * template with fewer slots than scenes simply only uses its first N scenes' bindings.
 * Template-level `optionValues` (color/font/volume, or any slot not covered by a scene
 * binding) fill any modification key not already claimed by a scene.
 */
import type { TemplateModificationSlotResponse, TimelineOptionValues, TimelineSceneBindingResponse } from "@lyonix/contracts";
import type { RenderAssignmentInput } from "@lyonix/contracts";
import type { PrismaService } from "./prisma.service.js";

export type TimelineSceneMediaKind = "video" | "image" | null;

/** One scene binding plus the kind of its bound media asset (looked up by the caller - this module never touches Prisma). */
export type SceneBindingForMapping = TimelineSceneBindingResponse & {
  mediaKind: TimelineSceneMediaKind;
  /** `AudioVersion.mediaAssetVersionId` for this scene's bound audio, if any - resolved by the caller. */
  audioMediaAssetVersionId?: string | null;
  /** Falls back to the pinned script's own scene text when no `screenTextOverride` is set. */
  fallbackScreenText?: string | null;
};

export type BuiltTimelineAssignments = {
  assignments: RenderAssignmentInput[];
  filledModificationKeys: string[];
  missingRequiredModificationKeys: string[];
};

const byKind = (slots: TemplateModificationSlotResponse[], kind: TemplateModificationSlotResponse["kind"]) =>
  slots.filter((slot) => slot.kind === kind);

export function buildRenderAssignmentsFromTimeline(
  slots: TemplateModificationSlotResponse[],
  scenes: SceneBindingForMapping[],
  optionValues: TimelineOptionValues,
): BuiltTimelineAssignments {
  const orderedScenes = [...scenes].sort((a, b) => a.orderIndex - b.orderIndex);
  const videoSlots = byKind(slots, "video");
  const imageSlots = byKind(slots, "image");
  const audioSlots = byKind(slots, "audio");
  const textSlots = byKind(slots, "text");
  const volumeSlotByKey = new Map(byKind(slots, "volume").map((slot) => [slot.key, slot]));

  const assignments: RenderAssignmentInput[] = [];
  const claimed = new Set<string>();
  let videoCursor = 0;
  let imageCursor = 0;
  let audioCursor = 0;
  let textCursor = 0;

  for (const scene of orderedScenes) {
    if (scene.mediaAssetVersionId) {
      if (scene.mediaKind === "video" && videoCursor < videoSlots.length) {
        const slot = videoSlots[videoCursor++]!;
        assignments.push({ modificationKey: slot.key, kind: "video", mediaAssetVersionId: scene.mediaAssetVersionId });
        claimed.add(slot.key);
        // A scene's video is always an imported/fetched clip (Pexels or project library) whose
        // own audio track is never the intended sound - the real voiceover lives on the audio
        // track above. Creatomate names an element's volume slot `<name>.volume` alongside its
        // `<name>.source` slot (see deriveTemplateModifications), so mute it by default unless
        // the user explicitly set a value for that exact key in optionValues.
        const volumeKey = slot.key.replace(/\.source$/, ".volume");
        const volumeSlot = volumeSlotByKey.get(volumeKey);
        if (volumeSlot && !claimed.has(volumeKey) && optionValues[volumeKey] === undefined) {
          assignments.push({ modificationKey: volumeKey, kind: "volume", volumePercent: 0 });
          claimed.add(volumeKey);
        }
      } else if (scene.mediaKind === "image" && imageCursor < imageSlots.length) {
        const slot = imageSlots[imageCursor++]!;
        assignments.push({ modificationKey: slot.key, kind: "image", mediaAssetVersionId: scene.mediaAssetVersionId });
        claimed.add(slot.key);
      }
    }
    if (scene.audioMediaAssetVersionId && audioCursor < audioSlots.length) {
      const slot = audioSlots[audioCursor++]!;
      assignments.push({ modificationKey: slot.key, kind: "audio", mediaAssetVersionId: scene.audioMediaAssetVersionId });
      claimed.add(slot.key);
    }
    const text = (scene.screenTextOverride ?? scene.fallbackScreenText ?? "").trim();
    if (text && textCursor < textSlots.length) {
      const slot = textSlots[textCursor++]!;
      assignments.push({ modificationKey: slot.key, kind: "text", text });
      claimed.add(slot.key);
    }
  }

  for (const slot of slots) {
    if (claimed.has(slot.key)) continue;
    const raw = optionValues[slot.key];
    if (raw === undefined) continue;
    if (slot.kind === "text") assignments.push({ modificationKey: slot.key, kind: "text", text: raw });
    else if (slot.kind === "color") assignments.push({ modificationKey: slot.key, kind: "color", color: raw });
    else if (slot.kind === "font") assignments.push({ modificationKey: slot.key, kind: "font", fontFamily: raw });
    else if (slot.kind === "volume") assignments.push({ modificationKey: slot.key, kind: "volume", volumePercent: Number(raw) });
    else continue; // video/image/audio must come from a scene binding, never a raw optionValues string
    claimed.add(slot.key);
  }

  const missingRequiredModificationKeys = slots.filter((slot) => slot.required && !claimed.has(slot.key)).map((slot) => slot.key);
  return { assignments, filledModificationKeys: [...claimed], missingRequiredModificationKeys };
}

/**
 * Resolves each scene binding's underlying media kind (video/image, from
 * `MediaAssetVersion.kind`), its bound audio's own `mediaAssetVersionId` (from
 * `AudioVersion.mediaAssetVersionId`), and its pinned script's own scene text (from
 * `SceneDraftVersion.screenText`, via `scriptDraftVersion.sourceVersion.projectId`) as
 * `fallbackScreenText` - so `buildRenderAssignmentsFromTimeline` never has to touch Prisma
 * itself, and a scene the user never typed a `screenTextOverride` for still fills its
 * template text slot from the approved script instead of being reported missing. Re-scopes
 * every resolved media id to `projectId` (defense in depth - `mediaAssetVersionId`/
 * `audioVersionId` on a `TimelineVersion` are plain opaque columns with no FK, see schema
 * comment) - an id that does not actually belong to this project is silently treated as
 * unbound rather than trusted. When the same `sceneId` exists across multiple script draft
 * versions for the project, the highest `version` wins.
 */
export async function resolveSceneBindingsForMapping(
  prisma: PrismaService,
  projectId: string,
  scenes: TimelineSceneBindingResponse[],
): Promise<SceneBindingForMapping[]> {
  const audioIds = [...new Set(scenes.map((scene) => scene.audioVersionId).filter((id): id is string => Boolean(id)))];
  const audioRows = audioIds.length
    ? await prisma.audioVersion.findMany({ where: { id: { in: audioIds } }, select: { id: true, mediaAssetVersionId: true } })
    : [];
  const audioAssetById = new Map(audioRows.map((row) => [row.id, row.mediaAssetVersionId]));

  const mediaIds = [
    ...new Set([
      ...scenes.map((scene) => scene.mediaAssetVersionId).filter((id): id is string => Boolean(id)),
      ...audioRows.map((row) => row.mediaAssetVersionId),
    ]),
  ];
  const mediaRows = mediaIds.length
    ? await prisma.mediaAssetVersion.findMany({ where: { id: { in: mediaIds }, projectId, deletedAt: null }, select: { id: true, kind: true } })
    : [];
  const mediaKindById = new Map(mediaRows.map((row) => [row.id, row.kind]));

  const sceneIds = [...new Set(scenes.map((scene) => scene.sceneId))];
  const sceneDraftRows = sceneIds.length
    ? await prisma.sceneDraftVersion.findMany({
        where: { sceneId: { in: sceneIds }, scriptDraftVersion: { sourceVersion: { projectId } } },
        select: { sceneId: true, screenText: true },
        orderBy: { scriptDraftVersion: { version: "desc" } },
      })
    : [];
  const screenTextBySceneId = new Map<string, string>();
  for (const row of sceneDraftRows) {
    if (!screenTextBySceneId.has(row.sceneId)) screenTextBySceneId.set(row.sceneId, row.screenText);
  }

  return scenes.map((scene): SceneBindingForMapping => {
    const kind = scene.mediaAssetVersionId ? mediaKindById.get(scene.mediaAssetVersionId) : undefined;
    const audioAssetId = scene.audioVersionId ? audioAssetById.get(scene.audioVersionId) ?? null : null;
    const audioBelongsToProject = audioAssetId ? mediaKindById.has(audioAssetId) : false;
    return {
      ...scene,
      mediaKind: kind === "video" ? "video" : kind === "image" ? "image" : null,
      audioMediaAssetVersionId: audioBelongsToProject ? audioAssetId : null,
      fallbackScreenText: screenTextBySceneId.get(scene.sceneId) ?? null,
    };
  });
}
