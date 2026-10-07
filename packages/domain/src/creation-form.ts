/**
 * VE2E-124: the new-job form (`JobNewPage`) as data - its value sets, the system defaults, and the whitelist rules for a user's
 * draft and creation defaults. Pure, no I/O, browser-safe (subpath `@lyonix/domain/creation-form`): the API sanitizes with it
 * before anything is stored, the web app resolves the initial form with it, so both always agree.
 *
 * Draft = every form value (a job not created yet: no workflow, no provider call, no cost).
 * Defaults = only the OPTIONS (mode, language, accounts, voice, template, targets ...) - never job content (topic, prompt, scripts,
 * article URL), which must not leak from one job into the next. Identifiers only, never a secret.
 * There is no "model" field: the model is the content account's own pinned model (`ProviderAccount.model`).
 */
import { BACKGROUND_SEGMENT_COUNT_DEFAULT_BOUNDS } from "./background-segments.js";
import { CAPTION_PRESETS } from "./caption-presets.js";

export const CREATION_FLOW_TYPES = ["job_new"] as const;
export type CreationFlowType = (typeof CREATION_FLOW_TYPES)[number];
export const isCreationFlowType = (value: string): value is CreationFlowType => (CREATION_FLOW_TYPES as readonly string[]).includes(value);

export const ENTRY_MODES = ["manual", "auto"] as const;
export const MANUAL_MODES = ["topic", "revise"] as const;
export const AUTO_SOURCE_TYPES = ["topic", "raw_script", "article_url"] as const;
export const CONTENT_LANGUAGES = ["vi", "en", "ja", "ko"] as const;
export const DURATION_TARGETS = ["30-45s", "45-65s", "65-90s"] as const;
export const SCENE_COUNT_TARGETS = ["6-8", "8-12", "12-16"] as const;
/** VE2E-94: "" = the template's own caption style, else a caption preset id (an id no longer in the catalog is dropped on restore). */
export const CAPTION_PRESET_CHOICES: readonly string[] = ["", ...CAPTION_PRESETS.map((item) => item.id)];
export const ORSHOT_FORMAT_CHOICES = ["", "mp4", "webm", "mov", "gif"] as const;
/** VE2E-40: "auto" or a fixed count within the placeholder bounds (the server re-validates on submit). */
export const BACKGROUND_SEGMENT_CHOICES: readonly string[] = [
  "auto",
  ...Array.from({ length: BACKGROUND_SEGMENT_COUNT_DEFAULT_BOUNDS.max - BACKGROUND_SEGMENT_COUNT_DEFAULT_BOUNDS.min + 1 }, (_, index) => String(BACKGROUND_SEGMENT_COUNT_DEFAULT_BOUNDS.min + index)),
];

export type JobNewFormValues = {
  entryMode: (typeof ENTRY_MODES)[number];
  mode: (typeof MANUAL_MODES)[number];
  autoSourceType: (typeof AUTO_SOURCE_TYPES)[number];
  channelId: string;
  language: (typeof CONTENT_LANGUAGES)[number];
  topic: string;
  promptSpec: string;
  existingScript: string;
  autoRawScript: string;
  autoArticleUrl: string;
  contentAccountId: string;
  durationTarget: (typeof DURATION_TARGETS)[number];
  sceneCountTarget: (typeof SCENE_COUNT_TARGETS)[number];
  backgroundSegmentsChoice: string;
  voiceAccountId: string;
  voiceId: string;
  mediaAccountId: string;
  renderAccountId: string;
  templateId: string;
  orshotFormat: (typeof ORSHOT_FORMAT_CHOICES)[number];
  orshotSize: string;
  captionPresetId: string;
};

export type JobNewFieldKey = keyof JobNewFormValues;

/** The defaults of the page before VE2E-124 (were hard-coded in JobNewPage). An empty id = "nothing chosen yet". */
export const SYSTEM_CREATION_DEFAULTS: JobNewFormValues = {
  entryMode: "manual",
  mode: "topic",
  autoSourceType: "topic",
  channelId: "",
  language: "vi",
  topic: "",
  promptSpec: "",
  existingScript: "",
  autoRawScript: "",
  autoArticleUrl: "",
  contentAccountId: "",
  durationTarget: "45-65s",
  sceneCountTarget: "8-12",
  backgroundSegmentsChoice: "auto",
  voiceAccountId: "",
  voiceId: "",
  mediaAccountId: "",
  renderAccountId: "",
  templateId: "",
  orshotFormat: "",
  orshotSize: "",
  captionPresetId: "",
};

/** Job content: in a draft, never in defaults. */
export const CREATION_CONTENT_KEYS = ["topic", "promptSpec", "existingScript", "autoRawScript", "autoArticleUrl"] as const satisfies readonly JobNewFieldKey[];
/** Options a user may save as their defaults. */
export const CREATION_PREFERENCE_KEYS = [
  "entryMode",
  "mode",
  "autoSourceType",
  "channelId",
  "language",
  "contentAccountId",
  "durationTarget",
  "sceneCountTarget",
  "backgroundSegmentsChoice",
  "voiceAccountId",
  "voiceId",
  "mediaAccountId",
  "renderAccountId",
  "templateId",
  "orshotFormat",
  "orshotSize",
  "captionPresetId",
] as const satisfies readonly JobNewFieldKey[];
/** Identifiers of things that can disappear or lose access after they were saved (checked again on restore). */
export const CREATION_REFERENCE_KEYS = ["channelId", "contentAccountId", "voiceAccountId", "voiceId", "mediaAccountId", "renderAccountId", "templateId"] as const satisfies readonly JobNewFieldKey[];

