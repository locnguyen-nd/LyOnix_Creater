import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { buildSegmentKeywordsPrompt, extractSegmentKeywords, parseSegmentKeywords } from "./segment-keywords.js";
import { diagnoseScriptVisualPlanV2, isValidEnSearchKeyword, isValidJaSearchKeyword, sanitizeVisualPlanJaKeywords } from "./script-visual-plan.js";
import { SCRIPT_DRAFT_V2_SCHEMA_VERSION, buildScriptV2PromptPackage, parseScriptDraftV2WithDiagnostics } from "./script-draft-v2.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("VE2E-50 ja/en search keyword validation", () => {
  it("accepts short real Japanese phrases and rejects English shot descriptions", () => {
    for (const ok of ["東京 夜景", "渋谷 スクランブル交差点", "メッシ", "iPhone 発売", "ラーメン"]) expect(isValidJaSearchKeyword(ok), ok).toBe(true);
    for (const bad of ["", "   ", "Flashy news intro, breaking news graphic, urgent atmosphere", "tokyo night", "東京の夜景を上から撮影した映像を見せます。", "東京, 夜景", "一 二 三 四 五 六", "あ".repeat(41), 5, null]) {
      expect(isValidJaSearchKeyword(bad), String(bad)).toBe(false);
    }
  });

  it("validates short English phrases", () => {
    expect(isValidEnSearchKeyword("tokyo night skyline")).toBe(true);
    expect(isValidEnSearchKeyword("")).toBe(false);
    expect(isValidEnSearchKeyword("a very long sentence describing the shot in detail here.")).toBe(false);
  });
});

const style = { setting: "s", timeOfDay: "t", lighting: "l", palette: "p" };
const seg = (segmentId: string, sceneIds: string[], ja: string, en = "tokyo night") => ({ segmentId, sceneIds, subject: "x", priority: 1, keywords: { ja, en }, styleHints: style });

describe("VE2E-50 visualPlan handling", () => {
  it("blanks an invalid ja keyword (keeps en) and reports the segment for the extraction", () => {
    const plan = { segments: [seg("g1", ["s01"], "东京 夜景").valueOf(), seg("g2", ["s02"], "Breaking news intro, urgent") ] } as never;
    const { plan: sanitized, invalidJaSegmentIds } = sanitizeVisualPlanJaKeywords(plan);
    expect(invalidJaSegmentIds).toEqual(["g2"]);
    expect(sanitized.segments[1]!.keywords).toEqual({ ja: "", en: "tokyo night" });
    expect(sanitized.segments[0]!.keywords.ja).toBe("东京 夜景");
  });

  it("diagnoses why a plan is dropped", () => {
    const ids = ["s01", "s02"];
    expect(diagnoseScriptVisualPlanV2(undefined, ids)).toMatchObject({ plan: null, reason: "absent" });
    expect(diagnoseScriptVisualPlanV2(null, ids)).toMatchObject({ plan: null, reason: "null" });
    expect(diagnoseScriptVisualPlanV2({ segments: [seg("g1", ["s01"], "東京")] }, ids)).toMatchObject({ plan: null, reason: "scenes_not_fully_covered" });
    expect(diagnoseScriptVisualPlanV2({ segments: [seg("g1", ["s01", "s99"], "東京")] }, ids)).toMatchObject({ plan: null, reason: "scenes_not_consecutive" });
    expect(diagnoseScriptVisualPlanV2({ segments: [seg("g1", ["s02", "s01"], "東京")] }, ids)).toMatchObject({ plan: null, reason: "scenes_not_consecutive" });
    expect(diagnoseScriptVisualPlanV2({ segments: [seg("g1", ["s01", "s02"], "", "")] }, ids)).toMatchObject({ plan: null, reason: "keywords_invalid" });
    expect(diagnoseScriptVisualPlanV2({ segments: [seg("g1", ["s01", "s02"], "東京")] }, ids)).toMatchObject({ reason: null });
  });

  it("parseScriptDraftV2WithDiagnostics returns the reason and the segments with invalid ja", () => {
    const scenes = ["s01", "s02"].map((sceneId) => ({ sceneId, narration: `N ${sceneId}.`, screenText: sceneId, visualQuery: "English shot description", durationHintMs: 20_000 }));
    const base = { schemaVersion: SCRIPT_DRAFT_V2_SCHEMA_VERSION, language: "ja", title: "t", hook: "h", body: "b", cta: "c", caption: "cap", scenes };
    const missing = parseScriptDraftV2WithDiagnostics({ ...base }, "ja");
    expect(missing.draft?.visualPlan).toBeNull();
    expect(missing.visualPlan).toMatchObject({ status: "missing", reason: "absent" });
    const rejected = parseScriptDraftV2WithDiagnostics({ ...base, visualPlan: { segments: [seg("g1", ["s01"], "東京")] } }, "ja");
    expect(rejected.visualPlan).toMatchObject({ status: "rejected", reason: "scenes_not_fully_covered", detail: "1/2" });
    const englishJa = parseScriptDraftV2WithDiagnostics({ ...base, visualPlan: { segments: [seg("g1", ["s01", "s02"], "Flashy news intro")] } }, "ja");
    expect(englishJa.visualPlan).toMatchObject({ status: "ok", invalidJaSegmentIds: ["g1"] });
    expect(englishJa.draft?.visualPlan?.segments[0]!.keywords).toEqual({ ja: "", en: "tokyo night" });
  });

  it("the script prompt asks for short real 2-4 word ja/en phrases and forbids shot descriptions", () => {
    const prompt = buildScriptV2PromptPackage({ sourceType: "topic", sourceText: "x", language: "ja" }).text;
    expect(prompt).toContain("2-4 words");
    expect(prompt).toContain("NEVER a camera direction");
    expect(prompt).toContain("script-prompt.v2.2");
  });
});

