import { describe, expect, it } from "vitest";
import { SYSTEM_CREATION_DEFAULTS, pickCreationPreferences } from "@lyonix/domain/creation-form";
import { locales } from "../i18n/locales";
import { FIELD_LABEL_KEYS, buildInitialFormState, type CreationLists } from "./form-state";

const lists: CreationLists = { channelIds: ["ch-1", "ch-2"], contentIds: ["c-1", "c-2"], voiceIds: ["va-1", "va-2"], mediaIds: ["px-1"], renderIds: ["r-1", "r-2"] };

describe("new-job form start state (VE2E-124)", () => {
  it("no draft, no defaults: system defaults + the first available channel/content account (unchanged behaviour)", () => {
    const { values, cleared } = buildInitialFormState({ lists });
    expect(values).toMatchObject({ ...SYSTEM_CREATION_DEFAULTS, channelId: "ch-1", contentAccountId: "c-1" });
    expect(cleared).toEqual([]);
  });

  it("user defaults (JA + 65-90s + voice X + template Y) are pre-selected on a new job", () => {
    const preferences = { entryMode: "auto" as const, language: "ja" as const, durationTarget: "65-90s" as const, voiceAccountId: "va-2", voiceId: "voice-x", renderAccountId: "r-2", templateId: "tpl-y", contentAccountId: "c-2" };
    const { values } = buildInitialFormState({ preferences, lists });
    expect(values).toMatchObject(preferences);
    expect(values.mediaAccountId).toBe("px-1"); // not in the defaults -> system pick
  });

  it("the topic/script of the previous job never comes back from defaults", () => {
    const fromLastJob = pickCreationPreferences({ ...SYSTEM_CREATION_DEFAULTS, topic: "Chủ đề job trước", autoRawScript: "kịch bản cũ", language: "ja" });
    const { values } = buildInitialFormState({ preferences: fromLastJob, lists });
    expect(values).toMatchObject({ topic: "", autoRawScript: "", language: "ja" });
  });

  it("a draft wins over the user's defaults", () => {
    const { values, restored } = buildInitialFormState({ preferences: { language: "ja", durationTarget: "65-90s" }, draft: { language: "ko", topic: "đang viết" }, lists });
    expect(values).toMatchObject({ language: "ko", durationTarget: "65-90s", topic: "đang viết" });
    expect(restored.has("topic")).toBe(true);
  });

  it("a deleted voice account / inaccessible channel is cleared (with its voice), reported, and NOT replaced by another one", () => {
    const { values, cleared } = buildInitialFormState({
      preferences: { entryMode: "auto", channelId: "ch-gone", voiceAccountId: "va-deleted", voiceId: "voice-x", renderAccountId: "r-1", templateId: "tpl-ok" },
      lists,
    });
    expect(values).toMatchObject({ channelId: "", voiceAccountId: "", voiceId: "", renderAccountId: "r-1", templateId: "tpl-ok" });
    expect(cleared.sort()).toEqual(["channelId", "voiceAccountId", "voiceId"]);
  });

  it("the URL intent (?entry=auto, ?channelId=) wins over the draft for those fields", () => {
    const { values } = buildInitialFormState({ draft: { entryMode: "manual", channelId: "ch-1", topic: "x" }, url: { entryMode: "auto", channelId: "ch-2" }, lists });
    expect(values).toMatchObject({ entryMode: "auto", channelId: "ch-2", topic: "x" });
  });

  it("every field that can be cleared has a label in every locale", () => {
    for (const key of Object.values(FIELD_LABEL_KEYS)) {
      const [group, name] = key!.split(".") as [keyof typeof locales.vi, string];
      for (const locale of ["vi", "en", "ja", "ko"] as const) expect((locales[locale][group] as Record<string, string>)[name], `${locale}.${key}`).toBeTruthy();
    }
  });
});
