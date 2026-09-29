import { describe, expect, it } from "vitest";
import { pexelsQueryForScene, visualSegmentForScene } from "./visual-plan";

const style = { setting: "", timeOfDay: "", lighting: "", palette: "" };
const plan = {
  segments: [
    { segmentId: "g1", sceneIds: ["s01", "s02"], subject: "Shibuya", priority: 1, keywords: { ja: "渋谷", en: "shibuya crossing night" }, styleHints: style },
    { segmentId: "g2", sceneIds: ["s03"], subject: "ramen", priority: 2, keywords: { ja: "ラーメン", en: "" }, styleHints: style },
  ],
};

describe("pexelsQueryForScene (VE2E-38)", () => {
  it("uses the segment's English keywords when present", () => {
    expect(pexelsQueryForScene({ sceneId: "s02", visualQuery: "crowd" }, plan)).toBe("shibuya crossing night");
    expect(visualSegmentForScene(plan, "s02")?.segmentId).toBe("g1");
  });

  it("keeps the scene visualQuery without an en keyword or without a plan", () => {
    expect(pexelsQueryForScene({ sceneId: "s03", visualQuery: "ramen bowl" }, plan)).toBe("ramen bowl");
    expect(pexelsQueryForScene({ sceneId: "s01", visualQuery: "crowd" }, null)).toBe("crowd");
  });
});
