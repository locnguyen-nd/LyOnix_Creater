import { describe, expect, it } from "vitest";
import { assessPersonCoveragePreflight, type PersonMediaRole } from "./person-coverage.js";
import { describeTemplateSlotIssues, preflightTemplateSceneCount, preflightTemplateSlots, sceneMediaSlots, templateSceneCapacity, type TemplateSlotLike, type TemplateSlotScene } from "./template-slot-preflight.js";

// The template of run 19db79bb: 10 positional scene slots, images at scenes 1 / 4 / 7 / 10, videos elsewhere.
const KINDS: Array<"Image" | "Video"> = ["Image", "Video", "Video", "Image", "Video", "Video", "Image", "Video", "Video", "Image"];
const template = (count = 10): TemplateSlotLike[] =>
  Array.from({ length: count }, (_, i) => KINDS[i % KINDS.length]!).flatMap((kind, i) => [
    { key: `${kind}-${i + 1}.source`, kind: kind === "Image" ? "image" : "video", required: true },
    { key: `Subtitles-${i + 1}.text`, kind: "text", required: true },
    { key: `Voiceover-${i + 1}.source`, kind: "audio", required: false },
  ]);
const scene = (n: number, kind: "image" | "video" | null): TemplateSlotScene => ({ sceneId: `scene_${n}`, orderIndex: n - 1, visualKind: kind, mediaAssetVersionId: kind ? `asset-${n}` : null });
const matching = () => KINDS.map((kind, i) => scene(i + 1, kind === "Image" ? "image" : "video"));

describe("template slot preflight", () => {
  it("reads the positional scene media slots", () => {
    const slots = sceneMediaSlots(template());
    expect(slots.filter((slot) => slot.kind === "image").map((slot) => slot.sceneNumber)).toEqual([1, 4, 7, 10]);
    expect(templateSceneCapacity({ slots: template(), sceneCompositions: 0 })).toEqual({ mode: "fixed", maxScenes: 10, sceneSlots: 10 });
  });

  it("run 19db79bb: scenes 4 / 10 carried a video window -> Image-4 / Image-10 flagged (and Image-7 would be shifted)", () => {
    const scenes = matching();
    scenes[3] = scene(4, "video");
    scenes[9] = scene(10, "video");
    const check = preflightTemplateSlots(template(), scenes);
    expect(check.ok).toBe(false);
    expect(check.issues.map((issue) => issue.slotKey)).toEqual(["Image-4.source", "Image-10.source"]);
    expect(describeTemplateSlotIssues(check.issues)).toBe("Cảnh 4 (scene_4) -> Image-4.source: cần ảnh, đang là video; Cảnh 10 (scene_10) -> Image-10.source: cần ảnh, đang là video");
  });

  it("missing Image-7.source -> blocked with scene + slot; missing Image-10.source -> blocked", () => {
    const seven = matching();
    seven[6] = scene(7, null);
    expect(preflightTemplateSlots(template(), seven).issues).toEqual([{ sceneId: "scene_7", sceneNumber: 7, slotKey: "Image-7.source", expectedKind: "image", actualKind: null }]);
    const ten = matching();
    ten[9] = scene(10, "video");
    expect(preflightTemplateSlots(template(), ten).issues.map((issue) => issue.slotKey)).toEqual(["Image-10.source"]);
  });

  it("every required slot has a source of its kind -> ok", () => {
    expect(preflightTemplateSlots(template(), matching())).toEqual({ ok: true, issues: [] });
  });

  it("12 scenes on a fixed 10-slot template -> TEMPLATE_SCENE_COUNT_UNSUPPORTED (before any paid work)", () => {
    const check = preflightTemplateSceneCount({ slots: template(), sceneCompositions: 0, sceneCount: 12 });
    expect(check).toMatchObject({ ok: false, code: "TEMPLATE_SCENE_COUNT_UNSUPPORTED", message: "Template chỉ hỗ trợ 10 cảnh (slot cố định, không tự co giãn), kịch bản có 12 cảnh" });
  });

  it("8 scenes on a fixed 10-slot template -> the required slots of scenes 9 / 10 can never be filled", () => {
    const check = preflightTemplateSceneCount({ slots: template(), sceneCompositions: 0, sceneCount: 8 });
    expect(check).toMatchObject({ ok: false, code: "TEMPLATE_REQUIRED_ASSET_MISSING", missingKeys: ["Video-9.source", "Image-10.source"] });
  });

  it("a template with Scene compositions is re-composed for any count; an Orshot page template is capped elsewhere", () => {
    expect(preflightTemplateSceneCount({ slots: template(), sceneCompositions: 10, sceneCount: 12 }).ok).toBe(true);
    expect(templateSceneCapacity({ slots: template(), sceneCompositions: 0, orshotPages: 6 })).toMatchObject({ mode: "pages", maxScenes: 6 });
    expect(preflightTemplateSceneCount({ slots: template(), sceneCompositions: 0, sceneCount: 10 }).ok).toBe(true);
  });
});

describe("person coverage threshold (>= 60%)", () => {
  const roles = (list: PersonMediaRole[]) => list.map((mediaRole, i) => ({ sceneId: `s${i + 1}`, targetPerson: "佐々木朗希", mediaRole, identityConfidence: 0.8, verificationMethod: "vision" as const }));
  it("0% -> block; 6/10 (60%) with scene 1 and no 2 non-person in a row -> pass", () => {
    expect(assessPersonCoveragePreflight(roles(Array(10).fill("generic"))).ok).toBe(false);
    const sixty = assessPersonCoveragePreflight(roles(["person_primary", "person_primary", "context", "person_primary", "context", "person_primary", "context", "person_primary", "context", "person_primary"]));
    expect(sixty).toMatchObject({ ok: true, personCoverageRatio: 0.6, minCoverage: 0.6 });
  });
});
