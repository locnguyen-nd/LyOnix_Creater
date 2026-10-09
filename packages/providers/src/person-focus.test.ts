import { afterEach, describe, expect, it, vi } from "vitest";
import { generateScriptDraftV2 } from "./live-script-v2.js";
import { buildScriptV2PromptPackage, SCRIPT_DRAFT_V2_SCHEMA_VERSION } from "./script-draft-v2.js";
import { SCRIPT_VISUAL_PLAN_V2_JSON_SCHEMA } from "./script-visual-plan.js";
import { parseVideoSubject } from "./subject-keywords.js";
import { moderateMediaWithVision, moderateSceneCandidatesBatch } from "./vision-moderation.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SCRIPT_PERSON_REFOCUS;
});

describe("VE2E-151 videoSubject kind / otherPeople", () => {
  it("parses kind (known values only) and otherPeople; older subjects stay valid without them", () => {
    expect(parseVideoSubject({ main: "Lee Felix", kind: "person", aliases: ["フィリックス"], mustInclude: ["Stray Kids"], mustExclude: [], otherPeople: ["Hyunjin"] })).toEqual({
      main: "Lee Felix",
      kind: "person",
      aliases: ["フィリックス"],
      mustInclude: ["Stray Kids"],
      mustExclude: [],
      otherPeople: ["Hyunjin"],
    });
    expect(parseVideoSubject({ main: "Lee Felix", kind: "celebrity" })?.kind).toBeUndefined();
    expect(parseVideoSubject({ main: "Stray Kids", aliases: [] })).toEqual({ main: "Stray Kids", aliases: [], mustInclude: [], mustExclude: [] });
  });

  it("the structured-output schema requires kind + otherPeople and the prompt carries the PERSON RULE", () => {
    const plan = (SCRIPT_VISUAL_PLAN_V2_JSON_SCHEMA as { anyOf: Array<{ properties?: { videoSubject?: { required: string[]; properties: Record<string, { enum?: string[] }> } } }> }).anyOf[1]!;
    expect(plan.properties!.videoSubject!.required).toEqual(expect.arrayContaining(["kind", "otherPeople"]));
    expect(plan.properties!.videoSubject!.properties.kind!.enum).toContain("person");
    const pkg = buildScriptV2PromptPackage({ sourceType: "topic", sourceText: "Stray Kids Felix", language: "ja" });
    expect(pkg.text).toContain("PERSON RULE");
    expect(pkg.text).toContain("re-center the script on the chosen person");
    expect(pkg.text).toContain("same-name people");
  });
});

const visualPlan = (otherPeople: string[]) => ({
  videoSubject: { main: "Lee Felix", kind: "person", aliases: ["フィリックス"], mustInclude: ["Stray Kids"], mustExclude: [], otherPeople },
  segments: [{ segmentId: "g1", sceneIds: ["s01", "s02", "s03"], subject: "Felix", priority: 1, keywords: { ja: ["フィリックス ダンス"], en: ["Lee Felix dance"], broad_en: ["Lee Felix stage"], mood_en: "stage lights" }, styleHints: { setting: "stage", timeOfDay: "night", lighting: "spot", palette: "blue" } }],
});
const draft = (narrations: string[], otherPeople: string[]) =>
  JSON.stringify({
    schemaVersion: SCRIPT_DRAFT_V2_SCHEMA_VERSION,
    language: "en",
    title: "Stray Kids today",
    hook: narrations[0],
    body: narrations.join(" "),
    cta: "Follow",
    caption: "#skz",
    scenes: narrations.map((narration, index) => ({ sceneId: `s0${index + 1}`, narration, screenText: "SKZ", visualQuery: "stage", durationHintMs: 13_000 })),
    visualPlan: visualPlan(otherPeople),
  });
const drifted = draft(["Hyunjin opened the show", "Hyunjin danced the solo", "Felix waved at the end"], ["Hyunjin"]);
const focused = draft(["Lee Felix opened the show", "He danced the solo", "Felix waved at the end"], ["Hyunjin"]);
const reply = (text: string) => new Response(JSON.stringify({ output_text: text }), { status: 200 });

