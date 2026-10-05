import { describe, expect, it } from "vitest";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1 } from "@lyonix/render-recipes";
import { buildComposePlan } from "./compose-plan.js";
import type { SceneBindingForMapping } from "./timeline-render-mapping.js";

const narration = "東京の夜景。人が多い。";

const scene = (overrides: Partial<SceneBindingForMapping>): SceneBindingForMapping => ({
  sceneId: "s1",
  orderIndex: 0,
  mediaAssetVersionId: "m1",
  audioVersionId: "a1",
  subtitleVersionId: null,
  screenTextOverride: null,
  annotation: null,
  excluded: false,
  mediaKind: "image",
  audioMediaAssetVersionId: "v1",
  audioDurationMs: 3000,
  audioNarration: narration,
  ...overrides,
});

const build = (sceneOverrides: Partial<SceneBindingForMapping>) =>
  buildComposePlan({
    scenes: [scene(sceneOverrides)],
    assets: new Map([
      ["m1", { relativePath: "projects/p/m1.jpg", checksumSha256: null }],
      ["v1", { relativePath: "projects/p/v1.mp3", checksumSha256: null }],
    ]),
    preparedMediaIds: new Set(),
    captions: new Map([["a1", { segments: [{ text: "東京の夜景。", startMs: 0, endMs: 1400 }, { text: "人が多い。", startMs: 1400, endMs: 2800 }], alignment: null }]]),
    optionValues: {},
    recipe: NEWS_RECAP_BROADCAST_TELOP_JP_V1,
    templateSnapshotId: "tpl-1",
  });

describe("buildComposePlan captions (V03-03, internal engine)", () => {
  it("an Auto override equal to the voiced narration keeps the voice-timed cues", () => {
    const built = build({ screenTextOverride: "東京の夜景。 人が多い。" });
    if (!built.ok) throw new Error(built.message);
    expect(built.renderPlan.scenes[0]!.captionCues.map((cue) => cue.text)).toEqual(["東京の夜景。", "人が多い。"]);
  });

  it("a human-typed override still replaces the cues with one static block", () => {
    const built = build({ screenTextOverride: "別のタイトル" });
    if (!built.ok) throw new Error(built.message);
    expect(built.renderPlan.scenes[0]!.captionCues).toEqual([]);
    expect(built.renderPlan.scenes[0]!.text).toBe("別のタイトル");
  });
});
