import type { ElevenLabsVoiceSummaryResponse, UiLocale } from "@lyonix/contracts";

/**
 * Voice Picker (create-video page): search / filter / preview helpers, free of React so they are tested directly.
 * Only ElevenLabs is a TTS provider today; `provider` is kept on every option so a second one slots in.
 */
export type VoiceProvider = "elevenlabs";
export type VoiceOption = ElevenLabsVoiceSummaryResponse & { provider: VoiceProvider };
export type VoiceLanguageFilter = "all" | "ja" | "vi" | "en";
export type VoiceGenderFilter = "all" | "male" | "female";
export type VoiceFilters = { query: string; language: VoiceLanguageFilter; gender: VoiceGenderFilter; provider: "all" | VoiceProvider; /** only voices the users cloned */ cloned?: boolean };

export const NO_VOICE_FILTERS: VoiceFilters = { query: "", language: "all", gender: "all", provider: "all" };

export const toVoiceOptions = (rows: readonly ElevenLabsVoiceSummaryResponse[], provider: VoiceProvider = "elevenlabs"): VoiceOption[] => rows.map((row) => ({ ...row, provider }));

/** A voice made through "Clone giọng" (ElevenLabs reports it as category "cloned"). */
export const isClonedVoice = (voice: Pick<VoiceOption, "category">): boolean => voice.category === "cloned";

/** Lower case, width-folded (NFKC) and without Vietnamese / Latin accents, so "tieng nhat" finds "Tiếng Nhật". */
export const foldText = (value: string): string => value.normalize("NFKC").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");

/** Every language a voice speaks (ISO 639-1): its label language and its verified languages. */
export const voiceLanguages = (voice: Pick<VoiceOption, "language" | "languages">): string[] =>
  [...new Set([voice.language, ...voice.languages.map((entry) => entry.language)].filter((code): code is string => Boolean(code)).map((code) => code.toLowerCase()))];

/** "Roger - Laid-Back, Casual, Resonant" -> title "Roger", tagline "Laid-Back, Casual, Resonant". */
export const splitVoiceName = (name: string): { title: string; tagline: string | null } => {
  const at = name.indexOf(" - ");
  return at > 0 ? { title: name.slice(0, at).trim(), tagline: name.slice(at + 3).trim() || null } : { title: name.trim(), tagline: null };
};

/** Words that find a language / gender in any of the four UI languages (search is language-agnostic). */
const LANGUAGE_WORDS: Record<string, string[]> = {
  ja: ["japanese", "tiếng nhật", "nhật", "日本語", "日本", "일본어"],
  vi: ["vietnamese", "tiếng việt", "việt", "ベトナム語", "베트남어"],
  en: ["english", "tiếng anh", "anh", "英語", "영어"],
  ko: ["korean", "tiếng hàn", "hàn", "韓国語", "한국어"],
  zh: ["chinese", "tiếng trung", "trung", "中国語", "중국어"],
};
const GENDER_WORDS: Record<string, string[]> = {
  male: ["male", "man", "nam", "男性", "男", "남성", "남자"],
  female: ["female", "woman", "nữ", "女性", "女", "여성", "여자"],
  neutral: ["neutral", "trung tính", "中性", "중성"],
};

/** Everything a search may match on: name, provider, language, gender, accent, age, use case, style. */
export const voiceHaystack = (voice: VoiceOption): string => {
  const languages = voiceLanguages(voice);
  const parts = [
    voice.name,
    voice.provider,
    voice.provider === "elevenlabs" ? "ElevenLabs" : "",
    voice.category ?? "",
    voice.accent ?? "",
    voice.age ?? "",
    (voice.useCase ?? "").replace(/_/g, " "),
    voice.descriptive ?? "",
    ...languages,
    ...languages.flatMap((code) => LANGUAGE_WORDS[code] ?? []),
    ...voice.languages.map((entry) => entry.accent ?? ""),
    ...(voice.gender ? [voice.gender, ...(GENDER_WORDS[voice.gender.toLowerCase()] ?? [])] : []),
  ];
  return foldText(parts.join(" "));
};

/** Search (every word must match somewhere) + the language / gender / provider chips. */
export function filterVoices(voices: readonly VoiceOption[], filters: VoiceFilters): VoiceOption[] {
  const words = foldText(filters.query).split(/\s+/).filter(Boolean);
  return voices.filter((voice) => {
    if (filters.provider !== "all" && voice.provider !== filters.provider) return false;
    if (filters.cloned && !isClonedVoice(voice)) return false;
    // a fresh clone has no language labels but speaks every language of the multilingual models, so a language chip never hides it
    if (filters.language !== "all" && !voiceLanguages(voice).includes(filters.language) && !(isClonedVoice(voice) && voiceLanguages(voice).length === 0)) return false;
    if (filters.gender !== "all" && (voice.gender ?? "").toLowerCase() !== filters.gender) return false;
    if (words.length === 0) return true;
    const haystack = voiceHaystack(voice);
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * The provider's own preview (free, no TTS): the one recorded in the script language for the account's model, else any one
 * in that language, else the voice's main preview. null = this voice has no provider preview (the picker falls back to TTS).
 */
export function providerPreviewUrl(voice: Pick<VoiceOption, "previewUrl" | "languages">, language: UiLocale, modelId?: string | null): string | null {
  const inLanguage = voice.languages.filter((entry) => entry.language.toLowerCase() === language && entry.previewUrl);
  return inLanguage.find((entry) => modelId && entry.modelId === modelId)?.previewUrl ?? inLanguage[0]?.previewUrl ?? voice.previewUrl ?? null;
}

/** What one Play needs. The account + voiceId are the very ones the render uses (see `renderVoiceConfig`). */
export type PreviewTarget = { provider: VoiceProvider; accountId: string | null; voiceId: string; language: UiLocale; previewUrl: string | null };

type VoiceForm = { voiceAccountId: string; voiceId: string; language: UiLocale };

/** The voice an Auto run is set up with (account + voiceId) - shared by the submit and the preview so they cannot drift apart. */
export const renderVoiceConfig = (form: Pick<VoiceForm, "voiceAccountId" | "voiceId">) => ({ voiceAccountId: form.voiceAccountId, voiceId: form.voiceId });

export function previewTarget(form: Pick<VoiceForm, "voiceAccountId" | "language">, voice: VoiceOption, modelId?: string | null): PreviewTarget {
  return {
    provider: voice.provider,
    accountId: renderVoiceConfig({ voiceAccountId: form.voiceAccountId, voiceId: voice.voiceId }).voiceAccountId || null,
    voiceId: voice.voiceId,
    language: form.language,
    previewUrl: providerPreviewUrl(voice, form.language, modelId),
  };
}

/** Synthesized previews are cached per provider + voice + sample sentence (the sentence is fixed per language on the server). */
export const previewCacheKey = (target: Pick<PreviewTarget, "provider" | "voiceId" | "language">): string => `${target.provider}|${target.voiceId}|sample:${target.language}`;