describe("VE2E-151 script refocus on the person", () => {
  it("a person draft that drifts gets ONE rewrite centered on the person; the focused rewrite is kept", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(drifted)).mockResolvedValueOnce(reply(focused));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "Stray Kids Felix", language: "en" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rewritePrompt = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[1]![1].body)));
    expect(rewritePrompt).toContain("drifted away from the main person");
    expect(rewritePrompt).toContain("centered on Lee Felix");
    expect(result.draft.scenes[0]!.narration).toBe("Lee Felix opened the show");
    expect(result.diagnostics.personFocus).toMatchObject({ ok: true, name: "Lee Felix", refocused: true });
  });

  it("a rewrite that is no better is dropped; the drift stays visible in the diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(drifted)).mockResolvedValueOnce(reply(draft(["Bang Chan talked", "Hyunjin danced", "Hyunjin sang"], ["Hyunjin", "Bang Chan"]))));
    const result = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "Stray Kids Felix", language: "en" });
    expect(result.draft.scenes[0]!.narration).toBe("Hyunjin opened the show");
    expect(result.diagnostics.personFocus).toMatchObject({ ok: false, refocused: false });
    expect(result.diagnostics.personFocus?.reasons).toContain("target_missing_in_hook");
  });

  it("a focused person draft, a non-person subject and SCRIPT_PERSON_REFOCUS=0 make no extra call", async () => {
    const one = vi.fn(async () => reply(focused));
    vi.stubGlobal("fetch", one);
    const ok = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "Felix", language: "en" });
    expect(one).toHaveBeenCalledTimes(1);
    expect(ok.diagnostics.personFocus).toMatchObject({ ok: true, refocused: false });

    const team = JSON.parse(drifted) as { visualPlan: { videoSubject: { kind: string } } };
    team.visualPlan.videoSubject.kind = "group";
    const two = vi.fn(async () => reply(JSON.stringify(team)));
    vi.stubGlobal("fetch", two);
    const group = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "Stray Kids", language: "en" });
    expect(two).toHaveBeenCalledTimes(1);
    expect(group.diagnostics.personFocus).toBeUndefined();

    process.env.SCRIPT_PERSON_REFOCUS = "0";
    const three = vi.fn(async () => reply(drifted));
    vi.stubGlobal("fetch", three);
    const off = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "Felix", language: "en" });
    expect(three).toHaveBeenCalledTimes(1);
    expect(off.diagnostics.personFocus).toMatchObject({ ok: false, refocused: false });
  });
});

const gemini = (result: Record<string, unknown>) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] }), { status: 200 });
const ctx = { beat: "hook", entities: ["lee felix"], action: [], setting: [], mood: [], exclusions: [] };
const base = { safety_flag: false, safety_categories: [], scene_beat_relevance: 0.8, confidence: 0.9, notes: "ok" };
const shotFields = { people_count: 1, main_person_closeup: true, text_coverage: "little", logo_watermark: false, news_card: false };

