export type ContentKind = "openai" | "gemini" | "xai";

export const CURATED_CONTENT_MODELS: Record<ContentKind, readonly string[]> = {
  openai: [
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
    "o3",
    "o3-mini",
  ],
  gemini: [
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
  ],
  xai: [
    "grok-4",
    "grok-4-fast",
    "grok-3",
    "grok-3-mini",
    "grok-3-mini-fast",
    "grok-2",
    "grok-2-latest",
    "grok-2-1212",
  ],
};

/** Models Google/OpenAI still list or we used to pin, but generate 404s for new keys. */
export const RETIRED_CONTENT_MODELS: Record<ContentKind, Record<string, string>> = {
  openai: {},
  gemini: {
    "gemini-2.5-pro": "gemini-3.1-pro-preview",
    "gemini-1.5-pro": "gemini-3.1-pro-preview",
    "gemini-1.5-flash": "gemini-2.5-flash",
    "gemini-pro": "gemini-3.1-pro-preview",
  },
  xai: {},
};

const SKIP = /whisper|tts-|dall-e|embedding|realtime|audio|transcribe|imagen|veo|moderation|omni-moderation|babbage|davinci|tts$/i;

export const normalizeModelId = (value: string) => value.replace(/^models\//, "").trim();

export const isTextContentModel = (id: string) => {
  const name = normalizeModelId(id);
  if (!name) return false;
  return !SKIP.test(name);
};

export const resolveContentModel = (kind: ContentKind, id: string) => {
  const name = normalizeModelId(id);
  return RETIRED_CONTENT_MODELS[kind][name] ?? name;
};

export const suggestedModelFromError = (detail: string) => {
  const match = detail.match(/use models\/([a-z0-9._-]+)/i);
  return match?.[1] ? normalizeModelId(match[1]) : null;
};

export const mergeContentModels = (kind: ContentKind, live: readonly string[]) => {
  const merged = new Set<string>(CURATED_CONTENT_MODELS[kind].map((id) => resolveContentModel(kind, id)));
  for (const item of live) {
    const id = resolveContentModel(kind, item);
    if (isTextContentModel(id)) merged.add(id);
  }
  for (const retired of Object.keys(RETIRED_CONTENT_MODELS[kind])) merged.delete(retired);
  return [...merged].sort((a, b) => {
    const curated = CURATED_CONTENT_MODELS[kind] as readonly string[];
    const ia = curated.indexOf(a);
    const ib = curated.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
};
