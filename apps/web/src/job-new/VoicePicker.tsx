import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ElevenLabsVoiceSummaryResponse, UiLocale } from "@lyonix/contracts";
import { AlertTriangle, Check, Loader2, Pause, Play, Search, VolumeX } from "lucide-react";
import { SkeletonRows } from "../components/chrome";
import { fetchVoicePreview } from "../studio/timeline-api";
import { NO_VOICE_FILTERS, filterVoices, previewTarget, splitVoiceName, toVoiceOptions, voiceLanguages, type VoiceFilters, type VoiceOption } from "./voice-picker";
import { VoicePreviewController, type AudioLike, type PreviewStatus } from "./voice-preview";

/** One preview player per mounted picker; synthesized previews are cached per session across pickers (see voice-preview.ts). */
function usePreviewController(): VoicePreviewController {
  const [controller] = useState(() => new VoicePreviewController({
    createAudio: () => new Audio() as unknown as AudioLike,
    fetchTts: (target) => fetchVoicePreview(target.accountId ?? "", target.voiceId, target.language),
    toUrl: (blob) => URL.createObjectURL(blob),
  }));
  return controller;
}

const LANGUAGE_FILTERS = ["ja", "vi", "en"] as const;
const GENDER_FILTERS = ["male", "female"] as const;
const humanize = (value: string) => value.replace(/_/g, " ");

/** Small animated bars while a voice plays (static under reduced motion). */
function Equalizer() {
  return <span className="lyx-eq" aria-hidden><i /><i /><i /></span>;
}

/**
 * Create-video "Giọng đọc": search, filter chips, compact voice cards with Play / Pause and Chọn. Choosing only calls `onSelect`
 * (the form's voiceId, saved with the draft / defaults as before); previews use the form's voice account + the voice's id - the
 * same pair the render uses.
 */