describe("VE2E-151 vision shot description (same call)", () => {
  it("personShot asks for the shot fields in the schema + prompt and returns them; it never asks who is shown", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => gemini({ ...base, ...shotFields }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await moderateMediaWithVision({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash", operation: "image_moderation", sceneContext: { ...ctx, personShot: true }, frames: [{ mimeType: "image/jpeg", base64: "AAAA" }] });
    const body = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)));
    for (const field of ["people_count", "main_person_closeup", "text_coverage", "logo_watermark", "news_card"]) expect(body).toContain(field);
    expect(body).toContain("WITHOUT trying to identify who anyone is");
    expect(result.raw.shot).toEqual({ peopleCount: 1, closeUp: true, textCoverage: "little", logo: false, newsCard: false });
  });

  it("without personShot the request is unchanged (no shot fields); a partial shot answer is ignored", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => gemini({ ...base, people_count: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await moderateMediaWithVision({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash", operation: "image_moderation", sceneContext: ctx, frames: [{ mimeType: "image/jpeg", base64: "AAAA" }] });
    expect(String(fetchMock.mock.calls[0]![1]!.body)).not.toContain("news_card");
    expect(result.raw.shot).toBeUndefined();
  });

  it("the cover batch carries the shot per image", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => gemini({ items: [{ index: 1, ...base, ...shotFields }, { index: 2, ...base, ...shotFields, people_count: 7, main_person_closeup: false }] }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await moderateSceneCandidatesBatch({
      kind: "gemini",
      apiKey: "k",
      modelId: "gemini-2.5-flash",
      sceneContext: { ...ctx, personShot: true },
      capabilityEvidence: { verifiedAt: new Date().toISOString() },
      items: [{ id: "a", frame: { mimeType: "image/jpeg", base64: "AAAA" } }, { id: "b", frame: { mimeType: "image/jpeg", base64: "BBBB" } }],
    });
    expect(String(fetchMock.mock.calls[0]![1]!.body)).toContain("news_card");
    expect(outcome.verdicts.get("a")?.shot?.peopleCount).toBe(1);
    expect(outcome.verdicts.get("b")?.shot).toMatchObject({ peopleCount: 7, closeUp: false });
  });
});

describe("VE2E-151 explicit target person (create form) + identity verification", () => {
  const userTarget = { main: "Lee Felix", aliases: ["フィリックス"], context: ["Stray Kids"] };
  const hyunjinDraft = () => {
    const parsed = JSON.parse(draft(["Hyunjin opened the show", "Hyunjin danced the solo", "Hyunjin waved at the end"], [])) as { visualPlan: { videoSubject: Record<string, unknown> } };
    parsed.visualPlan.videoSubject = { main: "Hyunjin", kind: "person", aliases: ["ヒョンジン"], mustInclude: [], mustExclude: [], otherPeople: [] };
    return JSON.stringify(parsed);
  };

  it("the typed person locks the prompt and overrides the model's subject; a draft about someone else is rewritten", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(hyunjinDraft())).mockResolvedValueOnce(reply(focused));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "Stray Kids news", language: "en", targetPerson: userTarget });
    const firstPrompt = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]![1].body)));
    expect(firstPrompt).toContain("TARGET PERSON (chosen by the user - highest priority");
    expect(firstPrompt).toContain("videoSubject.main MUST be Lee Felix");
    expect(fetchMock).toHaveBeenCalledTimes(2); // the Hyunjin draft drifted off the user's person -> one rewrite
    expect(JSON.stringify(JSON.parse(String(fetchMock.mock.calls[1]![1].body)))).toContain("centered on Lee Felix");
    expect(result.draft.visualPlan?.videoSubject).toMatchObject({ main: "Lee Felix", kind: "person", source: "user" });
    expect(result.diagnostics.personFocus).toMatchObject({ ok: true, name: "Lee Felix", source: "user", refocused: true });
  });

  it("user target overrides model: even a rewrite that keeps the other person never replaces the user's person", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(hyunjinDraft())).mockResolvedValueOnce(reply(hyunjinDraft())));
    const result = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "Stray Kids news", language: "en", targetPerson: userTarget });
    expect(result.draft.visualPlan?.videoSubject).toMatchObject({ main: "Lee Felix", source: "user" });
    expect(result.draft.visualPlan?.videoSubject?.otherPeople).toContain("Hyunjin");
    expect(result.diagnostics.personFocus).toMatchObject({ ok: false, name: "Lee Felix", source: "user" });
  });

  it("no typed person: the model's person named in the selected news is the `news` target", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(focused)));
    const result = await generateScriptDraftV2("openai", "sk-test", "gpt-4o-mini", { sourceType: "topic", sourceText: "news", language: "en", newsText: "Stray Kids Lee Felix returns to the stage" });
    expect(result.draft.visualPlan?.videoSubject?.source).toBe("news");
    expect(result.diagnostics.personFocus?.source).toBe("news");
  });

  it("vision identity check: asked in the same call with the target's names; verdict parsed; a refusal / partial answer leaves it out", async () => {
    const target = { name: "Lee Felix", aliases: ["フィリックス"], context: ["Stray Kids"], others: ["Hyunjin"] };
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => gemini({ ...base, ...shotFields, target_match: "different_person", target_confidence: 0.8 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await moderateMediaWithVision({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash", operation: "image_moderation", sceneContext: { ...ctx, targetPerson: target }, frames: [{ mimeType: "image/jpeg", base64: "AAAA" }] });
    const body = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)));
    for (const needle of ["target_match", "target_confidence", "Identity check: the video is about Lee Felix", "Never guess", "Hyunjin", "news_card"]) expect(body).toContain(needle);
    expect(result.raw.identity).toEqual({ match: "different_person", confidence: 0.8 });

    vi.stubGlobal("fetch", vi.fn(async () => gemini({ ...base, ...shotFields, target_match: "probably", target_confidence: 0.8 })));
    const partial = await moderateMediaWithVision({ kind: "gemini", apiKey: "k", modelId: "gemini-2.5-flash", operation: "image_moderation", sceneContext: { ...ctx, targetPerson: target }, frames: [{ mimeType: "image/jpeg", base64: "AAAA" }] });
    expect(partial.raw.identity).toBeUndefined();
    expect(partial.raw.shot).toBeDefined();
  });
});
