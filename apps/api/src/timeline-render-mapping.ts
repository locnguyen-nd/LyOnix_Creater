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
import { sameCaptionText } from "@lyonix/domain";
import type { PrismaService } from "./prisma.service.js";

export type TimelineSceneMediaKind = "video" | "image" | null;

/** One scene binding plus the kind of its bound media asset (looked up by the caller - this module never touches Prisma). */
/**
 * A scene binding as stored in `TimelineVersion.scenes` JSON. Rows written before VE2E-42 have no
 * `segmentId`/`sourceStartMs`/`sourceDurationMs`; the render mapping never needs them (range-based
 * derivative cutting is VE2E-37), so they are optional here and a legacy row maps exactly as before.
 */
export type StoredTimelineSceneBinding = Omit<TimelineSceneBindingResponse, "segmentId" | "sourceStartMs" | "sourceDurationMs"> &
  Partial<Pick<TimelineSceneBindingResponse, "segmentId" | "sourceStartMs" | "sourceDurationMs">>;

export type SceneBindingForMapping = StoredTimelineSceneBinding & {
  mediaKind: TimelineSceneMediaKind;
  /** `AudioVersion.mediaAssetVersionId` for this scene's bound audio, if any - resolved by the caller. */
  audioMediaAssetVersionId?: string | null;
  /** Falls back to the pinned script's own scene text when no `screenTextOverride` is set. */
  fallbackScreenText?: string | null;
  /** VE2E-44: bound video asset's own duration (null when unknown) and the scene voice's duration. */
  mediaDurationMs?: number | null;
  audioDurationMs?: number | null;
  /** V03-03: narration the bound voice was generated from (`SceneDraftVersion.narration`); null when unknown. */
  audioNarration?: string | null;
};

/**
 * V03-03: the `screenTextOverride` that really replaces the voice-timed captions with one static block, or null.
 * Auto writes the scene's own narration as the override (word-for-word caption rule) - that is not a human edit, so
 * it must keep the timed captions; only text that differs from the voiced narration (whitespace ignored) is a real override.
 */
export function captionOverrideFor(scene: Pick<SceneBindingForMapping, "screenTextOverride" | "audioNarration">): string | null {
  const override = scene.screenTextOverride?.trim();
  if (!override) return null;
  if (scene.audioNarration && sameCaptionText(override, scene.audioNarration)) return null;
  return override;
}

/** VE2E-44: an asset within this much of the scene length is not worth cutting. */
export const DEFAULT_RANGE_TOLERANCE_MS = 500;

/**
 * VE2E-44: default source range for a video scene that has none - `[0, min(voice duration, asset
 * duration)]`. Returns null (leave the scene untouched) for images, scenes that already carry a
 * range, unknown durations, or an asset already no longer than the scene + tolerance (it is sent
 * whole, nothing to save). Pure - shared by render enqueue (legacy timelines) and approve/persist.
 */
export function deriveDefaultVideoRange(
  scene: Pick<SceneBindingForMapping, "mediaKind" | "mediaAssetVersionId" | "sourceStartMs" | "sourceDurationMs" | "mediaDurationMs" | "audioDurationMs">,
  toleranceMs = DEFAULT_RANGE_TOLERANCE_MS,
): { sourceStartMs: number; sourceDurationMs: number } | null {
  if (scene.mediaKind !== "video" || !scene.mediaAssetVersionId) return null;
  if (typeof scene.sourceStartMs === "number" || typeof scene.sourceDurationMs === "number") return null;
  const assetMs = scene.mediaDurationMs;
  const sceneMs = scene.audioDurationMs;
  if (typeof assetMs !== "number" || typeof sceneMs !== "number" || assetMs <= 0 || sceneMs <= 0) return null;
  if (assetMs <= sceneMs + toleranceMs) return null;
  return { sourceStartMs: 0, sourceDurationMs: Math.max(1, Math.min(Math.round(sceneMs), assetMs)) };
}

export function applyDefaultVideoRanges<T extends SceneBindingForMapping>(scenes: T[], toleranceMs = DEFAULT_RANGE_TOLERANCE_MS): T[] {
  return scenes.map((scene) => {
    const range = deriveDefaultVideoRange(scene, toleranceMs);
    return range ? { ...scene, ...range } : scene;
  });
}

export type BuiltTimelineAssignments = {
  assignments: RenderAssignmentInput[];
  filledModificationKeys: string[];
  missingRequiredModificationKeys: string[];
  /** VE2E-37: which template video slot (e.g. `Video-1.source`) each scene's video landed in; scenes past the last slot are absent. */
  videoSlotKeyBySceneId: Record<string, string>;
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
  const videoSlotKeyBySceneId: Record<string, string> = {};
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
        videoSlotKeyBySceneId[scene.sceneId] = slot.key;
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
  return { assignments, filledModificationKeys: [...claimed], missingRequiredModificationKeys, videoSlotKeyBySceneId };
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
  scenes: StoredTimelineSceneBinding[],
  options: { fillDefaultVideoRanges?: boolean } = {},
): Promise<SceneBindingForMapping[]> {
  const audioIds = [...new Set(scenes.map((scene) => scene.audioVersionId).filter((id): id is string => Boolean(id)))];
  const audioRows = audioIds.length
    ? await prisma.audioVersion.findMany({ where: { id: { in: audioIds } }, select: { id: true, mediaAssetVersionId: true, durationMs: true, sceneDraftVersion: { select: { narration: true } } } })
    : [];
  const audioAssetById = new Map(audioRows.map((row) => [row.id, row.mediaAssetVersionId]));
  const audioDurationById = new Map(audioRows.map((row) => [row.id, row.durationMs]));
  const audioNarrationById = new Map(audioRows.map((row) => [row.id, row.sceneDraftVersion?.narration ?? null]));

  const mediaIds = [
    ...new Set([
      ...scenes.map((scene) => scene.mediaAssetVersionId).filter((id): id is string => Boolean(id)),
      ...audioRows.map((row) => row.mediaAssetVersionId),
    ]),
  ];
  const mediaRows = mediaIds.length
    ? await prisma.mediaAssetVersion.findMany({ where: { id: { in: mediaIds }, projectId, deletedAt: null }, select: { id: true, kind: true, durationMs: true } })
    : [];
  const mediaKindById = new Map(mediaRows.map((row) => [row.id, row.kind]));
  const mediaDurationById = new Map(mediaRows.map((row) => [row.id, row.durationMs]));

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

  const mapped = scenes.map((scene): SceneBindingForMapping => {
    const kind = scene.mediaAssetVersionId ? mediaKindById.get(scene.mediaAssetVersionId) : undefined;
    const audioAssetId = scene.audioVersionId ? audioAssetById.get(scene.audioVersionId) ?? null : null;
    const audioBelongsToProject = audioAssetId ? mediaKindById.has(audioAssetId) : false;
    return {
      ...scene,
      mediaKind: kind === "video" ? "video" : kind === "image" ? "image" : null,
      audioMediaAssetVersionId: audioBelongsToProject ? audioAssetId : null,
      fallbackScreenText: screenTextBySceneId.get(scene.sceneId) ?? null,
      mediaDurationMs: scene.mediaAssetVersionId ? mediaDurationById.get(scene.mediaAssetVersionId) ?? null : null,
      audioDurationMs: scene.audioVersionId ? audioDurationById.get(scene.audioVersionId) ?? null : null,
      audioNarration: scene.audioVersionId ? audioNarrationById.get(scene.audioVersionId) ?? null : null,
    };
  });
  return options.fillDefaultVideoRanges ? applyDefaultVideoRanges(mapped) : mapped;
}
