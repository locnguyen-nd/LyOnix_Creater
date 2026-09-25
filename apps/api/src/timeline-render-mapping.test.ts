import { describe, expect, it } from "vitest";
import type { TemplateModificationSlotResponse } from "@lyonix/contracts";
import { buildRenderAssignmentsFromTimeline, resolveSceneBindingsForMapping, type SceneBindingForMapping } from "./timeline-render-mapping.js";

const slots: TemplateModificationSlotResponse[] = [
  { key: "Video-1.source", kind: "video", label: "Video-1.source", required: true },
  { key: "Video-2.source", kind: "video", label: "Video-2.source", required: false },
  { key: "Text-1.text", kind: "text", label: "Text-1.text", required: true },
  { key: "Text-1.fill_color", kind: "color", label: "Text-1.fill_color", required: false },
  { key: "Audio-1.volume", kind: "volume", label: "Audio-1.volume", required: false },
];

const scene = (overrides: Partial<SceneBindingForMapping>): SceneBindingForMapping => ({
  sceneId: "s1",
  orderIndex: 0,
  mediaAssetVersionId: null,
  audioVersionId: null,
  subtitleVersionId: null,
  screenTextOverride: null,
  annotation: null,
  mediaKind: null,
  audioMediaAssetVersionId: null,
  ...overrides,
});

describe("buildRenderAssignmentsFromTimeline", () => {
  it("zips ordered scenes onto same-kind slots positionally", () => {
    const scenes: SceneBindingForMapping[] = [
      scene({ sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "media-1", mediaKind: "video", screenTextOverride: "Hello" }),
      scene({ sceneId: "s2", orderIndex: 1, mediaAssetVersionId: "media-2", mediaKind: "video" }),
    ];
    const built = buildRenderAssignmentsFromTimeline(slots, scenes, {});
    expect(built.assignments).toContainEqual({ modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "media-1" });
    expect(built.assignments).toContainEqual({ modificationKey: "Video-2.source", kind: "video", mediaAssetVersionId: "media-2" });
    expect(built.assignments).toContainEqual({ modificationKey: "Text-1.text", kind: "text", text: "Hello" });
    expect(built.missingRequiredModificationKeys).toEqual([]);
  });

  it("reports a missing required slot when no scene fills it", () => {
    const built = buildRenderAssignmentsFromTimeline(slots, [], {});
    expect(built.missingRequiredModificationKeys).toContain("Video-1.source");
    expect(built.missingRequiredModificationKeys).toContain("Text-1.text");
  });

  it("fills leftover color/volume slots from optionValues, never video/image/audio", () => {
    const scenes: SceneBindingForMapping[] = [scene({ mediaAssetVersionId: "media-1", mediaKind: "video", screenTextOverride: "Hi" })];
    const built = buildRenderAssignmentsFromTimeline(slots, scenes, { "Text-1.fill_color": "#ffffff", "Audio-1.volume": "80", "Video-2.source": "should-be-ignored" });
    expect(built.assignments).toContainEqual({ modificationKey: "Text-1.fill_color", kind: "color", color: "#ffffff" });
    expect(built.assignments).toContainEqual({ modificationKey: "Audio-1.volume", kind: "volume", volumePercent: 80 });
    expect(built.assignments.find((a) => a.modificationKey === "Video-2.source")).toBeUndefined();
  });

  it("falls back to a scene's own screen text when no override is set", () => {
    const scenes: SceneBindingForMapping[] = [scene({ fallbackScreenText: "From script" })];
    const built = buildRenderAssignmentsFromTimeline(slots, scenes, {});
    expect(built.assignments).toContainEqual({ modificationKey: "Text-1.text", kind: "text", text: "From script" });
  });

  it("assigns a scene's bound audio asset to an audio-kind slot", () => {
    const audioSlots: TemplateModificationSlotResponse[] = [...slots, { key: "Audio-1.source", kind: "audio", label: "Audio-1.source", required: false }];
    const scenes: SceneBindingForMapping[] = [scene({ audioVersionId: "audio-1", audioMediaAssetVersionId: "media-audio-1" })];
    const built = buildRenderAssignmentsFromTimeline(audioSlots, scenes, {});
    expect(built.assignments).toContainEqual({ modificationKey: "Audio-1.source", kind: "audio", mediaAssetVersionId: "media-audio-1" });
  });

  it("respects scene order (orderIndex), not array insertion order", () => {
    const scenes: SceneBindingForMapping[] = [
      scene({ sceneId: "second", orderIndex: 1, mediaAssetVersionId: "media-2", mediaKind: "video" }),
      scene({ sceneId: "first", orderIndex: 0, mediaAssetVersionId: "media-1", mediaKind: "video" }),
    ];
    const built = buildRenderAssignmentsFromTimeline(slots, scenes, {});
    expect(built.assignments).toContainEqual({ modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "media-1" });
    expect(built.assignments).toContainEqual({ modificationKey: "Video-2.source", kind: "video", mediaAssetVersionId: "media-2" });
  });
});

describe("resolveSceneBindingsForMapping", () => {
  const prisma: any = {
    audioVersion: { findMany: async ({ where }: any) => [{ id: "audio-1", mediaAssetVersionId: "media-audio-1" }].filter((r) => where.id.in.includes(r.id)) },
    mediaAssetVersion: {
      findMany: async ({ where }: any) =>
        [
          { id: "media-1", kind: "video", projectId: "project-1" },
          { id: "media-2", kind: "image", projectId: "project-1" },
          { id: "media-audio-1", kind: "audio", projectId: "project-1" },
          { id: "media-other-project", kind: "video", projectId: "project-2" },
        ].filter((r) => where.id.in.includes(r.id) && r.projectId === where.projectId),
    },
  };

  it("resolves each scene's media kind and its audio binding's underlying asset id", async () => {
    const scenes = [
      { sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "media-1", audioVersionId: "audio-1", subtitleVersionId: null, screenTextOverride: null, annotation: null },
      { sceneId: "s2", orderIndex: 1, mediaAssetVersionId: "media-2", audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null },
    ];
    const resolved = await resolveSceneBindingsForMapping(prisma, "project-1", scenes);
    expect(resolved[0]).toMatchObject({ mediaKind: "video", audioMediaAssetVersionId: "media-audio-1" });
    expect(resolved[1]).toMatchObject({ mediaKind: "image", audioMediaAssetVersionId: null });
  });

  it("treats a media id from another project as unbound (defense in depth)", async () => {
    const scenes = [{ sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "media-other-project", audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null }];
    const resolved = await resolveSceneBindingsForMapping(prisma, "project-1", scenes);
    expect(resolved[0]!.mediaKind).toBeNull();
  });
});
