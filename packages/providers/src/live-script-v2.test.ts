import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { generateScriptDraftV2 } from "./live-script-v2.js";
import { SCRIPT_DRAFT_V2_SCHEMA_VERSION } from "./script-draft-v2.js";

afterEach(() => { vi.unstubAllGlobals(); });

const draftJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  schemaVersion: SCRIPT_DRAFT_V2_SCHEMA_VERSION,
  language: "vi",
  title: "Messi",
  hook: "Messi la ai",
  body: "Messi la cau thu bong da noi tieng",
  cta: "Theo doi ngay",
  caption: "#messi",
  scenes: [
    { sceneId: "s01", narration: "Messi la cau thu bong da noi tieng", screenText: "Messi", visualQuery: "soccer player on the pitch", durationHintMs: 13_000 },
    { sceneId: "s02", narration: "Anh thi dau cho Inter Miami", screenText: "Inter Miami", visualQuery: "soccer stadium crowd cheering", durationHintMs: 13_000 },
    { sceneId: "s03", narration: "Theo doi de biet them chi tiet", screenText: "Theo doi ngay", visualQuery: "call to action follow button", durationHintMs: 13_000 },
  ],
  ...overrides,
});

describe("generateScriptDraftV2", () => {
  it("generates via the OpenAI Responses API and pins model/usage on success", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init.body)) as { model: string; text?: { format?: { type: string } } };
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.text?.format?.type).toBe("json_schema");
      return new Response(JSON.stringify({ output_text: draftJson() }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", {
      sourceType: "topic",
      sourceText: "Messi",
      language: "vi",
    });
    expect(result.modelId).toBe("gpt-4o-mini");
    expect(result.draft.scenes[0]?.visualQuery).toBe("soccer player on the pitch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("VE2E-38: returns the visualPlan from the same single provider call (schema + prompt carry it)", async () => {
    const visualPlan = {
      segments: [
        { segmentId: "g1", sceneIds: ["s01", "s02"], subject: "Messi", priority: 1, keywords: { ja: "メッシ サッカー", en: "soccer player dribbling" }, styleHints: { setting: "stadium", timeOfDay: "night", lighting: "floodlights", palette: "green + white" } },
        { segmentId: "g2", sceneIds: ["s03"], subject: "follow CTA", priority: 2, keywords: { ja: "", en: "phone social media scrolling" }, styleHints: { setting: "home", timeOfDay: "night", lighting: "screen glow", palette: "blue" } },
      ],
    };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: unknown; text: { format: { schema: { required: string[] } } } };
      expect(body.text.format.schema.required).toContain("visualPlan");
      expect(JSON.stringify(body.input)).toContain("into 2-3 background segments");
      return new Response(JSON.stringify({ output_text: draftJson({ visualPlan }) }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "Messi", language: "vi", backgroundSegmentRange: { min: 2, max: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.draft.visualPlan?.segments.map((s) => s.sceneIds)).toEqual([["s01", "s02"], ["s03"]]);
    expect(result.promptTemplateVersion).toBe("script-prompt.v2.4");
    expect(result.diagnostics).toMatchObject({ visualPlan: { status: "ok", reason: null, invalidJaSegmentIds: ["g2"] }, schemaRejection: null, repaired: false });
  });

  it("VE2E-50: records that the strict schema was rejected and the call repeated without it, and why the plan is missing", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      call += 1;
      const body = JSON.parse(String(init.body)) as { text?: unknown };
      if (call === 1) return new Response(JSON.stringify({ error: { message: "Invalid schema for response_format" } }), { status: 400 });
      expect(body.text).toBeUndefined();
      return new Response(JSON.stringify({ output_text: draftJson() }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "Messi", language: "vi" });
    expect(result.diagnostics.schemaRejection).toContain("Provider rejected the generate payload");
    expect(result.diagnostics.visualPlan).toMatchObject({ status: "missing", reason: "absent" });
    expect(result.draft.visualPlan).toBeNull();
  });

  it("retries once with a repair prompt when the first reply fails semantic validation", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ output_text: draftJson({ scenes: [{ sceneId: "s01", narration: "n", screenText: "s", visualQuery: "", durationHintMs: 50_000 }] }) }), { status: 200 });
      return new Response(JSON.stringify({ output_text: draftJson() }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", {
      sourceType: "raw_script",
      sourceText: "some raw transcript",
      language: "vi",
    });
    expect(result.draft.scenes[0]?.visualQuery).toBe("soccer player on the pitch");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws PROVIDER_SCHEMA_INVALID when both the original and repair reply are invalid", async () => {
    const invalid = JSON.stringify({ output_text: draftJson({ scenes: [{ sceneId: "s01", narration: "n", screenText: "s", visualQuery: "", durationHintMs: 50_000 }] }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(invalid, { status: 200 })));
    await expect(generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", {
      sourceType: "article_url",
      sourceText: "article text",
      originRef: "https://example.com/a",
      language: "vi",
    })).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" } satisfies Partial<ProviderError>);
  });

  it("normalizes a 401 to PROVIDER_AUTH_INVALID without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateScriptDraftV2("xai", "bad-key", "grok-4", {
      sourceType: "topic",
      sourceText: "topic",
      language: "vi",
    })).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" } satisfies Partial<ProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes a network/abort failure to PROVIDER_TIMEOUT", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }));
    await expect(generateScriptDraftV2("gemini", "key", "gemini-2.5-flash", {
      sourceType: "topic",
      sourceText: "topic",
      language: "vi",
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" } satisfies Partial<ProviderError>);
  });
});