describe("VE2E-50 segment keyword extraction", () => {
  it("builds one prompt for all segments from the narration only", () => {
    const prompt = buildSegmentKeywordsPrompt({ language: "ja", title: "夜の東京", segments: [{ segmentId: "seg-1", narration: "新宿の夜景です。" }, { segmentId: "seg-2", narration: "渋谷の交差点です。" }] });
    expect(prompt).toContain("- seg-1: 新宿の夜景です。");
    expect(prompt).toContain("- seg-2: 渋谷の交差点です。");
    expect(prompt).not.toContain("visualQuery");
  });

  it("keeps only known segments with a valid ja keyword", () => {
    const out = parseSegmentKeywords({ segments: [{ segmentId: "a", ja: "新宿 夜景", en: "shinjuku night" }, { segmentId: "b", ja: "night view", en: "night view" }, { segmentId: "zzz", ja: "東京", en: "tokyo" }, { segmentId: "c", ja: "渋谷", en: "A long English sentence with many many words in it." }] }, ["a", "b", "c"]);
    expect(out.keywords).toEqual({ a: { ja: "新宿 夜景", en: "shinjuku night" }, c: { ja: "渋谷", en: "" } });
    expect(out.rejectedSegmentIds).toEqual(["b"]);
    expect(parseSegmentKeywords("garbage", ["a"])).toEqual({ keywords: {}, rejectedSegmentIds: ["a"] });
  });

  it("makes ONE provider call for all segments and returns usage", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; input: string };
      expect(body.input).toContain("seg-1");
      expect(body.input).toContain("seg-2");
      return new Response(JSON.stringify({ output_text: JSON.stringify({ segments: [{ segmentId: "seg-1", ja: "新宿 夜景", en: "shinjuku night" }, { segmentId: "seg-2", ja: "English only", en: "x" }] }), usage: { input_tokens: 210, output_tokens: 30 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await extractSegmentKeywords("openai", "sk-test", "gpt-4o-mini", { language: "ja", segments: [{ segmentId: "seg-1", narration: "a" }, { segmentId: "seg-2", narration: "b" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.keywords).toEqual({ "seg-1": { ja: "新宿 夜景", en: "shinjuku night" } });
    expect(result.rejectedSegmentIds).toEqual(["seg-2"]);
    expect(result.usage).toMatchObject({ inputTokens: 210, outputTokens: 30 });
  });

  it("surfaces provider errors and refuses an empty segment list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "rate" } }), { status: 429 })));
    await expect(extractSegmentKeywords("openai", "sk-test", "gpt-4o-mini", { language: "ja", segments: [{ segmentId: "a", narration: "n" }] })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    await expect(extractSegmentKeywords("openai", "sk-test", "gpt-4o-mini", { language: "ja", segments: [] })).rejects.toBeInstanceOf(ProviderError);
  });
});
