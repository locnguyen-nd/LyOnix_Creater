import { describe, expect, it } from "vitest";
import {
  CREATION_LIMITS,
  SYSTEM_CREATION_DEFAULTS,
  clearUnavailableReferences,
  isCreationFlowType,
  pickCreationPreferences,
  resolveInitialForm,
  sanitizeCreationPreferences,
  sanitizeJobNewDraft,
  type JobNewFieldKey,
} from "./creation-form.js";

describe("creation-form whitelist (VE2E-124)", () => {
  it("keeps every known form value of a draft and drops unknown keys and invalid values", () => {
    const draft = sanitizeJobNewDraft({
      topic: "Messi tới Inter Miami",
      language: "ja",
      durationTarget: "65-90s",
      backgroundSegmentsChoice: "3",
      voiceId: "voice-x",
      apiKey: "sk-secret",
      encryptedSecret: "xxx",
      sceneCountTarget: "99-100",
      orshotFormat: "exe",
      channelId: "bad\u0007id",
      contentAccountId: 42,
    });
    expect(draft).toEqual({ topic: "Messi tới Inter Miami", language: "ja", durationTarget: "65-90s", backgroundSegmentsChoice: "3", voiceId: "voice-x" });
  });

  it("never keeps job content in defaults, even when it is sent", () => {
    const options = sanitizeCreationPreferences({ topic: "x", promptSpec: "y", existingScript: "z", autoRawScript: "w", autoArticleUrl: "https://a.b", language: "ja", templateId: "tpl-1" });
    expect(options).toEqual({ language: "ja", templateId: "tpl-1" });
    expect(pickCreationPreferences({ ...SYSTEM_CREATION_DEFAULTS, topic: "secret topic", voiceId: "v1" })).not.toHaveProperty("topic");
  });

  it("rejects oversize content and ids, and non-object input", () => {
    expect(sanitizeJobNewDraft({ topic: "a".repeat(CREATION_LIMITS.maxContentChars + 1) })).toEqual({});
    expect(sanitizeJobNewDraft({ voiceId: "v".repeat(CREATION_LIMITS.maxIdChars + 1) })).toEqual({});
    expect(sanitizeJobNewDraft(null)).toEqual({});
    expect(sanitizeJobNewDraft(["topic"])).toEqual({});
    expect(isCreationFlowType("job_new")).toBe(true);
    expect(isCreationFlowType("other")).toBe(false);
  });
});

describe("resolveInitialForm (VE2E-124)", () => {
  it("system defaults when the user has neither defaults nor a draft", () => {
    const { values, sources } = resolveInitialForm({});
    expect(values).toEqual(SYSTEM_CREATION_DEFAULTS);
    expect(sources.language).toBe("system");
  });

  it("user defaults over system defaults, and the draft over user defaults", () => {
    const { values, sources } = resolveInitialForm({
      preferences: { language: "ja", durationTarget: "65-90s", voiceId: "voice-x", templateId: "tpl-y" },
      draft: { language: "ko", topic: "Đang viết dở" },
    });
    expect(values).toMatchObject({ language: "ko", durationTarget: "65-90s", voiceId: "voice-x", templateId: "tpl-y", topic: "Đang viết dở" });
    expect(sources).toMatchObject({ language: "draft", durationTarget: "preferences", topic: "draft", sceneCountTarget: "system" });
  });

  it("job content of a previous job never comes from defaults", () => {
    const { values } = resolveInitialForm({ preferences: { language: "ja", topic: "old topic" } as never });
    expect(values.topic).toBe("");
  });

  it("explicit URL intent (?entry=, ?channelId=) wins over the draft for those fields only", () => {
    const { values, sources } = resolveInitialForm({
      draft: { entryMode: "manual", channelId: "ch-draft", topic: "keep me" },
      url: { entryMode: "auto", channelId: "ch-url" },
    });
    expect(values).toMatchObject({ entryMode: "auto", channelId: "ch-url", topic: "keep me" });
    expect(sources).toMatchObject({ entryMode: "url", channelId: "url", topic: "draft" });
    expect(resolveInitialForm({ url: { entryMode: "nonsense" } }).values.entryMode).toBe("manual");
  });
});

describe("clearUnavailableReferences (VE2E-124)", () => {
  const restored = new Set<JobNewFieldKey>(["voiceId", "templateId", "channelId", "contentAccountId"]);

  it("clears a restored voice/template that no longer exists, never replaces it, and reports it", () => {
    const values = { ...SYSTEM_CREATION_DEFAULTS, voiceId: "gone", templateId: "tpl-ok", channelId: "ch-1", contentAccountId: "acc-1" };
    const result = clearUnavailableReferences(values, { voiceId: ["v1", "v2"], templateId: ["tpl-ok"], channelId: ["ch-1"], contentAccountId: ["acc-2"] }, restored);
    expect(result.values).toMatchObject({ voiceId: "", templateId: "tpl-ok", channelId: "ch-1", contentAccountId: "" });
    expect(result.cleared.sort()).toEqual(["contentAccountId", "voiceId"]);
  });

  it("does not judge a field whose list is not loaded yet, nor a value that was not restored", () => {
    const values = { ...SYSTEM_CREATION_DEFAULTS, voiceId: "maybe", renderAccountId: "r-typed" };
    const result = clearUnavailableReferences(values, { voiceId: null, renderAccountId: [] }, new Set<JobNewFieldKey>(["voiceId"]));
    expect(result.values).toMatchObject({ voiceId: "maybe", renderAccountId: "r-typed" });
    expect(result.cleared).toEqual([]);
  });
});
