/**
 * VE2E-124: how the new-job form starts. Order: the user's draft > the user's defaults > system defaults, with the explicit URL
 * intent (`?entry=`, `?channelId=`) on top (see `resolveInitialForm`). Restored references that are gone or no longer accessible
 * are CLEARED and reported - never silently replaced by another account, voice, template or channel. The old "pick the first one"
 * behaviour only fills fields that are still empty and were not cleared.
 */
import {
  clearUnavailableReferences,
  resolveInitialForm,
  type CreationPreferenceOptions,
  type JobNewDraftPayload,
  type JobNewFieldKey,
  type JobNewFormValues,
} from "@lyonix/domain/creation-form";
import type { PublicChannel } from "../channel-api";
import type { ApiProvider } from "../jobs-api";

export const usableAccounts = (providers: readonly ApiProvider[], role: ApiProvider["role"]) =>
  providers.filter((item) => item.role === role && item.enabled !== false && (item.isFake || item.status === "verified"));

/** Media accounts a job can use: any media source (Pexels or Apify) that is verified AND switched on. */
export const MEDIA_SOURCE_PROVIDERS: readonly string[] = ["pexels", "apify"];
export const mediaAccountsOf = (providers: readonly ApiProvider[]) => usableAccounts(providers, "visual").filter((item) => MEDIA_SOURCE_PROVIDERS.includes(item.provider));

/** Ids the user can pick right now, per reference field. */
export type CreationLists = { channelIds: string[]; contentIds: string[]; voiceIds: string[]; mediaIds: string[]; renderIds: string[] };

export function creationLists(channels: readonly PublicChannel[], providers: readonly ApiProvider[]): CreationLists {
  return {
    channelIds: channels.map((channel) => channel.id),
    contentIds: usableAccounts(providers, "content").map((account) => account.id),
    voiceIds: usableAccounts(providers, "tts").map((account) => account.id),
    mediaIds: mediaAccountsOf(providers).map((account) => account.id),
    renderIds: usableAccounts(providers, "render").map((account) => account.id),
  };
}

/** A child value cannot be trusted once its parent was cleared (a voice belongs to its voice account, a template to its render account). */
const DEPENDENTS: Partial<Record<JobNewFieldKey, JobNewFieldKey>> = { voiceAccountId: "voiceId", renderAccountId: "templateId" };

/**
 * System auto-pick (the behaviour before VE2E-124): an EMPTY channel / content account - and in Auto mode an empty voice, Pexels and
 * render account - takes the first available one. A field in `blocked` (its restored value was cleared) stays empty: the user must
 * choose it again.
 */
export function autofillSystemChoices(values: JobNewFormValues, lists: CreationLists, blocked: ReadonlySet<JobNewFieldKey>): JobNewFormValues {
  const next = { ...values };
  const pick = (key: "channelId" | "contentAccountId" | "voiceAccountId" | "mediaAccountId" | "renderAccountId", ids: readonly string[]) => {
    if (!next[key] && !blocked.has(key)) next[key] = ids[0] ?? "";
  };
  pick("channelId", lists.channelIds);
  pick("contentAccountId", lists.contentIds);
  if (next.entryMode === "auto") {
    pick("voiceAccountId", lists.voiceIds);
    pick("mediaAccountId", lists.mediaIds);
    pick("renderAccountId", lists.renderIds);
  }
  return next;
}

export type InitialFormState = {
  values: JobNewFormValues;
  /** Fields whose value came from the draft, the user's defaults or the URL (re-checked when their lists load). */
  restored: Set<JobNewFieldKey>;
  /** Restored values that were gone and got cleared (shown as a warning until the user picks again). */
  cleared: JobNewFieldKey[];
};

export function buildInitialFormState(input: {
  draft?: JobNewDraftPayload | null;
  preferences?: CreationPreferenceOptions | null;
  url?: { entryMode?: string | null; channelId?: string | null };
  lists: CreationLists;
}): InitialFormState {
  const { values, sources } = resolveInitialForm({ draft: input.draft ?? null, preferences: input.preferences ?? null, ...(input.url ? { url: input.url } : {}) });
  const restored = new Set((Object.keys(sources) as JobNewFieldKey[]).filter((key) => sources[key] !== "system"));
  const { lists } = input;
  const checked = clearUnavailableReferences(
    values,
    { channelId: lists.channelIds, contentAccountId: lists.contentIds, voiceAccountId: lists.voiceIds, mediaAccountId: lists.mediaIds, renderAccountId: lists.renderIds },
    restored,
  );
  const next = checked.values;
  const cleared = [...checked.cleared];
  for (const parent of checked.cleared) {
    const child = DEPENDENTS[parent];
    if (child && next[child]) {
      (next as Record<JobNewFieldKey, string>)[child] = "";
      if (!cleared.includes(child)) cleared.push(child);
    }
  }
  return { values: autofillSystemChoices(next, lists, new Set(cleared)), restored, cleared };
}

/** i18n key of the label of a field that can be cleared on restore. */
export const FIELD_LABEL_KEYS: Partial<Record<JobNewFieldKey, string>> = {
  channelId: "jobs.channel",
  contentAccountId: "jobs.contentAccount",
  voiceAccountId: "jobs.autoVoiceAccount",
  voiceId: "jobs.autoVoice",
  mediaAccountId: "jobs.autoMediaAccount",
  renderAccountId: "jobs.autoRenderAccount",
  templateId: "jobs.autoTemplate",
};
