import { describe, expect, it } from "vitest";
import { mergeContentModels, resolveContentModel, suggestedModelFromError } from "./content-models.js";

describe("content model catalog", () => {
  it("maps retired Gemini Pro ids to the current preview model", () => {
    expect(resolveContentModel("gemini", "models/gemini-2.5-pro")).toBe("gemini-3.1-pro-preview");
    expect(suggestedModelFromError("Please update your code to use models/gemini-3.1-pro-preview for the latest features")).toBe("gemini-3.1-pro-preview");
  });

  it("does not keep gemini-2.5-pro in the merged picker", () => {
    const models = mergeContentModels("gemini", ["models/gemini-2.5-pro", "models/gemini-2.5-flash"]);
    expect(models).not.toContain("gemini-2.5-pro");
    expect(models[0]).toBe("gemini-3.1-pro-preview");
    expect(models).toContain("gemini-2.5-flash");
  });
});
