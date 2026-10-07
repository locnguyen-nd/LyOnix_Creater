import { describe, expect, it } from "vitest";
import { SCRIPT_DRAFT_V2_SCHEMA_VERSION, buildScriptV2PromptPackage, parseScriptDraftV2WithDiagnostics } from "./script-draft-v2.js";
import { mediaSearchQueryForScene, normalizeScriptVisualPlanV2, sanitizeVisualPlanKeywords, searchTiersForKeywords } from "./script-visual-plan.js";
import { buildSegmentKeywordsPrompt, parseSegmentKeywords } from "./segment-keywords.js";
import { filterPhrasesBySubject, parseVideoSubject, phraseMatchesSubject } from "./subject-keywords.js";

const style = { setting: "a", timeOfDay: "b", lighting: "c", palette: "d" };
const playerA = { main: "Kylian Mbappé", aliases: ["エムバペ"], mustInclude: ["Real Madrid"], mustExclude: ["Haaland"] };
const seg = (id: string, sceneIds: string[], keywords: unknown, priority = 1) => ({ segmentId: id, sceneIds, subject: "x", priority, keywords, styleHints: style });
const draft = (visualPlan: unknown) => ({
  schemaVersion: SCRIPT_DRAFT_V2_SCHEMA_VERSION,
  language: "ja",
  title: "t",
  hook: "h",
  body: "b",
  cta: "c",
  caption: "#x",
  scenes: ["s01", "s02"].map((sceneId) => ({ sceneId, narration: `N ${sceneId}.`, screenText: sceneId, visualQuery: `q ${sceneId}`, durationHintMs: 10_000 })),
  visualPlan,
});

describe("subject matching (player A / story B)", () => {
  const subject = parseVideoSubject(playerA)!;
  it("matches name, alias, name token (diacritics-insensitive) and mustInclude", () => {
    for (const phrase of ["Mbappe goal", "kylian mbappé interview", "エムバペ ゴール", "Real Madrid training"]) expect(phraseMatchesSubject(phrase, subject)).toBe(true);
  });
  it("rejects generic phrases and mustExclude hits", () => {
    expect(filterPhrasesBySubject(["stadium crowd", "city street", "Mbappe goal", "Mbappe vs Haaland"], subject)).toEqual(["Mbappe goal"]);
  });
  it("story B stays on B", () => {
    const b = parseVideoSubject("The Lost Lighthouse")!;
    expect(filterPhrasesBySubject(["lost lighthouse storm", "Mbappe goal"], b)).toEqual(["lost lighthouse storm"]);
  });
  it("no subject = no filtering; unusable subject = null", () => {
    expect(filterPhrasesBySubject(["anything"], null)).toEqual(["anything"]);
    expect(parseVideoSubject({ main: " " })).toBeNull();
  });
});

