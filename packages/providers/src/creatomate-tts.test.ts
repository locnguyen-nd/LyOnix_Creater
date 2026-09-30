import { describe, expect, it } from "vitest";
import { TTS_PROVIDER_DISABLED_VALUE, deriveTemplateModifications, findTemplateTtsElements, ttsProviderOverrideKey } from "./creatomate.js";

const PROVIDER = "elevenlabs model_id=eleven_multilingual_v2 voice_id=XrExE9yKIg1WjnnlVkGX";

describe("VE2E-47 template TTS provider detection", () => {
  const source = {
    elements: [
      { name: "Voiceover-1", type: "audio", source: "", provider: PROVIDER, dynamic: true },
      { name: "Music", type: "audio", source: "https://cdn/m.mp3", dynamic: true },
      { name: "Jingle", type: "audio", source: "hi", provider: PROVIDER },
      { name: "Blank", type: "audio", provider: "  ", dynamic: true },
    ],
  };

  it("marks the dynamic audio .source slot with ttsProvider; plain/blank-provider audio stays unmarked", () => {
    const slots = deriveTemplateModifications(source);
    expect(slots.find((s) => s.key === "Voiceover-1.source")).toMatchObject({ kind: "audio", ttsProvider: PROVIDER });
    expect(slots.find((s) => s.key === "Music.source")).not.toHaveProperty("ttsProvider");
    expect(slots.find((s) => s.key === "Blank.source")).not.toHaveProperty("ttsProvider");
    expect(slots.some((s) => s.key.startsWith("Jingle"))).toBe(false);
  });

  it("findTemplateTtsElements reports dynamic and fixed provider elements", () => {
    expect(findTemplateTtsElements(source)).toEqual([
      { elementName: "Voiceover-1", provider: PROVIDER, dynamic: true },
      { elementName: "Jingle", provider: PROVIDER, dynamic: false },
    ]);
  });

  it("documents the override: <name>.provider blanked to an empty string", () => {
    expect(ttsProviderOverrideKey("Voiceover-3.source")).toBe("Voiceover-3.provider");
    expect(TTS_PROVIDER_DISABLED_VALUE).toBe("");
  });
});
