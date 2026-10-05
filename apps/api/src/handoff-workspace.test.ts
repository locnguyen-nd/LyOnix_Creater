import { describe, expect, it } from "vitest";
import { captionPlanFromScript, SCRIPT_DRAFT_SCHEMA_VERSION } from "@lyonix/providers";
import { buildHandoffDocuments, handoffFingerprint } from "./handoff-workspace.js";
import { parseScriptDraft } from "./script-draft.js";

const script = parseScriptDraft({
  schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
  language: "vi",
  title: "Messi",
  hook: "hook",
  body: "body spoken",
  cta: "cta",
  caption: "cap",
  scenes: [
    { sceneId: "s01", narration: "Câu một.", screenText: "1", visualBrief: "sân", estimatedDurationMs: 5000 },
    { sceneId: "s02", narration: "Câu hai.", screenText: "2", visualBrief: "đám đông", estimatedDurationMs: 5000 },
  ],
}, 3, 3, "vi");

describe("handoff workspace", () => {
  it("is ready when every scene has spoken text, captions and visual briefs", () => {
    const docs = buildHandoffDocuments({
      productionRequestId: "11111111-1111-1111-1111-111111111111",
      scriptVersionId: "22222222-2222-2222-2222-222222222222",
      scriptVersion: 3,
      locale: "vi",
      topic: "Messi",
      provider: "openai",
      model: "gpt-4o-mini",
      promptTemplateVersion: "script-prompt.v1",
      schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
      providerConfigVersion: 1,
      assetSource: "generated",
      script: script!,
      captionPlan: captionPlanFromScript(script!),
    });
    expect(docs.manifest.status).toBe("ready");
    expect(docs.manifest.files.some((file) => file.relativePath === "script/vrew-paste.txt")).toBe(true);
    expect(docs.manifest.files.some((file) => file.relativePath === "visuals/s01.txt")).toBe(true);
    expect(docs.files.find((file) => file.relativePath === "script/vrew-paste.txt")?.body).not.toContain("s01");
  });

  it("pins the same fingerprint for the same script version", () => {
    const pin = { productionRequestId: "a", scriptVersion: 2, promptTemplateVersion: "script-prompt.v1", schemaVersion: "script-draft.v1", providerConfigVersion: 4 };
    expect(handoffFingerprint(pin)).toBe(handoffFingerprint(pin));
  });
});
