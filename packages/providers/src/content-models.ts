export type ContentKind = "openai" | "gemini" | "xai";

export const CONTENT_MODEL_RANKING_VERSION = "content-ranking-2026-09-26-v1";

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

/** Stable quality-preference order, constrained to model IDs discovered for one account. */
export const rankContentModels = (kind: ContentKind, accountModels: readonly string[]) => {
  const preference = CURATED_CONTENT_MODELS[kind];
  return [...new Set(accountModels.map((id) => resolveContentModel(kind, id)))].sort((left, right) => {
    const leftRank = preference.indexOf(left);
    const rightRank = preference.indexOf(right);
    if (leftRank >= 0 && rightRank >= 0) return leftRank - rightRank;
    if (leftRank >= 0) return -1;
    if (rightRank >= 0) return 1;
    return left.localeCompare(right);
  });
};

export const suggestedModelFromError = (detail: string) => {
  const match = detail.match(/use models\/([a-z0-9._-]+)/i);
  return match?.[1] ? normalizeModelId(match[1]) : null;
};

/**
 * V00-10: account-scoped discovery only - filters/normalizes the account's own live `/models`
 * response, but never unions it with the static curated catalog. A missing/retired model
 * therefore cannot survive into the result just because it used to be a well-known model ID.
 * This is discovery evidence, not proof of generate access - callers must still probe the
 * exact generate endpoint before treating a listed model as usable (see `content-probe.ts`).
 */
export const discoveredContentModels = (kind: ContentKind, live: readonly string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of live) {
    const id = resolveContentModel(kind, item);
    if (!isTextContentModel(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

/** @deprecated kept only for the pre-V00-10 curated-catalog union test; do not use for account-scoped verify. */
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