export function VoicePicker({ voices, selectedId, onSelect, language, accountId, modelId, state = "ready", controller: injected }: {
  voices: readonly ElevenLabsVoiceSummaryResponse[];
  selectedId: string;
  onSelect: (voiceId: string) => void;
  /** The script language: the sample / provider preview is in this language when there is one. */
  language: UiLocale;
  /** The form's voice account (the one the render uses). */
  accountId: string;
  /** That account's TTS model (prefers the provider preview recorded with it). */
  modelId: string | null;
  state?: "loading" | "ready" | "failed";
  /** Tests inject a controller with a fake audio element. */
  controller?: VoicePreviewController;
}) {
  const { t, i18n } = useTranslation();
  const own = usePreviewController();
  const controller = injected ?? own;
  const preview = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [filters, setFilters] = useState<VoiceFilters>(NO_VOICE_FILTERS);
  const options = useMemo(() => toVoiceOptions(voices), [voices]);
  const shown = useMemo(() => filterVoices(options, filters), [options, filters]);
  const providers = useMemo(() => [...new Set(options.map((option) => option.provider))], [options]);
  const selected = options.find((option) => option.voiceId === selectedId) ?? null;

  // the chosen voice is brought into view inside the list once the voices arrive (the list scrolls, never the page)
  const listRef = useRef<HTMLUListElement | null>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list || !selectedId || scrolledFor.current === `${accountId}|${options.length}`) return;
    const card = list.querySelector<HTMLElement>(`[data-voice-id="${CSS.escape(selectedId)}"]`);
    if (!card) return;
    scrolledFor.current = `${accountId}|${options.length}`;
    list.scrollTop = Math.max(0, card.offsetTop - 8); // the list is the cards' offset parent (relative)
  }, [accountId, options.length, selectedId]);

  // a different account / script language / page: whatever plays stops
  useEffect(() => { controller.stop(); }, [controller, accountId, language]);
  useEffect(() => () => controller.stop(), [controller]);

  const noFilter = filters.language === "all" && filters.gender === "all" && filters.provider === "all";
  const chip = (key: string, active: boolean, label: string, onClick: () => void) => (
    <button key={key} type="button" aria-pressed={active} onClick={onClick} className="lyx-voice-chip inline-flex h-7 items-center rounded-full border border-lyx-border px-2.5 text-[12px] font-medium text-lyx-fg-muted hover:text-lyx-fg" data-testid={`voice-filter-${key}`}>
      {label}
    </button>
  );
  const errorText = (code: string) => (i18n.exists(`voicePicker.error.${code}`) ? t(`voicePicker.error.${code}`) : t("voicePicker.error.generic"));

  if (state === "loading") return <SkeletonRows label={t("voicePicker.loadingVoices")} count={3} rowClassName="h-14" />;
  if (state === "failed") return <p className="text-[12.5px] text-lyx-danger" role="alert" data-testid="voice-picker-failed">{t("voicePicker.loadFailed")}</p>;

  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid="voice-picker">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t("voicePicker.searchLabel")}</span>
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lyx-fg-subtle" aria-hidden />
          <input
            type="search"
            value={filters.query}
            maxLength={80}
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
            placeholder={t("voicePicker.searchPlaceholder")}
            className="h-9 w-full rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-muted pl-8 pr-3 text-[13px] placeholder:text-lyx-fg-subtle"
            data-testid="voice-search"
          />
        </label>
        <span className="shrink-0 text-[12px] text-lyx-fg-muted" data-testid="voice-count">{t("voicePicker.count", { shown: shown.length, total: options.length })}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("voicePicker.filtersLabel")}>
        {chip("all", noFilter, t("voicePicker.filter.all"), () => setFilters((current) => ({ ...current, language: "all", gender: "all", provider: "all" })))}
        {LANGUAGE_FILTERS.map((code) => chip(code, filters.language === code, t(`voicePicker.filter.${code}`), () => setFilters((current) => ({ ...current, language: current.language === code ? "all" : code }))))}
        <span className="mx-0.5 h-4 w-px bg-lyx-border" aria-hidden />
        {GENDER_FILTERS.map((gender) => chip(gender, filters.gender === gender, t(`voicePicker.filter.${gender}`), () => setFilters((current) => ({ ...current, gender: current.gender === gender ? "all" : gender }))))}
        {providers.length > 1 ? providers.map((provider) => chip(provider, filters.provider === provider, t(`voicePicker.provider.${provider}`), () => setFilters((current) => ({ ...current, provider: current.provider === provider ? "all" : provider })))) : null}
      </div>

      {selected ? (
        <p className="text-[12px] text-lyx-fg-muted" data-testid="voice-selected-line">
          {t("voicePicker.selectedLine", { name: splitVoiceName(selected.name).title })}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <div className="lyx-fade rounded-lg border border-dashed border-lyx-border px-3 py-6 text-center text-[12.5px] text-lyx-fg-muted" data-testid="voice-empty">
          <p className="font-medium text-lyx-fg">{t("voicePicker.empty")}</p>
          <p className="mt-1">{t("voicePicker.emptyHint")}</p>
        </div>
      ) : (
        <ul ref={listRef} className="lyx-list relative grid max-h-[400px] gap-2 overflow-y-auto overflow-x-hidden overscroll-contain px-1.5 pb-1 pt-2 sm:grid-cols-2" data-testid="voice-list">
          {shown.map((voice) => (
            <VoiceCard
              key={voice.voiceId}
              voice={voice}
              selected={voice.voiceId === selectedId}
              status={preview.activeId === voice.voiceId ? preview.status : preview.errors[voice.voiceId] ? "error" : "idle"}
              error={preview.errors[voice.voiceId] ? errorText(preview.errors[voice.voiceId]!) : null}
              target={previewTarget({ voiceAccountId: accountId, language }, voice, modelId)}
              onToggle={(target) => void controller.toggle(target)}
              onSelect={() => onSelect(voice.voiceId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function VoiceCard({ voice, selected, status, error, target, onToggle, onSelect }: {
  voice: VoiceOption;
  selected: boolean;
  status: PreviewStatus;
  error: string | null;
  target: ReturnType<typeof previewTarget>;
  onToggle: (target: ReturnType<typeof previewTarget>) => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const { title, tagline } = splitVoiceName(voice.name);
  const languages = voiceLanguages(voice);
  const unavailable = status === "unavailable" || (!target.previewUrl && !target.accountId);
  const playLabel = status === "playing" ? t("voicePicker.pause") : status === "loading" ? t("voicePicker.loading") : unavailable ? t("voicePicker.unavailable") : t("voicePicker.play");
  const styleTags = [voice.useCase ? humanize(voice.useCase) : null, voice.descriptive].filter((tag): tag is string => Boolean(tag)).slice(0, 2);
  return (
    <li
      className="lyx-voice-card relative flex min-w-0 items-start gap-2.5 rounded-lg border border-lyx-border bg-lyx-bg p-2.5"
      data-testid="voice-card"
      data-voice-id={voice.voiceId}
      data-selected={selected ? "true" : "false"}
      data-preview={unavailable ? "unavailable" : status}
    >
      <button
        type="button"
        className="lyx-voice-play mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
        onClick={() => onToggle(target)}
        disabled={unavailable}
        aria-label={`${playLabel}: ${title}`}
        aria-pressed={status === "playing"}
        title={playLabel}
        data-testid="voice-play"
      >
        {status === "loading" ? <Loader2 size={15} className="animate-spin" aria-hidden />
          : status === "playing" ? <Pause size={15} fill="currentColor" aria-hidden />
          : unavailable ? <VolumeX size={15} aria-hidden />
          : status === "error" ? <AlertTriangle size={15} aria-hidden />
          : <Play size={15} fill="currentColor" className="translate-x-px" aria-hidden />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold leading-5">
          <span className="truncate" title={voice.name}>{title}</span>
          {status === "playing" ? <Equalizer /> : null}
        </p>
        {tagline ? <p className="truncate text-[11.5px] leading-4 text-lyx-fg-muted" title={tagline}>{tagline}</p> : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10.5px] font-medium">
          {languages.length ? <span className="rounded bg-lyx-neutral-bg px-1.5 py-0.5 uppercase text-lyx-fg-muted" title={languages.join(", ")}>{languages.slice(0, 3).join(" · ")}{languages.length > 3 ? ` +${languages.length - 3}` : ""}</span> : null}
          {voice.gender ? <span className="rounded bg-lyx-neutral-bg px-1.5 py-0.5 text-lyx-fg-muted">{t(`voicePicker.gender.${voice.gender.toLowerCase()}`, { defaultValue: voice.gender })}</span> : null}
          {styleTags.map((tag) => <span key={tag} className="rounded bg-lyx-neutral-bg px-1.5 py-0.5 capitalize text-lyx-fg-muted">{tag}</span>)}
          <span className="lyx-accent-chip rounded px-1.5 py-0.5">{t(`voicePicker.provider.${voice.provider}`)}</span>
          {!target.previewUrl && target.accountId ? <span className="rounded bg-lyx-warn-bg px-1.5 py-0.5 text-lyx-warn" title={t("voicePicker.ttsPreviewHint")}>TTS</span> : null}
        </div>
        {error ? <p className="lyx-fade mt-1 text-[11px] leading-4 text-lyx-danger" role="alert" data-testid="voice-error">{error}</p> : null}
        {status === "unavailable" ? <p className="lyx-fade mt-1 text-[11px] leading-4 text-lyx-fg-muted">{t("voicePicker.unavailableHint")}</p> : null}
      </div>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`lyx-voice-choose inline-flex h-8 shrink-0 items-center gap-1 rounded-[var(--lyx-radius)] border px-2.5 text-[12px] font-semibold ${selected ? "" : "border-lyx-border text-lyx-fg hover:border-lyx-strong"}`}
        data-testid="voice-choose"
      >
        {selected ? <Check size={13} strokeWidth={3} aria-hidden /> : null}
        {selected ? t("voicePicker.chosen") : t("voicePicker.choose")}
      </button>
      {selected ? (
        <span className="lyx-anim-pop lyx-voice-check absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-white shadow-sm" aria-hidden>
          <Check size={12} strokeWidth={3} />
        </span>
      ) : null}
    </li>
  );
}
