import { describe, expect, it } from "vitest";
import { captionPlanFromScript, parseCaptionPlan, splitSpokenCaptions } from "./caption-plan-v1.js";
import { SCRIPT_DRAFT_SCHEMA_VERSION, type ScriptDraftV1 } from "./script-draft-v1.js";

const script: ScriptDraftV1 = {
  schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
  language: "vi",
  title: "Messi",
  hook: "3 giây",
  body: "Câu một. Câu hai dài hơn một chút để tách caption.",
  cta: "Theo dõi",
  caption: "Messi",
  scenes: [
    { sceneId: "s01", narration: "Câu một. Câu hai dài hơn một chút để tách caption.", screenText: "1", visualBrief: "sân", estimatedDurationMs: 5000 },
    { sceneId: "s02", narration: "Kết.", screenText: "2", visualBrief: "khán đài", estimatedDurationMs: 4000 },
  ],
};

describe("caption plan", () => {
  it("splits spoken text into short untimed segments", () => {
    const segs = splitSpokenCaptions("Một nhịp chạm bóng, một lần đổi hướng rất rõ.");
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.every((seg) => seg.text.length <= 48)).toBe(true);
  });

  it("keeps every sceneId when the model returns a complete plan", () => {
    const fallback = captionPlanFromScript(script);
    const parsed = parseCaptionPlan({
      schemaVersion: "caption-plan.v1",
      language: "vi",
      voiceDelegation: "vrew",
      scenes: fallback.scenes.map((scene) => ({
        ...scene,
        visualIntent: `${scene.visualIntent} live`,
      })),
    }, "vi", fallback);
    expect(parsed?.scenes.map((scene) => scene.sceneId)).toEqual(["s01", "s02"]);
    expect(parsed?.scenes[0]?.visualIntent).toContain("live");
  });

  it("rejects a plan that drops a scene", () => {
    const fallback = captionPlanFromScript(script);
    expect(parseCaptionPlan({ scenes: [fallback.scenes[0]] }, "vi", fallback)).toBeNull();
  });
});