export type CreationPreferenceKey = (typeof CREATION_PREFERENCE_KEYS)[number];
export type CreationPreferenceOptions = Partial<Pick<JobNewFormValues, CreationPreferenceKey>>;
export type JobNewDraftPayload = Partial<JobNewFormValues>;

export const CREATION_LIMITS = {
  /** Topic / prompt / pasted script / article URL. */
  maxContentChars: 50_000,
  /** Account, voice, template, channel ids and the Orshot size preset. */
  maxIdChars: 200,
} as const;

const ENUMS: Partial<Record<JobNewFieldKey, readonly string[]>> = {
  entryMode: ENTRY_MODES,
  mode: MANUAL_MODES,
  autoSourceType: AUTO_SOURCE_TYPES,
  language: CONTENT_LANGUAGES,
  durationTarget: DURATION_TARGETS,
  sceneCountTarget: SCENE_COUNT_TARGETS,
  backgroundSegmentsChoice: BACKGROUND_SEGMENT_CHOICES,
  orshotFormat: ORSHOT_FORMAT_CHOICES,
  captionPresetId: CAPTION_PRESET_CHOICES,
};
const CONTENT_KEY_SET = new Set<string>(CREATION_CONTENT_KEYS);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** One value, or `undefined` when it is not acceptable for that key (unknown key, wrong type, not in the enum, too long, control chars in an id). */
function sanitizeValue(key: string, value: unknown): string | undefined {
  if (!(key in SYSTEM_CREATION_DEFAULTS) || typeof value !== "string") return undefined;
  const allowed = ENUMS[key as JobNewFieldKey];
  if (allowed) return allowed.includes(value) ? value : undefined;
  if (CONTENT_KEY_SET.has(key)) return value.length <= CREATION_LIMITS.maxContentChars ? value : undefined;
  return value.length <= CREATION_LIMITS.maxIdChars && !CONTROL_CHARS.test(value) ? value : undefined;
}

const sanitizeKeys = (input: unknown, keys: readonly string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = sanitizeValue(key, record[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

/** Whitelisted draft: every known form key with a valid value; anything else (unknown keys, bad values) is dropped. */
export const sanitizeJobNewDraft = (input: unknown): JobNewDraftPayload => sanitizeKeys(input, Object.keys(SYSTEM_CREATION_DEFAULTS)) as JobNewDraftPayload;

/** Whitelisted defaults: options only - job content (topic, prompt, scripts, URL) is dropped even when sent. */
export const sanitizeCreationPreferences = (input: unknown): CreationPreferenceOptions => sanitizeKeys(input, CREATION_PREFERENCE_KEYS) as CreationPreferenceOptions;

/** The options of a form, ready to save as defaults. */
export const pickCreationPreferences = (values: JobNewFormValues): CreationPreferenceOptions => sanitizeCreationPreferences(values);

export type InitialFormSource = "draft" | "preferences" | "system" | "url";

/**
 * The form a user starts from: system defaults, overlaid by the user's defaults, overlaid by the user's draft (the draft always
 * wins over defaults), and finally the explicit URL intent (`?entry=`, `?channelId=` - owner decision: the link the user clicked
 * says which mode/channel they want). `sources` says where each field came from, so the page knows which values were RESTORED
 * (and must be re-validated, never silently replaced) versus untouched system defaults (which may be auto-filled as before).
 */
export function resolveInitialForm(input: {
  preferences?: CreationPreferenceOptions | null;
  draft?: JobNewDraftPayload | null;
  url?: { entryMode?: string | null; channelId?: string | null };
}): { values: JobNewFormValues; sources: Record<JobNewFieldKey, InitialFormSource> } {
  const values: JobNewFormValues = { ...SYSTEM_CREATION_DEFAULTS };
  const sources = Object.fromEntries(Object.keys(values).map((key) => [key, "system"])) as Record<JobNewFieldKey, InitialFormSource>;
  const overlay = (patch: Record<string, string>, source: InitialFormSource) => {
    for (const [key, value] of Object.entries(patch)) {
      (values as Record<string, string>)[key] = value;
      sources[key as JobNewFieldKey] = source;
    }
  };
  overlay(sanitizeCreationPreferences(input.preferences), "preferences");
  overlay(sanitizeJobNewDraft(input.draft) as Record<string, string>, "draft");
  const url: Record<string, string> = {};
  const entry = sanitizeValue("entryMode", input.url?.entryMode ?? undefined);
  const channel = input.url?.channelId ? sanitizeValue("channelId", input.url.channelId) : undefined;
  if (entry) url.entryMode = entry;
  if (channel) url.channelId = channel;
  overlay(url, "url");
  return { values, sources };
}

/** Available identifiers per reference field, or `null` while that list is not loaded yet (nothing is judged until it is). */
export type CreationAvailability = Partial<Record<(typeof CREATION_REFERENCE_KEYS)[number], readonly string[] | null>>;

/**
 * Restored references that no longer exist or are no longer accessible: they are CLEARED (never replaced by another account,
 * voice or template) and reported, so the page can ask the user to choose again. Fields whose list is not loaded are left as is.
 */
export function clearUnavailableReferences(
  values: JobNewFormValues,
  availability: CreationAvailability,
  restored: ReadonlySet<JobNewFieldKey>,
): { values: JobNewFormValues; cleared: JobNewFieldKey[] } {
  const next = { ...values };
  const cleared: JobNewFieldKey[] = [];
  for (const key of CREATION_REFERENCE_KEYS) {
    const available = availability[key];
    const value = next[key];
    if (!restored.has(key) || !value || !available) continue;
    if (!available.includes(value)) {
      next[key] = "";
      cleared.push(key);
    }
  }
  return { values: next, cleared };
}
