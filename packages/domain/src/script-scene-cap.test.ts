import { describe, expect, it } from "vitest";
import { mergeScenesToCap } from "./script-scene-cap.js";

const scene = (n: number, narration = `n${n}`) => ({ sceneId: `scene${n}`, narration, screenText: `t${n}`, visualQuery: `q${n}`, durationHintMs: 3000 });
const draft = (count: number) => ({
  scenes: Array.from({ length: count }, (_, i) => scene(i + 1, "x".repeat(10 + (i % 3) * 5))),
  visualPlan: { segments: [
    { segmentId: "segment1", sceneIds: Array.from({ length: Math.ceil(count / 2) }, (_, i) => `scene${i + 1}`) },
    { segmentId: "segment2", sceneIds: Array.from({ length: Math.floor(count / 2) }, (_, i) => `scene${i + 1 + Math.ceil(count / 2)}`) },
  ] },
});

describe("mergeScenesToCap", () => {
  it("shortens 13 scenes to 10 by merging neighbours, keeping every character of narration", () => {
    const input = draft(13);
    const out = mergeScenesToCap(input, 10);
    expect(out.scenes).toHaveLength(10);
    expect(out.scenes.map((s) => s.narration).join(" ").replace(/ /g, "").length).toBe(input.scenes.map((s) => s.narration).join("").length);
    expect(out.scenes.reduce((sum, s) => sum + s.durationHintMs, 0)).toBe(13 * 3000);
  });
  it("remaps the visual plan to surviving scenes only (no dangling ids, no empty segments)", () => {
    const out = mergeScenesToCap(draft(13), 6);
    const ids = new Set(out.scenes.map((s) => s.sceneId));
    for (const segment of out.visualPlan!.segments) {
      expect(segment.sceneIds.length).toBeGreaterThan(0);
      for (const id of segment.sceneIds) expect(ids.has(id)).toBe(true);
    }
  });
  it("leaves a draft that already fits untouched", () => {
    const input = draft(8);
    expect(mergeScenesToCap(input, 10)).toBe(input);
  });
  it("works without a visual plan and with a cap of one", () => {
    const out = mergeScenesToCap({ scenes: draft(4).scenes }, 1);
    expect(out.scenes).toHaveLength(1);
  });
});
