import { describe, expect, it } from "vitest";
import { SCRIPT_DRAFT_V2_JSON_SCHEMA, SCRIPT_DRAFT_V2_SCHEMA_VERSION, buildScriptV2PromptPackage, parseScriptDraftV2 } from "./script-draft-v2.js";
import { findVisualSegmentForScene, mediaSearchQueryForScene, normalizeScriptVisualPlanV2 } from "./script-visual-plan.js";

const style = { setting: "Tokyo side street", timeOfDay: "evening", lighting: "neon, soft", palette: "warm orange + teal" };
const segment = (segmentId: string, sceneIds: string[], extra: Record<string, unknown> = {}) => ({
  segmentId,
  sceneIds,
  subject: `subject ${segmentId}`,
  priority: 1,
  keywords: { ja: "渋谷 夜 路地", en: "tokyo alley at night" },
  styleHints: style,
  ...extra,
});

const draft = (visualPlan: unknown, sceneIds = ["s01", "s02", "s03", "s04"]) => ({
  schemaVersion: SCRIPT_DRAFT_V2_SCHEMA_VERSION,
  language: "ja",
  title: "タイトル",
  hook: "フック",
  body: "本文",
  cta: "フォローしてね",
  caption: "#tokyo",
  scenes: sceneIds.map((sceneId) => ({ sceneId, narration: `Narration ${sceneId}.`, screenText: sceneId, visualQuery: `query ${sceneId}`, durationHintMs: 10_000 })),
  visualPlan,
});

describe("parseScriptDraftV2 visualPlan (VE2E-38)", () => {
  it("parses a valid plan covering every scene in order", () => {
    const parsed = parseScriptDraftV2(draft({ segments: [segment("g1", ["s01", "s02"]), segment("g2", ["s03", "s04"], { priority: 2, keywords: { ja: "", en: "ramen shop counter" } })] }), "ja");
    expect(parsed?.visualPlan).toEqual({
      segments: [
        { segmentId: "g1", sceneIds: ["s01", "s02"], subject: "subject g1", priority: 1, keywords: { ja: "渋谷 夜 路地", en: "tokyo alley at night" }, styleHints: style },
        { segmentId: "g2", sceneIds: ["s03", "s04"], subject: "subject g2", priority: 2, keywords: { ja: "", en: "ramen shop counter" }, styleHints: style },
      ],
    });
  });

  it("is null (old behavior, script unaffected) when visualPlan is missing, null or not an object", () => {
    for (const value of [undefined, null, "plan", [], {}]) {
      const parsed = parseScriptDraftV2(draft(value), "ja");
      expect(parsed?.visualPlan).toBeNull();
      expect(parsed?.scenes.map((s) => s.sceneId)).toEqual(["s01", "s02", "s03", "s04"]);
    }
  });

  it("is null for non-consecutive, overlapping, out-of-order, partial-coverage or unknown scene references", () => {
    const invalidPlans = [
      [segment("g1", ["s01", "s03"]), segment("g2", ["s02", "s04"])],
      [segment("g1", ["s01", "s02"]), segment("g2", ["s02", "s03", "s04"])],
      [segment("g2", ["s03", "s04"]), segment("g1", ["s01", "s02"])],
      [segment("g1", ["s01", "s02"])],
      [segment("g1", ["s01", "s02"]), segment("g2", ["s03", "s99"])],
    ];
    for (const segments of invalidPlans) expect(parseScriptDraftV2(draft({ segments }), "ja")?.visualPlan).toBeNull();
  });

  it("is null for duplicate segment ids, bad priority, missing keywords/styleHints, or both keywords empty", () => {
    const bad = [
      [segment("g1", ["s01", "s02"]), segment("g1", ["s03", "s04"])],
      [segment("g1", ["s01", "s02", "s03", "s04"], { priority: 0 })],
      [segment("g1", ["s01", "s02", "s03", "s04"], { priority: 1.5 })],
      [segment("g1", ["s01", "s02", "s03", "s04"], { keywords: undefined })],
      [segment("g1", ["s01", "s02", "s03", "s04"], { keywords: { ja: "", en: " " } })],
      [segment("g1", ["s01", "s02", "s03", "s04"], { styleHints: { setting: "x" } })],
    ];
    for (const segments of bad) expect(parseScriptDraftV2(draft({ segments }), "ja")?.visualPlan).toBeNull();
  });

  it("re-points a segment at the split scenes when a multi-sentence scene is auto-split", () => {
    const raw = draft({ segments: [segment("g1", ["s01", "s02"]), segment("g2", ["s03"])] }, ["s01", "s02", "s03"]);
    raw.scenes[1] = { ...raw.scenes[1]!, narration: "First sentence here. Second sentence here." };
    const parsed = parseScriptDraftV2(raw, "ja");
    expect(parsed?.scenes.map((s) => s.sceneId)).toEqual(["s01", "s02-1", "s02-2", "s03"]);
    expect(parsed?.visualPlan?.segments.map((s) => s.sceneIds)).toEqual([["s01", "s02-1", "s02-2"], ["s03"]]);
  });
});

