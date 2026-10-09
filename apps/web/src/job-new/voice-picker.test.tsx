import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import type { ElevenLabsVoiceSummaryResponse } from "@lyonix/contracts";
import { SYSTEM_CREATION_DEFAULTS, pickCreationPreferences, sanitizeJobNewDraft } from "@lyonix/domain/creation-form";
import { NO_VOICE_FILTERS, filterVoices, previewCacheKey, previewTarget, providerPreviewUrl, renderVoiceConfig, splitVoiceName, toVoiceOptions } from "./voice-picker";
import { VoicePreviewController, type AudioLike } from "./voice-preview";

const { VoicePicker } = await import("./VoicePicker");
const { locales } = await import("../i18n/locales");
const instance = i18n.createInstance();
await instance.init({ lng: "vi", resources: { vi: { translation: locales.vi } }, interpolation: { escapeValue: false } });

const voice = (over: Partial<ElevenLabsVoiceSummaryResponse> & { voiceId: string; name: string }): ElevenLabsVoiceSummaryResponse => ({
  category: "premade", previewUrl: `https://storage.googleapis.com/eleven/${over.voiceId}.mp3`, gender: null, language: null, accent: null, age: null, useCase: null, descriptive: null, languages: [], ...over,
});

/** Shapes taken from the live /v1/voices answer (2026-10-08). */
const ROWS: ElevenLabsVoiceSummaryResponse[] = [
  voice({ voiceId: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger - Laid-Back, Casual, Resonant", gender: "male", language: "en", accent: "american", useCase: "conversational", descriptive: "classy",
    languages: [{ language: "en", accent: "american", locale: "en-US", modelId: "eleven_multilingual_v2", previewUrl: "https://storage.googleapis.com/eleven/roger-en.mp3" }] }),
  voice({ voiceId: "EXAVITQu4vr4xnSDxMaL", name: "Sarah - Mature, Reassuring, Confident", gender: "female", language: "en", useCase: "entertainment_tv", descriptive: "professional",
    languages: [
      { language: "en", accent: "american", locale: "en-US", modelId: "eleven_multilingual_v2", previewUrl: "https://storage.googleapis.com/eleven/sarah-en.mp3" },
      { language: "ja", accent: "standard", locale: "ja-JP", modelId: "eleven_turbo_v2_5", previewUrl: "https://storage.googleapis.com/eleven/sarah-ja-turbo.mp3" },
      { language: "ja", accent: "standard", locale: "ja-JP", modelId: "eleven_multilingual_v2", previewUrl: "https://storage.googleapis.com/eleven/sarah-ja-multi.mp3" },
    ] }),
  voice({ voiceId: "JBFqnCBsd6RMkjVDRZzb", name: "George - Warm, Captivating Storyteller", gender: "male", language: "en", accent: "british", useCase: "narrative_story", descriptive: "mature" }),
  voice({ voiceId: "cloneVoiceVi0001", name: "Lan - giọng clone", category: "cloned", previewUrl: null, gender: "female", language: "vi", languages: [] }),
];
const OPTIONS = toVoiceOptions(ROWS);
const ids = (list: { voiceId: string }[]) => list.map((item) => item.voiceId);

