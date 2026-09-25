import { describe, expect, it } from "vitest";
import { discoveredContentModels, mergeContentModels, resolveContentModel, suggestedModelFromError } from "./content-models.js";

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

describe("discoveredContentModels (V00-10 account-scoped discovery, no static union)", () => {
  it("returns only what the account's own live listing reports, never a static-catalog addition", () => {
    const models = discoveredContentModels("openai", ["gpt-4o-mini"]);
    expect(models).toEqual(["gpt-4o-mini"]);
    expect(models).not.toContain("gpt-5");
  });

  it("returns an empty list (not a curated fallback) when the account's live listing is empty", () => {
    expect(discoveredContentModels("openai", [])).toEqual([]);
  });

  it("still resolves retired ids to their replacement and dedupes", () => {
    const models = discoveredContentModels("gemini", ["models/gemini-2.5-pro", "models/gemini-3.1-pro-preview", "models/gemini-2.5-flash"]);
    expect(models).toEqual(["gemini-3.1-pro-preview", "gemini-2.5-flash"]);
  });

  it("filters out non-text models (tts/embedding/image/etc.)", () => {
    expect(discoveredContentModels("openai", ["gpt-4o-mini", "whisper-1", "text-embedding-3-small", "dall-e-3"])).toEqual(["gpt-4o-mini"]);
  });
});
