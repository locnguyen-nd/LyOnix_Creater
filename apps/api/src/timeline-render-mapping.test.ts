import { describe, expect, it } from "vitest";
import type { TemplateModificationSlotResponse } from "@lyonix/contracts";
import { buildRenderAssignmentsFromTimeline, captionOverrideFor, deriveDefaultVideoRange, resolveSceneBindingsForMapping, type SceneBindingForMapping } from "./timeline-render-mapping.js";

describe("captionOverrideFor (V03-03)", () => {
  it("an override equal to the voiced narration (whitespace ignored, what Auto writes) is not a real override", () => {
    expect(captionOverrideFor({ screenTextOverride: "東京の 夜景。\n人が多い。", audioNarration: "東京の夜景。人が多い。" })).toBeNull();
    expect(captionOverrideFor({ screenTextOverride: "Messi is a  football player.", audioNarration: "Messi is a football player." })).toBeNull();
  });

  it("keeps a human-typed override that differs from the narration, or when the narration is unknown", () => {
    expect(captionOverrideFor({ screenTextOverride: "Tiêu đề khác", audioNarration: "Lời đọc thật" })).toBe("Tiêu đề khác");
    expect(captionOverrideFor({ screenTextOverride: " Xin chào ", audioNarration: null })).toBe("Xin chào");
  });

  it("an empty or missing override is no override", () => {
    expect(captionOverrideFor({ screenTextOverride: "   ", audioNarration: "x" })).toBeNull();
    expect(captionOverrideFor({ screenTextOverride: null })).toBeNull();
  });

  it("resolveSceneBindingsForMapping carries the narration the bound voice was generated from", async () => {
    const prisma = {
      audioVersion: { findMany: async () => [{ id: "audio-1", mediaAssetVersionId: "media-audio-1", durationMs: 3000, sceneDraftVersion: { narration: "Lời đọc của cảnh" } }] },
      mediaAssetVersion: { findMany: async () => [] },
      sceneDraftVersion: { findMany: async () => [] },
    } as never;
    const [scene] = await resolveSceneBindingsForMapping(prisma, "project-1", [
      { sceneId: "s1", orderIndex: 0, mediaAssetVersionId: null, audioVersionId: "audio-1", subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false },
    ]);
    expect(scene!.audioNarration).toBe("Lời đọc của cảnh");
  });
});

const slots: TemplateModificationSlotResponse[] = [
  { key: "Video-1.source", kind: "video", label: "Video-1.source", required: true },
  { key: "Video-1.volume", kind: "volume", label: "Video-1.volume", required: false },
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
  excluded: false,
  mediaKind: null,
  audioMediaAssetVersionId: null,
  ...overrides,
});