describe("Voice Picker search and filters", () => {
  it("search finds a voice by name, language (any UI language, accents optional), gender, style and provider", () => {
    const search = (query: string) => ids(filterVoices(OPTIONS, { ...NO_VOICE_FILTERS, query }));
    expect(search("roger")).toEqual(["CwhRBWXzGAHq8TQ4Fs17"]);
    expect(search("tiếng nhật")).toEqual(["EXAVITQu4vr4xnSDxMaL"]);
    expect(search("tieng nhat")).toEqual(["EXAVITQu4vr4xnSDxMaL"]);
    expect(search("日本語")).toEqual(["EXAVITQu4vr4xnSDxMaL"]);
    expect(search("nữ")).toEqual(["EXAVITQu4vr4xnSDxMaL", "cloneVoiceVi0001"]);
    expect(search("female vietnamese")).toEqual(["cloneVoiceVi0001"]);
    expect(search("narrative story")).toEqual(["JBFqnCBsd6RMkjVDRZzb"]);
    expect(search("british")).toEqual(["JBFqnCBsd6RMkjVDRZzb"]);
    expect(search("elevenlabs")).toHaveLength(4);
    expect(search("nobody here")).toEqual([]);
  });

  it("chips: language and gender combine; All shows everything", () => {
    const pick = (language: "all" | "ja" | "vi" | "en", gender: "all" | "male" | "female") => ids(filterVoices(OPTIONS, { ...NO_VOICE_FILTERS, language, gender }));
    expect(pick("all", "all")).toHaveLength(4);
    expect(pick("ja", "all")).toEqual(["EXAVITQu4vr4xnSDxMaL"]);
    expect(pick("vi", "all")).toEqual(["cloneVoiceVi0001"]);
    expect(pick("en", "male")).toEqual(["CwhRBWXzGAHq8TQ4Fs17", "JBFqnCBsd6RMkjVDRZzb"]);
    expect(pick("en", "female")).toEqual(["EXAVITQu4vr4xnSDxMaL"]);
    expect(ids(filterVoices(OPTIONS, { ...NO_VOICE_FILTERS, provider: "elevenlabs" }))).toHaveLength(4);
  });

  it("the Giọng clone chip keeps only cloned voices; a fresh clone (no language labels) survives every language chip", () => {
    const fresh = toVoiceOptions([...ROWS, voice({ voiceId: "freshClone0001", name: "Mới tạo", category: "cloned", previewUrl: null })]);
    const only = (filters: Partial<typeof NO_VOICE_FILTERS>) => ids(filterVoices(fresh, { ...NO_VOICE_FILTERS, ...filters }));
    expect(only({ cloned: true })).toEqual(["cloneVoiceVi0001", "freshClone0001"]);
    expect(only({ language: "ja" })).toEqual(["EXAVITQu4vr4xnSDxMaL", "freshClone0001"]);
    expect(only({ language: "vi" })).toEqual(["cloneVoiceVi0001", "freshClone0001"]);
    expect(only({ cloned: true, gender: "female" })).toEqual(["cloneVoiceVi0001"]);
  });

  it("names split into a title and a tagline", () => {
    expect(splitVoiceName("Roger - Laid-Back, Casual, Resonant")).toEqual({ title: "Roger", tagline: "Laid-Back, Casual, Resonant" });
    expect(splitVoiceName("Lan")).toEqual({ title: "Lan", tagline: null });
  });
});

describe("Voice preview source", () => {
  it("provider preview first: the script language + the account's model, then that language, then the main preview; none -> TTS", () => {
    const sarah = OPTIONS[1]!;
    expect(providerPreviewUrl(sarah, "ja", "eleven_multilingual_v2")).toBe("https://storage.googleapis.com/eleven/sarah-ja-multi.mp3");
    expect(providerPreviewUrl(sarah, "ja", "eleven_flash_v2")).toBe("https://storage.googleapis.com/eleven/sarah-ja-turbo.mp3");
    expect(providerPreviewUrl(sarah, "vi", "eleven_multilingual_v2")).toBe("https://storage.googleapis.com/eleven/EXAVITQu4vr4xnSDxMaL.mp3");
    expect(providerPreviewUrl(OPTIONS[3]!, "vi", null)).toBeNull();
  });

  it("the preview plays the very account + voiceId the render is set up with", () => {
    const form = { ...SYSTEM_CREATION_DEFAULTS, entryMode: "auto" as const, voiceAccountId: "el-account-1", language: "ja" as const };
    const chosen = { ...form, voiceId: OPTIONS[1]!.voiceId }; // what Chọn writes into the form
    const target = previewTarget(chosen, OPTIONS[1]!, "eleven_multilingual_v2");
    expect({ voiceAccountId: target.accountId, voiceId: target.voiceId }).toEqual(renderVoiceConfig(chosen));
    expect(target.provider).toBe("elevenlabs");
  });

  it("the chosen voice is kept by the draft and by the user defaults (same field as before)", () => {
    const form = { ...SYSTEM_CREATION_DEFAULTS, voiceAccountId: "el-account-1", voiceId: "EXAVITQu4vr4xnSDxMaL" };
    expect(sanitizeJobNewDraft(form).voiceId).toBe("EXAVITQu4vr4xnSDxMaL");
    expect(pickCreationPreferences(form).voiceId).toBe("EXAVITQu4vr4xnSDxMaL");
  });
});

