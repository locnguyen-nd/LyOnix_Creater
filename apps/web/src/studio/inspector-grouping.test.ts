import { describe, expect, it } from "vitest";
import type { TemplateModificationSlotResponse } from "@lyonix/contracts";
import { groupTemplateOptionsByScene } from "./inspector-grouping.js";

const slots: TemplateModificationSlotResponse[] = [
  { key: "Video-1.source", kind: "video", label: "Video-1.source", required: true },
  { key: "Video-1.volume", kind: "volume", label: "Video-1.volume", required: false },
  { key: "Video-2.source", kind: "video", label: "Video-2.source", required: false },
  { key: "Video-2.volume", kind: "volume", label: "Video-2.volume", required: false },
  { key: "Subtitles-1.text", kind: "text", label: "Subtitles-1.text", required: true },
  { key: "Subtitles-1.font_family", kind: "font", label: "Subtitles-1.font_family", required: false },
  { key: "Subtitles-1.fill_color", kind: "color", label: "Subtitles-1.fill_color", required: false },
  { key: "Subtitles-2.text", kind: "text", label: "Subtitles-2.text", required: true },
  { key: "Subtitles-2.font_family", kind: "font", label: "Subtitles-2.font_family", required: false },
  { key: "Subtitles-2.fill_color", kind: "color", label: "Subtitles-2.fill_color", required: false },
];

describe("groupTemplateOptionsByScene", () => {
  it("groups each element's secondary options under the scene that positionally fills it", () => {
    const { bySceneId } = groupTemplateOptionsByScene(slots, [{ sceneId: "s1" }, { sceneId: "s2" }]);
    const s1Keys = bySceneId.get("s1")!.map((slot) => slot.key);
    const s2Keys = bySceneId.get("s2")!.map((slot) => slot.key);
    expect(s1Keys.sort()).toEqual(["Subtitles-1.fill_color", "Subtitles-1.font_family", "Video-1.volume"]);
    expect(s2Keys.sort()).toEqual(["Subtitles-2.fill_color", "Subtitles-2.font_family", "Video-2.volume"]);
  });

  it("never includes a group's own primary video/image/audio/text slot", () => {
    const { bySceneId } = groupTemplateOptionsByScene(slots, [{ sceneId: "s1" }]);
    const keys = bySceneId.get("s1")!.map((slot) => slot.key);
    expect(keys).not.toContain("Video-1.source");
    expect(keys).not.toContain("Subtitles-1.text");
  });

  it("puts a template element beyond the scene count into leftover, not a phantom scene", () => {
    const { bySceneId, leftover } = groupTemplateOptionsByScene(slots, [{ sceneId: "s1" }]);
    expect(bySceneId.has("s2")).toBe(false);
    expect(leftover.map((slot) => slot.key).sort()).toEqual(["Subtitles-2.fill_color", "Subtitles-2.font_family", "Video-2.volume"]);
  });

  it("returns an empty group for a scene with no matching template element", () => {
    const { bySceneId } = groupTemplateOptionsByScene(slots, [{ sceneId: "s1" }, { sceneId: "s2" }, { sceneId: "s3" }]);
    expect(bySceneId.get("s3")).toEqual([]);
  });
});
