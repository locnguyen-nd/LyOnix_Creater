/**
 * Template slot preflight (Auto, fixed-slot templates): catch an unfillable required modification (`Image-7.source`) BEFORE any paid
 * work / the render, with the exact scene + slot, instead of at the timeline step after TTS and media sourcing.
 *
 * Slot keys `<Image|Video>-<N>.source` belong to scene N (Creatomate element numbering of the pinned template). Pure, no I/O.
 * - `templateSceneCapacity`: how many scenes a template can show. A template with `Scene` compositions is re-composed for any count
 *   (template-scaled render, VE2E-52) -> unlimited; an Orshot page template -> its page count; otherwise -> its scene media slots.
 * - `preflightTemplateSceneCount`: right after the script - a fixed-slot template cannot show more scenes than it has slots, and a
 *   required slot past the last scene can never be filled.
 * - `preflightTemplateSlots`: after media sourcing - every scene's source must be the kind its slot expects (an image slot needs an
 *   image, a video slot a video); each issue names the scene and the slot.
 */

export type TemplateSlotLike = { key: string; kind?: string | null; required?: boolean | null };

const SCENE_MEDIA_KEY = /^(Image|Video)-(\d+)\.source$/;

export type SceneMediaSlot = { key: string; sceneNumber: number; kind: "image" | "video"; required: boolean };

/** The scene media slots of a template (`Image-N.source` / `Video-N.source`), ordered by scene number. */
export function sceneMediaSlots(slots: readonly TemplateSlotLike[]): SceneMediaSlot[] {
  const out: SceneMediaSlot[] = [];
  for (const slot of slots) {
    const match = SCENE_MEDIA_KEY.exec(slot.key);
    if (!match) continue;
    out.push({ key: slot.key, sceneNumber: Number(match[2]), kind: match[1] === "Image" ? "image" : "video", required: slot.required !== false });
  }
  return out.sort((a, b) => a.sceneNumber - b.sceneNumber);
}

export type TemplateSceneCapacity = { mode: "scaled" | "pages" | "fixed"; maxScenes: number | null; sceneSlots: number };

export function templateSceneCapacity(input: { slots: readonly TemplateSlotLike[]; sceneCompositions: number; orshotPages?: number | null }): TemplateSceneCapacity {
  const media = sceneMediaSlots(input.slots);
  const sceneSlots = new Set(media.map((slot) => slot.sceneNumber)).size;
  if (input.orshotPages != null && input.orshotPages > 0) return { mode: "pages", maxScenes: input.orshotPages, sceneSlots };
  if (input.sceneCompositions > 0) return { mode: "scaled", maxScenes: null, sceneSlots };
  return { mode: "fixed", maxScenes: sceneSlots > 0 ? sceneSlots : null, sceneSlots };
}

export type TemplateSceneCountCheck =
  | { ok: true; capacity: TemplateSceneCapacity }
  | { ok: false; code: "TEMPLATE_SCENE_COUNT_UNSUPPORTED" | "TEMPLATE_REQUIRED_ASSET_MISSING"; message: string; capacity: TemplateSceneCapacity; missingKeys: string[] };

/** Right after the script: a fixed-slot template must fit the scene count exactly enough that every required slot has a scene. */
export function preflightTemplateSceneCount(input: { slots: readonly TemplateSlotLike[]; sceneCompositions: number; orshotPages?: number | null; sceneCount: number }): TemplateSceneCountCheck {
  const capacity = templateSceneCapacity(input);
  if (capacity.mode !== "fixed" || capacity.maxScenes === null) return { ok: true, capacity };
  if (input.sceneCount > capacity.maxScenes) {
    return { ok: false, code: "TEMPLATE_SCENE_COUNT_UNSUPPORTED", message: `Template chỉ hỗ trợ ${capacity.maxScenes} cảnh (slot cố định, không tự co giãn), kịch bản có ${input.sceneCount} cảnh`, capacity, missingKeys: [] };
  }
  const orphan = sceneMediaSlots(input.slots).filter((slot) => slot.required && slot.sceneNumber > input.sceneCount).map((slot) => slot.key);
  if (orphan.length > 0) {
    return { ok: false, code: "TEMPLATE_REQUIRED_ASSET_MISSING", message: `Template cần ${capacity.maxScenes} cảnh nhưng kịch bản có ${input.sceneCount}: slot bắt buộc không có cảnh nào: ${orphan.join(", ")}`, capacity, missingKeys: orphan };
  }
  return { ok: true, capacity };
}

export type TemplateSlotScene = { sceneId: string; orderIndex: number; visualKind: "image" | "video" | null; mediaAssetVersionId: string | null };

export type TemplateSlotIssue = {
  sceneId: string;
  /** 1-based position of the scene in the video. */
  sceneNumber: number;
  slotKey: string;
  expectedKind: "image" | "video";
  /** What the scene has now (`null` = no media). */
  actualKind: "image" | "video" | null;
};

export type TemplateSlotPreflight = { ok: boolean; issues: TemplateSlotIssue[] };

/** After sourcing (fixed-slot path): scene N must carry the kind its `Image-N` / `Video-N` slot expects. */
export function preflightTemplateSlots(slots: readonly TemplateSlotLike[], scenes: readonly TemplateSlotScene[]): TemplateSlotPreflight {
  const ordered = [...scenes].sort((a, b) => a.orderIndex - b.orderIndex);
  const issues: TemplateSlotIssue[] = [];
  for (const slot of sceneMediaSlots(slots)) {
    if (!slot.required) continue;
    const scene = ordered[slot.sceneNumber - 1];
    if (!scene) continue; // a slot past the last scene is the scene-count preflight's job
    const actualKind = scene.mediaAssetVersionId ? scene.visualKind : null;
    if (actualKind !== slot.kind) issues.push({ sceneId: scene.sceneId, sceneNumber: slot.sceneNumber, slotKey: slot.key, expectedKind: slot.kind, actualKind });
  }
  return { ok: issues.length === 0, issues };
}

const KIND_VI = { image: "ảnh", video: "video" } as const;

/** "Cảnh 7 (scene_7) -> Image-7.source: cần ảnh, đang là video" - one line per issue. */
export const describeTemplateSlotIssues = (issues: readonly TemplateSlotIssue[]): string =>
  issues.map((issue) => `Cảnh ${issue.sceneNumber} (${issue.sceneId}) -> ${issue.slotKey}: cần ${KIND_VI[issue.expectedKind]}, ${issue.actualKind ? `đang là ${KIND_VI[issue.actualKind]}` : "chưa có media"}`).join("; ");
