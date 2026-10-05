import { describe, expect, it } from "vitest";
import { buildScriptV2PromptPackage, parseScriptDraftV2, validateScriptDraftV2, SCRIPT_DRAFT_V2_SCHEMA_VERSION } from "./script-draft-v2.js";

const validDraft = {
  schemaVersion: SCRIPT_DRAFT_V2_SCHEMA_VERSION,
  language: "vi",
  title: "Messi",
  hook: "Messi la ai",
  body: "Messi la cau thu bong da",
  cta: "Theo doi de biet them",
  caption: "#messi #bongda",
  scenes: [
    { sceneId: "s01", narration: "Messi la cau thu bong da", screenText: "Messi", visualQuery: "soccer player celebrating goal", durationHintMs: 50_000 },
  ],
};

describe("parseScriptDraftV2", () => {
  it("parses a fenced JSON reply and fills default sceneId/visualQuery", () => {
    const raw = "```json\n" + JSON.stringify({ ...validDraft, scenes: [{ narration: "n", screenText: "s", visualBrief: "old key", durationHintMs: 40_000 }] }) + "\n```";
    const parsed = parseScriptDraftV2(raw, "vi");
    expect(parsed?.scenes[0]?.sceneId).toBe("s01");
    expect(parsed?.scenes[0]?.visualQuery).toBe("old key");
  });

  it("returns null for unparseable content", () => {
    expect(parseScriptDraftV2("not json at all", "vi")).toBeNull();
  });

  it("VE2E-32: splits a scene whose narration packs 2+ sentences into one scene per sentence, redistributing duration and keeping visualQuery", () => {
    const parsed = parseScriptDraftV2({
      ...validDraft,
      scenes: [
        { sceneId: "s01", narration: "Messi is a football player. He plays for Inter Miami now.", screenText: "Messi is a football player. He plays for Inter Miami now.", visualQuery: "soccer player", durationHintMs: 9000 },
      ],
    }, "vi");
    expect(parsed?.scenes).toHaveLength(2);
    expect(parsed?.scenes[0]).toMatchObject({ sceneId: "s01-1", narration: "Messi is a football player.", visualQuery: "soccer player" });
    expect(parsed?.scenes[1]).toMatchObject({ sceneId: "s01-2", narration: "He plays for Inter Miami now.", visualQuery: "soccer player" });
    const total = parsed!.scenes.reduce((sum, s) => sum + s.durationHintMs, 0);
    expect(total).toBe(9000);
  });

  it("VE2E-32: leaves a single-sentence scene untouched", () => {
    const parsed = parseScriptDraftV2(validDraft, "vi");
    expect(parsed?.scenes).toHaveLength(1);
    expect(parsed?.scenes[0]?.sceneId).toBe("s01");
  });

  it("dedupes repeated sceneId values", () => {
    const parsed = parseScriptDraftV2({
      ...validDraft,
      scenes: [
        { sceneId: "s01", narration: "a", screenText: "a", visualQuery: "q1", durationHintMs: 40_000 },
        { sceneId: "s01", narration: "b", screenText: "b", visualQuery: "q2", durationHintMs: 40_000 },
      ],
    }, "vi");
    const ids = parsed?.scenes.map((s) => s.sceneId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("validateScriptDraftV2", () => {
  it("accepts a well-formed draft", () => {
    expect(validateScriptDraftV2(validDraft as never)).toEqual({ ok: true });
  });

  it("rejects duration outside 30-90s", () => {
    const draft = { ...validDraft, scenes: [{ ...validDraft.scenes[0]!, durationHintMs: 1000 }] };
    expect(validateScriptDraftV2(draft as never)).toEqual({ ok: false, reason: "duration" });
  });

  it("rejects a scene with an empty visualQuery", () => {
    const draft = { ...validDraft, scenes: [{ ...validDraft.scenes[0]!, visualQuery: "" }] };
    expect(validateScriptDraftV2(draft as never)).toEqual({ ok: false, reason: "visual_query" });
  });

  it("rejects duplicate sceneId at the semantic layer too", () => {
    const scene = validDraft.scenes[0]!;
    const draft = { ...validDraft, scenes: [scene, { ...scene, durationHintMs: 40_000 }] };
    expect(validateScriptDraftV2(draft as never)).toEqual({ ok: false, reason: "schema" });
  });
});

describe("buildScriptV2PromptPackage", () => {
  it("includes source provenance for article_url without leaking it as body text", () => {
    const pkg = buildScriptV2PromptPackage({
      sourceType: "article_url",
      sourceText: "Extracted article body text about a topic.",
      originRef: "https://example.com/article",
      language: "vi",
    });
    expect(pkg.text).toContain("article_url");
    expect(pkg.text).toContain("https://example.com/article");
    expect(pkg.text).toContain("Extracted article body text");
  });

  it("falls back to vi for an unsupported language", () => {
    const pkg = buildScriptV2PromptPackage({ sourceType: "topic", sourceText: "chu de", language: "fr" });
    expect(pkg.language).toBe("vi");
  });

  it("clips a very long raw_script source", () => {
    const pkg = buildScriptV2PromptPackage({ sourceType: "raw_script", sourceText: "x".repeat(20_000), language: "vi" });
    expect(pkg.text.length).toBeLessThan(20_000);
    expect(pkg.text).toContain("truncated");
  });
});