describe("normalizeScriptVisualPlanV2", () => {
  it("rejects more than 10 segments", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `s${i}`);
    expect(normalizeScriptVisualPlanV2({ segments: ids.map((id, i) => segment(`g${i}`, [id])) }, ids)).toBeNull();
  });
});

describe("mediaSearchQueryForScene", () => {
  const plan = { segments: [{ ...segment("g1", ["s01"]), keywords: { ja: "渋谷", en: "shibuya crossing" } }, { ...segment("g2", ["s02"]), keywords: { ja: "ラーメン", en: "" } }] } as never;

  it("uses the segment keywords.en when present", () => {
    expect(mediaSearchQueryForScene({ sceneId: "s01", visualQuery: "crowd", narration: "n" }, plan)).toBe("shibuya crossing");
    expect(findVisualSegmentForScene(plan, "s01")?.segmentId).toBe("g1");
  });

  it("falls back to visualQuery, then narration (pre-VE2E-38 behavior) without en keywords or plan", () => {
    expect(mediaSearchQueryForScene({ sceneId: "s02", visualQuery: "ramen bowl", narration: "n" }, plan)).toBe("ramen bowl");
    expect(mediaSearchQueryForScene({ sceneId: "s01", visualQuery: " ", narration: "the narration" }, null)).toBe("the narration");
    expect(findVisualSegmentForScene(null, "s01")).toBeNull();
  });
});

describe("prompt + schema (VE2E-38)", () => {
  it("asks for the requested segment range, or the default 3-5 for this prompt's 55-65s target", () => {
    expect(buildScriptV2PromptPackage({ sourceType: "topic", sourceText: "x", language: "ja" }).text).toContain("split the scenes into 3-5 background segments");
    expect(buildScriptV2PromptPackage({ sourceType: "topic", sourceText: "x", language: "ja", backgroundSegmentRange: { min: 2, max: 3 } }).text).toContain("into 2-3 background segments");
    expect(buildScriptV2PromptPackage({ sourceType: "topic", sourceText: "x", language: "ja", backgroundSegmentRange: { min: 4, max: 4 } }).text).toContain("into exactly 4 background segments");
    // invalid range -> default rule, never a nonsense instruction
    expect(buildScriptV2PromptPackage({ sourceType: "topic", sourceText: "x", language: "ja", backgroundSegmentRange: { min: 5, max: 2 } }).text).toContain("into 3-5 background segments");
    const pkg = buildScriptV2PromptPackage({ sourceType: "topic", sourceText: "x", language: "ja" });
    expect(pkg.text).toContain("broad_en");
    expect(pkg.promptTemplateVersion).toBe("script-prompt.v2.3");
  });

  it("declares visualPlan as a required-but-nullable property (strict structured output compatible)", () => {
    const schema = SCRIPT_DRAFT_V2_JSON_SCHEMA as { required: string[]; properties: Record<string, { anyOf?: Array<{ type: string }> }> };
    expect(schema.required).toContain("visualPlan");
    expect(schema.properties.visualPlan?.anyOf?.map((option) => option.type)).toEqual(["null", "object"]);
  });
});
