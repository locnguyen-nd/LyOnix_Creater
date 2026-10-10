import { afterEach, describe, expect, it, vi } from "vitest";
import { parseScriptDraftV2WithDiagnostics, SCRIPT_DRAFT_V2_SCHEMA_VERSION } from "./script-draft-v2.js";
import { diagnoseScriptVisualPlanV2 } from "./script-visual-plan.js";
import { buildSegmentKeywordsPrompt, extractSegmentKeywords, parseSegmentKeywords } from "./segment-keywords.js";

// The Gemini strict schema is rejected in production ("Request contains an invalid argument"), so the free-form reply decides whether the
// script knows its subject: broken segments must not lose the videoSubject (that is what kept every person rule off for 佐々木朗希).
afterEach(() => { vi.unstubAllGlobals(); });

const roki = { main: "佐々木朗希", kind: "person", aliases: ["Roki Sasaki"], mustInclude: ["ドジャース"], mustExclude: [], otherPeople: [] };
const scene = (sceneId: string, narration: string) => ({ sceneId, narration, screenText: "x", visualQuery: "Roki Sasaki pitching", durationHintMs: 15_000 });
const script = (visualPlan: unknown, extra: Record<string, unknown> = {}) => ({ schemaVersion: SCRIPT_DRAFT_V2_SCHEMA_VERSION, language: "ja", title: "佐々木朗希の衝撃デマ騒動の真実", hook: "h", body: "b", cta: "c", caption: "#roki", scenes: [scene("s01", "佐々木朗希投手の噂"), scene("s02", "デマだった")], visualPlan, ...extra });
const goodSegment = (overrides: Record<string, unknown> = {}) => ({ segmentId: "g1", sceneIds: ["s01", "s02"], subject: "佐々木朗希", priority: 1, keywords: { ja: "佐々木朗希 投球", en: "Roki Sasaki pitch" }, styleHints: { setting: "stadium", timeOfDay: "night", lighting: "lights", palette: "blue" }, ...overrides });

describe("visualPlan salvage (free-form replies)", () => {
  it("accepts the snake_case / numeric ids models write without the schema", () => {
    const diagnosis = diagnoseScriptVisualPlanV2({ video_subject: roki, segments: [{ ...goodSegment(), segmentId: undefined, segment_id: 1, scene_ids: ["s01", "s02"], sceneIds: undefined, style_hints: goodSegment().styleHints, styleHints: undefined }] }, ["s01", "s02"]);
    expect(diagnosis.reason).toBeNull();
    expect(diagnosis.plan?.segments[0]?.segmentId).toBe("1");
    expect(diagnosis.plan?.videoSubject?.main).toBe("佐々木朗希");
  });

  it("broken segments keep the subject (subject-only plan) instead of dropping who the video is about", () => {
    const { draft, visualPlan } = parseScriptDraftV2WithDiagnostics(script({ videoSubject: roki, segments: [goodSegment({ priority: "high" })] }), "ja");
    expect(visualPlan).toMatchObject({ status: "rejected", reason: "priority_invalid", subjectOnly: true });
    expect(draft?.visualPlan).toEqual({ segments: [], videoSubject: { main: "佐々木朗希", kind: "person", aliases: ["Roki Sasaki"], mustInclude: ["ドジャース"], mustExclude: [] } });
  });

  it("a videoSubject written next to the scenes (outside the plan) is used too", () => {
    const { draft } = parseScriptDraftV2WithDiagnostics(script(null, { videoSubject: roki }), "ja");
    expect(draft?.visualPlan?.videoSubject?.main).toBe("佐々木朗希");
    expect(draft?.visualPlan?.segments).toEqual([]);
  });

  it("no subject anywhere -> unchanged (plan null)", () => {
    expect(parseScriptDraftV2WithDiagnostics(script({ segments: [goodSegment({ priority: "high" })] }), "ja").draft?.visualPlan).toBeNull();
  });
});

describe("keyword extraction names the subject when none is known", () => {
  it("asks for videoSubject (title lock: every phrase carries the person's name) and parses it", () => {
    const prompt = buildSegmentKeywordsPrompt({ language: "ja", title: "佐々木朗希の衝撃デマ騒動の真実", segments: [{ segmentId: "seg-1", narration: "佐々木朗希投手の噂" }] });
    expect(prompt).toContain("Also return videoSubject");
    expect(prompt).toContain("never a generic phrase such as \"baseball stadium\" or \"smartphone\"");
    expect(buildSegmentKeywordsPrompt({ language: "ja", subject: roki as never, segments: [{ segmentId: "seg-1", narration: "x" }] })).not.toContain("Also return videoSubject");
    const parsed = parseSegmentKeywords({ segments: [{ segmentId: "seg-1", ja: ["佐々木朗希 投球"], en: ["Roki Sasaki pitch"], broad_en: [], mood_en: "night" }], videoSubject: roki }, ["seg-1"]);
    expect(parsed.videoSubject).toMatchObject({ main: "佐々木朗希", kind: "person" });
    expect(parsed.keywords["seg-1"]?.en).toBe("Roki Sasaki pitch");
  });

  it("the schema carries videoSubject only when asked", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ output_text: JSON.stringify({ segments: [{ segmentId: "seg-1", ja: ["佐々木朗希 投球"], en: ["Roki Sasaki pitch"], broad_en: [], mood_en: "night" }], videoSubject: roki }) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await extractSegmentKeywords("openai", "sk-test", "gpt-4o-mini", { language: "ja", title: "佐々木朗希", segments: [{ segmentId: "seg-1", narration: "佐々木朗希投手" }] });
    expect(JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)))).toContain("videoSubject");
    expect(result.videoSubject?.main).toBe("佐々木朗希");
  });
});
