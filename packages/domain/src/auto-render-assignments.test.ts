import { describe, expect, it } from "vitest";
import { buildAutoRenderAssignments, type AutoSceneMedia, type AutoTemplateSlot } from "./auto-render-assignments.js";

const scene = (overrides: Partial<AutoSceneMedia>): AutoSceneMedia => ({
  sceneId: "scene-1",
  orderIndex: 0,
  screenText: "",
  visualMediaAssetVersionId: null,
  visualKind: null,
  audioMediaAssetVersionId: null,
  ...overrides,
});

describe("buildAutoRenderAssignments", () => {
  it("fails fast on zero scenes", () => {
    expect(buildAutoRenderAssignments([], [])).toEqual({ ok: false, reason: "no_scenes" });
  });

  it("assigns video/text/audio slots positionally by scene order", () => {
    const slots: AutoTemplateSlot[] = [
      { key: "Video-1.source", kind: "video", required: true },
      { key: "Video-2.source", kind: "video", required: true },
      { key: "Text-1.text", kind: "text", required: true },
      { key: "Text-2.text", kind: "text", required: false },
      { key: "Audio-1.source", kind: "audio", required: false },
    ];
    const scenes: AutoSceneMedia[] = [
      scene({ sceneId: "s2", orderIndex: 1, screenText: "Cảnh hai", visualMediaAssetVersionId: "asset-2", visualKind: "video" }),
      scene({ sceneId: "s1", orderIndex: 0, screenText: "Cảnh một", visualMediaAssetVersionId: "asset-1", visualKind: "video", audioMediaAssetVersionId: "audio-1" }),
    ];
    const result = buildAutoRenderAssignments(slots, scenes);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Scene order (orderIndex asc) drives slot consumption, not array order.
    expect(result.assignments).toEqual([
      { modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "asset-1" },
      { modificationKey: "Audio-1.source", kind: "audio", mediaAssetVersionId: "audio-1" },
      { modificationKey: "Text-1.text", kind: "text", text: "Cảnh một" },
      { modificationKey: "Video-2.source", kind: "video", mediaAssetVersionId: "asset-2" },
      { modificationKey: "Text-2.text", kind: "text", text: "Cảnh hai" },
    ]);
  });

  it("keeps video and image queues separate by kind", () => {
    const slots: AutoTemplateSlot[] = [
      { key: "Image-1.source", kind: "image", required: true },
      { key: "Video-1.source", kind: "video", required: true },
    ];
    const scenes: AutoSceneMedia[] = [
      scene({ orderIndex: 0, visualMediaAssetVersionId: "img-1", visualKind: "image" }),
      scene({ orderIndex: 1, visualMediaAssetVersionId: "vid-1", visualKind: "video" }),
    ];
    const result = buildAutoRenderAssignments(slots, scenes);
    expect(result).toEqual({
      ok: true,
      assignments: [
        { modificationKey: "Image-1.source", kind: "image", mediaAssetVersionId: "img-1" },
        { modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "vid-1" },
      ],
    });
  });

  it("fills leftover required text slots from title/caption after scenes are exhausted", () => {
    const slots: AutoTemplateSlot[] = [
      { key: "Text-1.text", kind: "text", required: true },
      { key: "Text-2.text", kind: "text", required: true },
    ];
    const scenes: AutoSceneMedia[] = [scene({ orderIndex: 0, screenText: "Nội dung" })];
    const result = buildAutoRenderAssignments(slots, scenes, { title: "Tiêu đề", caption: "Caption" });
    expect(result).toEqual({
      ok: true,
      assignments: [
        { modificationKey: "Text-1.text", kind: "text", text: "Nội dung" },
        { modificationKey: "Text-2.text", kind: "text", text: "Tiêu đề" },
      ],
    });
  });

  it("fails with the exact missing required keys when a slot cannot be filled", () => {
    const slots: AutoTemplateSlot[] = [
      { key: "Video-1.source", kind: "video", required: true },
      { key: "Video-2.source", kind: "video", required: true },
    ];
    const scenes: AutoSceneMedia[] = [scene({ orderIndex: 0, visualMediaAssetVersionId: "asset-1", visualKind: "video" })];
    const result = buildAutoRenderAssignments(slots, scenes);
    expect(result).toEqual({ ok: false, reason: "missing_required_slot", missingKeys: ["Video-2.source"] });
  });

  it("does not cross-fill a video asset into an image-only slot queue (kind mismatch left unfilled)", () => {
    const slots: AutoTemplateSlot[] = [{ key: "Image-1.source", kind: "image", required: true }];
    const scenes: AutoSceneMedia[] = [scene({ orderIndex: 0, visualMediaAssetVersionId: "vid-1", visualKind: "video" })];
    const result = buildAutoRenderAssignments(slots, scenes);
    expect(result).toEqual({ ok: false, reason: "missing_required_slot", missingKeys: ["Image-1.source"] });
  });

  it("ignores optional slots that cannot be filled", () => {
    const slots: AutoTemplateSlot[] = [
      { key: "Video-1.source", kind: "video", required: true },
      { key: "Audio-1.source", kind: "audio", required: false },
    ];
    const scenes: AutoSceneMedia[] = [scene({ orderIndex: 0, visualMediaAssetVersionId: "asset-1", visualKind: "video" })];
    const result = buildAutoRenderAssignments(slots, scenes);
    expect(result).toEqual({
      ok: true,
      assignments: [{ modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "asset-1" }],
    });
  });
});
