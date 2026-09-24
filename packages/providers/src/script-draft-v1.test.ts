import { describe, expect, it } from "vitest";
import { generateFakeScriptDraft } from "./fake-content.js";
import {
  SCRIPT_DRAFT_SCHEMA_VERSION,
  SCRIPT_PROMPT_TEMPLATE_VERSION,
  buildScriptPromptPackage,
  parseScriptDraftV1,
  validateScriptDraftV1,
} from "./script-draft-v1.js";

describe("ScriptDraftV1", () => {
  it("parses nested JSON, keeps unicode, and fills spoken body", () => {
    const draft = parseScriptDraftV1({
      script: {
        schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
        language: "vi",
        title: "Messi",
        hook: "3 giây",
        cta: "Follow",
        caption: "Messi 60s",
        scenes: [{ sceneId: "s01", narration: "Câu 1.", screenText: "1", visualBrief: "sân", estimatedDurationMs: 5000 }],
      },
    }, "vi");
    expect(draft).toMatchObject({ title: "Messi", body: "Câu 1.", language: "vi" });
  });

  it("rejects drafts outside the 30-90s window", () => {
    const draft = parseScriptDraftV1({
      title: "t", hook: "h", body: "b", cta: "c", caption: "cap",
      scenes: [{ sceneId: "s01", narration: "n", screenText: "s", visualBrief: "v", estimatedDurationMs: 1000 }],
    }, "vi");
    expect(draft && validateScriptDraftV1(draft)).toEqual({ ok: false, reason: "duration" });
  });

  it("pins prompt and schema versions in the immutable prompt package", () => {
    const pkg = buildScriptPromptPackage({
      topic: "Messi",
      language: "vi",
      direction: "Giảm CTA",
      promptSpec: "55-65s, không nhạc nền",
      existing: parseScriptDraftV1({ title: "Messi", hook: "h", body: "b", cta: "c", caption: "cap", scenes: [] }, "vi"),
    });
    expect(pkg.promptTemplateVersion).toBe(SCRIPT_PROMPT_TEMPLATE_VERSION);
    expect(pkg.text).toContain("Giảm CTA");
    expect(pkg.text).toContain("55-65s");
    expect(pkg.repairText).toContain(SCRIPT_DRAFT_SCHEMA_VERSION);
  });

  it("clips long source text in the prompt package", () => {
    const pkg = buildScriptPromptPackage({
      topic: "x".repeat(400),
      language: "vi",
      promptSpec: "y".repeat(9000),
    });
    expect(pkg.topic.length).toBeLessThan(500);
    expect(pkg.text).toContain("truncated");
  });

  it("fake drafts change when direction or version changes", () => {
    const a = generateFakeScriptDraft({ topic: "Messi", language: "vi", direction: "hài", version: 1 });
    const b = generateFakeScriptDraft({ topic: "Messi", language: "vi", direction: "nghiêm túc", version: 1 });
    const c = generateFakeScriptDraft({ topic: "Messi", language: "vi", direction: "hài", version: 2 });
    expect(validateScriptDraftV1(a)).toEqual({ ok: true });
    expect(a.body).not.toBe(b.body);
    expect(a.title).not.toBe(c.title);
  });
});
