/**
 * Which render path an Auto/Studio timeline takes. The fixed-slot template path (`modifications` per
 * `Video-N` slot) is only valid when every scene can land in a template slot; otherwise the template-scaled
 * dynamic generator (VE2E-52) composes exactly the scenes it is given and handles image and video scenes alike.
 *
 * Shared by the Auto runner's pre-flight and `RenderJobsService`, so both always agree (the runner used to reject a
 * run for "missing Video-N" that the dynamic path would have rendered fine).
 */
export function fixedSlotPathApplies(input: {
  /** `Scene` compositions in the pinned template (0 = unknown layout: keep the legacy fixed-slot behaviour). */
  slotCount: number;
  includedSceneCount: number;
  /** Included scenes whose visual is an image (e.g. a Pinterest photo). */
  imageSceneCount: number;
  /** Image slots the template exposes for scenes. */
  templateImageSlots: number;
}): boolean {
  if (input.slotCount <= 0) return true;
  if (input.includedSceneCount !== input.slotCount) return false;
  return input.imageSceneCount <= input.templateImageSlots;
}