describe("buildRenderAssignmentsFromTimeline", () => {
  it("maps Orshot subtitle and tag by page, without shifting text to later pages", () => {
    const pageSlots: TemplateModificationSlotResponse[] = [1, 2].flatMap((page) => [
      { key: `page${page}@media`, kind: "video" as const, label: "Media", required: true },
      { key: `page${page}@subtitle`, kind: "text" as const, label: "Subtitle", required: true },
      { key: `page${page}@tag`, kind: "text" as const, label: "Tag", required: true },
    ]);
    const scenes = [scene({ sceneId: "s1", orderIndex: 0, mediaKind: "video", mediaAssetVersionId: "m1", screenTextOverride: "Narration 1", fallbackScreenText: "Tag 1" }), scene({ sceneId: "s2", orderIndex: 1, mediaKind: "video", mediaAssetVersionId: "m2", screenTextOverride: "Narration 2", fallbackScreenText: "Tag 2" })];
    const built = buildRenderAssignmentsFromTimeline(pageSlots, scenes, {});
    expect(built.missingRequiredModificationKeys).toEqual([]);
    expect(built.assignments).toContainEqual({ modificationKey: "page2@subtitle", kind: "text", text: "Narration 2" });
    expect(built.assignments).toContainEqual({ modificationKey: "page2@tag", kind: "text", text: "Tag 2" });
    expect(built.videoSlotKeyBySceneId.s2).toBe("page2@media");
  });
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

  it("mutes a scene's own imported video by default (fetched clip audio is never the intended track)", () => {
    const scenes: SceneBindingForMapping[] = [scene({ mediaAssetVersionId: "media-1", mediaKind: "video" })];
    const built = buildRenderAssignmentsFromTimeline(slots, scenes, {});
    expect(built.assignments).toContainEqual({ modificationKey: "Video-1.volume", kind: "volume", volumePercent: 0 });
  });

  it("respects an explicit volume override instead of muting", () => {
    const scenes: SceneBindingForMapping[] = [scene({ mediaAssetVersionId: "media-1", mediaKind: "video" })];
    const built = buildRenderAssignmentsFromTimeline(slots, scenes, { "Video-1.volume": "65" });
    expect(built.assignments).toContainEqual({ modificationKey: "Video-1.volume", kind: "volume", volumePercent: 65 });
    expect(built.assignments.filter((a) => a.modificationKey === "Video-1.volume")).toHaveLength(1);
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
    sceneDraftVersion: {
      findMany: async ({ where }: any) =>
        [{ sceneId: "s1", screenText: "Script default for s1", projectId: "project-1" }]
          .filter((r) => where.sceneId.in.includes(r.sceneId) && r.projectId === where.scriptDraftVersion.sourceVersion.projectId)
          .map(({ sceneId, screenText }) => ({ sceneId, screenText })),
    },
  };

  it("resolves each scene's media kind and its audio binding's underlying asset id", async () => {
    const scenes = [
      { sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "media-1", audioVersionId: "audio-1", subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false },
      { sceneId: "s2", orderIndex: 1, mediaAssetVersionId: "media-2", audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false },
    ];
    const resolved = await resolveSceneBindingsForMapping(prisma, "project-1", scenes);
    expect(resolved[0]).toMatchObject({ mediaKind: "video", audioMediaAssetVersionId: "media-audio-1" });
    expect(resolved[1]).toMatchObject({ mediaKind: "image", audioMediaAssetVersionId: null });
  });

  it("treats a media id from another project as unbound (defense in depth)", async () => {
    const scenes = [{ sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "media-other-project", audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false }];
    const resolved = await resolveSceneBindingsForMapping(prisma, "project-1", scenes);
    expect(resolved[0]!.mediaKind).toBeNull();
  });

  it("resolves the scene's own script text as fallbackScreenText when no override is stored", async () => {
    const scenes = [
      { sceneId: "s1", orderIndex: 0, mediaAssetVersionId: null, audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false },
      { sceneId: "s2", orderIndex: 1, mediaAssetVersionId: null, audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false },
    ];
    const resolved = await resolveSceneBindingsForMapping(prisma, "project-1", scenes);
    expect(resolved[0]!.fallbackScreenText).toBe("Script default for s1");
    expect(resolved[1]!.fallbackScreenText).toBeNull();
  });
});

describe("deriveDefaultVideoRange (VE2E-44)", () => {
  const video = (overrides: Partial<SceneBindingForMapping> = {}) => scene({ mediaKind: "video", mediaAssetVersionId: "m1", mediaDurationMs: 60_000, audioDurationMs: 4000, ...overrides });

  it("derives [0, voice duration] for a long video without a range", () => {
    expect(deriveDefaultVideoRange(video())).toEqual({ sourceStartMs: 0, sourceDurationMs: 4000 });
  });
  it("caps at the asset duration (never longer than the source)", () => {
    expect(deriveDefaultVideoRange(video({ mediaDurationMs: 4300, audioDurationMs: 9000 }))).toBeNull(); // asset shorter than scene: sent whole
    expect(deriveDefaultVideoRange(video({ mediaDurationMs: 8000, audioDurationMs: 9000 }))).toBeNull();
  });
  it("skips an asset already <= scene duration + tolerance", () => {
    expect(deriveDefaultVideoRange(video({ mediaDurationMs: 4400 }))).toBeNull();
    expect(deriveDefaultVideoRange(video({ mediaDurationMs: 4501 }))).toEqual({ sourceStartMs: 0, sourceDurationMs: 4000 });
  });
  it("leaves images, existing ranges and unknown durations untouched", () => {
    expect(deriveDefaultVideoRange(video({ mediaKind: "image" }))).toBeNull();
    expect(deriveDefaultVideoRange(video({ sourceStartMs: 2000, sourceDurationMs: 1000 }))).toBeNull();
    expect(deriveDefaultVideoRange(video({ mediaDurationMs: null }))).toBeNull();
    expect(deriveDefaultVideoRange(video({ audioDurationMs: null }))).toBeNull();
  });
});
