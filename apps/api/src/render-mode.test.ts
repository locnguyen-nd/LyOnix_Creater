import { describe, expect, it } from "vitest";
import { fixedSlotPathApplies } from "./render-mode.js";

const base = { slotCount: 10, includedSceneCount: 10, imageSceneCount: 0, templateImageSlots: 0 };

describe("fixedSlotPathApplies", () => {
  it("uses the fixed-slot path only when the scene count equals the template's scene slots", () => {
    expect(fixedSlotPathApplies(base)).toBe(true);
    expect(fixedSlotPathApplies({ ...base, includedSceneCount: 14 })).toBe(false);
    expect(fixedSlotPathApplies({ ...base, includedSceneCount: 6 })).toBe(false);
  });

  it("switches to the dynamic generator when an image scene has no image slot to land in", () => {
    expect(fixedSlotPathApplies({ ...base, imageSceneCount: 1 })).toBe(false);
    expect(fixedSlotPathApplies({ ...base, imageSceneCount: 2, templateImageSlots: 2 })).toBe(true);
  });

  it("keeps the legacy behaviour when the template layout is unknown", () => {
    expect(fixedSlotPathApplies({ ...base, slotCount: 0, includedSceneCount: 14 })).toBe(true);
  });
});