/** A fake <audio>: records src / play / pause. */
function fakeAudio() {
  const audio = { src: "", currentTime: 0, plays: [] as string[], pauses: 0, onended: null as (() => void) | null, onerror: null as (() => void) | null,
    async play() { audio.plays.push(audio.src); },
    pause() { audio.pauses += 1; },
  };
  return audio;
}

const setupController = (fetchTts: (target: { voiceId: string; language: string }) => Promise<Blob> = async () => new Blob(["mp3"])) => {
  const audio = fakeAudio();
  const fetchSpy = vi.fn(fetchTts);
  const controller = new VoicePreviewController({ createAudio: () => audio as AudioLike, fetchTts: fetchSpy, toUrl: () => `blob:preview-${fetchSpy.mock.calls.length}`, cache: new Map() });
  return { audio, controller, fetchSpy };
};

const target = (voiceId: string, over: Partial<{ previewUrl: string | null; accountId: string | null; language: "vi" | "en" | "ja" | "ko" }> = {}) => ({
  provider: "elevenlabs" as const, voiceId, accountId: "el-account-1", language: "ja" as const, previewUrl: `https://storage.googleapis.com/eleven/${voiceId}.mp3`, ...over,
});

describe("Voice preview player", () => {
  it("play -> pause -> resume on the same voice; the provider preview needs no TTS call", async () => {
    const { audio, controller, fetchSpy } = setupController();
    await controller.toggle(target("roger"));
    expect(controller.getState()).toMatchObject({ activeId: "roger", status: "playing" });
    expect(audio.plays).toEqual(["https://storage.googleapis.com/eleven/roger.mp3"]);
    await controller.toggle(target("roger"));
    expect(controller.statusOf("roger")).toBe("paused");
    await controller.toggle(target("roger"));
    expect(controller.statusOf("roger")).toBe("playing");
    expect(fetchSpy).not.toHaveBeenCalled();
    audio.onended?.();
    expect(controller.getState()).toMatchObject({ activeId: null, status: "idle" });
  });

  it("another voice stops the old audio first - only one plays at a time", async () => {
    const { audio, controller } = setupController();
    await controller.toggle(target("roger"));
    await controller.toggle(target("sarah"));
    expect(audio.pauses).toBe(1);
    expect(audio.plays).toEqual(["https://storage.googleapis.com/eleven/roger.mp3", "https://storage.googleapis.com/eleven/sarah.mp3"]);
    expect(controller.statusOf("roger")).toBe("idle");
    expect(controller.statusOf("sarah")).toBe("playing");
  });

  it("a voice without a provider preview is synthesized once per provider + voice + sample; replays use the cache", async () => {
    const { audio, controller, fetchSpy } = setupController();
    const clone = target("lan", { previewUrl: null });
    await controller.toggle(clone);
    await controller.toggle(target("roger"));
    await controller.toggle(clone);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(audio.plays.filter((src) => src.startsWith("blob:"))).toEqual(["blob:preview-1", "blob:preview-1"]);
    controller.stop(); // the picker stops the player when the script language changes
    await controller.toggle(target("lan", { previewUrl: null, language: "vi" })); // another sample sentence = another key
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(previewCacheKey(clone)).toBe("elevenlabs|lan|sample:ja");
  });

  it("provider error (e.g. quota): the card shows it, nothing plays, and Play again retries (a failure is not cached)", async () => {
    let fail = true;
    const { audio, controller, fetchSpy } = setupController(async () => { if (fail) throw Object.assign(new Error("quota"), { code: "PROVIDER_QUOTA_EXHAUSTED" }); return new Blob(["mp3"]); });
    await controller.toggle(target("lan", { previewUrl: null }));
    expect(controller.statusOf("lan")).toBe("error");
    expect(controller.getState().errors.lan).toBe("PROVIDER_QUOTA_EXHAUSTED");
    expect(audio.plays).toEqual([]);
    fail = false;
    await controller.toggle(target("lan", { previewUrl: null }));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(controller.statusOf("lan")).toBe("playing");
    expect(controller.getState().errors.lan).toBeUndefined();
  });

  it("no provider preview and no account: unavailable, no call; a slow TTS answer never plays over the next voice", async () => {
    const { controller, fetchSpy } = setupController();
    await controller.toggle(target("orphan", { previewUrl: null, accountId: null }));
    expect(controller.statusOf("orphan")).toBe("unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();

    let release: (blob: Blob) => void = () => undefined;
    const slow = setupController(() => new Promise<Blob>((resolve) => { release = resolve; }));
    const loading = slow.controller.toggle(target("lan", { previewUrl: null }));
    expect(slow.controller.statusOf("lan")).toBe("loading");
    await slow.controller.toggle(target("roger"));
    release(new Blob(["mp3"]));
    await loading;
    expect(slow.audio.src).toBe("https://storage.googleapis.com/eleven/roger.mp3");
    expect(slow.controller.getState()).toMatchObject({ activeId: "roger", status: "playing" });
  });
});

describe("Voice Picker cards", () => {
  const render = (props: Partial<Parameters<typeof VoicePicker>[0]> = {}) => renderToStaticMarkup(
    <I18nextProvider i18n={instance}>
      <VoicePicker voices={ROWS} selectedId="EXAVITQu4vr4xnSDxMaL" onSelect={() => undefined} language="ja" accountId="el-account-1" modelId="eleven_multilingual_v2" {...props} />
    </I18nextProvider>,
  );

  it("search box, filter chips, the count and one compact card per voice with play + choose", () => {
    const out = render();
    expect(out).toContain('data-testid="voice-search"');
    for (const key of ["all", "ja", "vi", "en", "male", "female"]) expect(out).toContain(`data-testid="voice-filter-${key}"`);
    expect(out).not.toContain('data-testid="voice-filter-elevenlabs"'); // one provider: no provider chip
    expect(out).toContain("4/4 giọng");
    expect(out.match(/data-testid="voice-card"/g)).toHaveLength(4);
    expect(out.match(/data-testid="voice-play"/g)).toHaveLength(4);
    expect(out).toContain(">ElevenLabs<");
  });

  it("the chosen voice has the selected state (border via data-selected, pressed Chọn, check badge)", () => {
    const out = render();
    expect(out).toMatch(/data-voice-id="EXAVITQu4vr4xnSDxMaL" data-selected="true"/);
    expect(out).toMatch(/data-voice-id="CwhRBWXzGAHq8TQ4Fs17" data-selected="false"/);
    expect(out).toMatch(/aria-pressed="true"[^>]*data-testid="voice-choose"[^>]*>[\s\S]*?Đang chọn/);
    expect(out.match(/lyx-voice-check/g)).toHaveLength(1);
    expect(out).toContain("Đang chọn: Sarah");
  });

  it("a voice without a provider preview is marked TTS; without an account it is unavailable (button disabled)", () => {
    expect(render()).toMatch(/data-voice-id="cloneVoiceVi0001"[\s\S]*?>TTS</);
    const out = render({ accountId: "" });
    expect(out).toMatch(/data-voice-id="cloneVoiceVi0001"[^>]*data-preview="unavailable"[\s\S]*?<button[^>]*disabled=""[^>]*data-testid="voice-play"/);
  });

  it("cloned voices: a badge + a Giọng clone chip; the Clone giọng button only when the page can handle a new voice and has an account", () => {
    const out = render();
    expect(out).toContain('data-testid="voice-filter-cloned"');
    expect(out.match(/data-testid="voice-cloned-badge"/g)).toHaveLength(1);
    expect(out).not.toContain('data-testid="voice-clone-open"');
    expect(render({ onCloned: () => undefined })).toContain('data-testid="voice-clone-open"');
    expect(render({ onCloned: () => undefined, accountId: "" })).not.toContain('data-testid="voice-clone-open"');
    expect(renderToStaticMarkup(<I18nextProvider i18n={instance}><VoicePicker voices={ROWS.slice(0, 3)} selectedId="" onSelect={() => undefined} language="ja" accountId="a" modelId={null} /></I18nextProvider>)).not.toContain('data-testid="voice-filter-cloned"');
  });

  it("loading and failed lists say so", () => {
    expect(render({ state: "loading" })).toContain('data-testid="skeleton"');
    expect(render({ state: "failed" })).toContain('data-testid="voice-picker-failed"');
  });
});
