import { describe, expect, it } from "vitest";
import { parseScriptDraft, scriptPrompt } from "./script-draft.js";

describe("script draft", () => {
  it("reads nested script JSON and fills spoken body from scenes", () => {
    const draft = parseScriptDraft({
      script: {
        title: "Messi",
        hook: "3 giây",
        cta: "Follow",
        scenes: [{ sceneId: "s1", narration: "Câu 1.", screenText: "1", visualBrief: "pitch" }],
      },
    }, 2, null);
    expect(draft).toMatchObject({ title: "Messi", body: "Câu 1.", version: 2 });
  });

  it("asks for a revision when a script already exists", () => {
    expect(scriptPrompt({
      topic: "Messi",
      language: "vi",
      direction: "Giảm CTA",
      existing: parseScriptDraft({
        title: "Messi",
        hook: "h",
        body: "b",
        cta: "c",
        caption: "cap",
        scenes: [
          { sceneId: "s01", narration: "Câu 1", screenText: "1", visualBrief: "v" },
          { sceneId: "s02", narration: "Câu 2", screenText: "2", visualBrief: "v" },
        ],
      }, 1),
    })).toContain("Giảm CTA");
  });
});