describe("visualPlan multi-tier parse/validate/normalize", () => {
  const model = (keywords: unknown) => draft({ videoSubject: playerA, segments: [seg("g1", ["s01", "s02"], keywords)] });

  it("parses array tiers, keeps scalar ja/en, caps at 2 and keeps mood out of search tiers", () => {
    const { draft: d, visualPlan } = parseScriptDraftV2WithDiagnostics(
      model({ ja: ["エムバペ ゴール", "エムバペ レアル", "エムバペ 三つ目"], en: ["Mbappe goal"], broad_en: ["Mbappe match highlights", "stadium crowd"], mood_en: "city night timelapse" }),
      "ja",
    );
    const k = d!.visualPlan!.segments[0]!.keywords;
    expect(k).toMatchObject({ ja: "エムバペ ゴール", en: "Mbappe goal", jaAll: ["エムバペ ゴール", "エムバペ レアル"], enAll: ["Mbappe goal"], broadEn: ["Mbappe match highlights"], moodEn: "city night timelapse" });
    expect(d!.visualPlan!.videoSubject?.main).toBe("Kylian Mbappé");
    expect(searchTiersForKeywords(k).map((t) => t.tier)).toEqual(["ja", "ja", "en", "broad"]);
    expect(searchTiersForKeywords(k).some((t) => t.phrase === k.moodEn)).toBe(false);
    expect(visualPlan.unusableSegmentIds).toEqual([]);
  });

  it("accepts en when ja is missing (Apify uses en)", () => {
    const { draft: d, visualPlan } = parseScriptDraftV2WithDiagnostics(model({ ja: [], en: ["Mbappe goal"], broad_en: [], mood_en: "" }), "ja");
    expect(d!.visualPlan!.segments[0]!.keywords.ja).toBe("");
    expect(d!.visualPlan!.segments[0]!.keywords.en).toBe("Mbappe goal");
    expect(visualPlan.invalidJaSegmentIds).toEqual(["g1"]);
    expect(visualPlan.unusableSegmentIds).toEqual([]);
  });

  it("generic keywords without the subject are dropped and the segment is flagged for extraction", () => {
    const { draft: d, visualPlan } = parseScriptDraftV2WithDiagnostics(model({ ja: ["東京 夜景"], en: ["city street at night"], broad_en: ["stock market chart"], mood_en: "city night timelapse" }), "ja");
    const k = d!.visualPlan!.segments[0]!.keywords;
    expect(k).toMatchObject({ ja: "", en: "", moodEn: "city night timelapse" });
    expect(k.broadEn).toBeUndefined();
    expect(visualPlan.unusableSegmentIds).toEqual(["g1"]);
  });

  it("without videoSubject nothing is subject-filtered (legacy plans)", () => {
    const { draft: d } = parseScriptDraftV2WithDiagnostics(draft({ segments: [seg("g1", ["s01", "s02"], { ja: "東京 夜景", en: "city street" })] }), "ja");
    expect(d!.visualPlan!.segments[0]!.keywords).toEqual({ ja: "東京 夜景", en: "city street" });
    expect(d!.visualPlan!.videoSubject).toBeUndefined();
  });

  it("still rejects a plan whose keywords are all empty or malformed", () => {
    for (const kw of [{ ja: [], en: [] }, { ja: "", en: "" }, "x", { ja: [1], en: "a" }, { ja: "a".repeat(300), en: "" }]) {
      expect(parseScriptDraftV2WithDiagnostics(model(kw), "ja").visualPlan.reason).toBe("keywords_invalid");
    }
  });

  it("round-trips a stored (already normalized) plan through normalizeScriptVisualPlanV2", () => {
    const stored = parseScriptDraftV2WithDiagnostics(model({ ja: ["エムバペ ゴール"], en: ["Mbappe goal"], broad_en: ["Mbappe highlights"], mood_en: "city night" }), "ja").draft!.visualPlan!;
    const again = normalizeScriptVisualPlanV2(JSON.parse(JSON.stringify(stored)), ["s01", "s02"]);
    expect(again).toEqual(stored);
    expect(sanitizeVisualPlanKeywords(again!).plan).toEqual(stored);
  });

  it("falls back to broad_en for the scene query when en is empty", () => {
    const plan = normalizeScriptVisualPlanV2({ segments: [seg("g1", ["s01", "s02"], { ja: "渋谷", en: "", broad_en: ["shibuya highlights"] })] }, ["s01", "s02"])!;
    expect(mediaSearchQueryForScene({ sceneId: "s01", visualQuery: "q", narration: "n" }, plan)).toBe("shibuya highlights");
  });
});

describe("prompts carry the subject rule", () => {
  it("script prompt asks for videoSubject and multi-tier keywords anchored on the subject", () => {
    const text = buildScriptV2PromptPackage({ sourceType: "topic", sourceText: "x", language: "ja" }).text;
    for (const needle of ["videoSubject", "broad_en", "mood_en", "SUBJECT RULE", "player A"]) expect(text).toContain(needle);
  });
  it("extract_keywords prompt carries title/subject and the rule", () => {
    const prompt = buildSegmentKeywordsPrompt({ language: "ja", title: "Mbappe night", subject: playerA, segments: [{ segmentId: "a", narration: "n" }] });
    for (const needle of ["Mbappe night", "SUBJECT RULE", "Kylian Mbappé", "エムバペ", "Never use: Haaland"]) expect(prompt).toContain(needle);
  });
});

describe("parseSegmentKeywords tiers + subject", () => {
  it("reads array form, keeps en-only, filters off-subject", () => {
    const out = parseSegmentKeywords(
      {
        segments: [
          { segmentId: "a", ja: ["エムバペ ゴール"], en: ["Mbappe goal"], broad_en: ["Mbappe highlights", "stadium crowd"], mood_en: "night city" },
          { segmentId: "b", ja: [], en: ["Mbappe press"] },
          { segmentId: "c", ja: ["東京 夜景"], en: ["city street"] },
        ],
      },
      ["a", "b", "c"],
      playerA,
    );
    expect(out.keywords.a).toEqual({ ja: "エムバペ ゴール", en: "Mbappe goal", jaAll: ["エムバペ ゴール"], enAll: ["Mbappe goal"], broadEn: ["Mbappe highlights"], moodEn: "night city" });
    expect(out.keywords.b).toMatchObject({ ja: "", en: "Mbappe press" });
    expect(out.rejectedSegmentIds).toEqual(["c"]);
  });
});
