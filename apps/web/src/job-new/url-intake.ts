import type { UrlIntakeRewrite, UrlIntakeSource, UrlIntakeStage } from "@lyonix/contracts";
import type { JobNewFormValues } from "@lyonix/domain/creation-form";
import { composeNewsTopic, serializeSelectedNews } from "@lyonix/domain/news";
import { composeSourceTopic } from "@lyonix/domain/transcript";

type IntakeForm = Pick<JobNewFormValues, "topic" | "entryMode" | "autoRawScript" | "existingScript">;

/** What the "Nguồn nội dung" panel shows: nothing yet, a step running, an error, or the analysed source with its rewrite. */
export type IntakeState =
  | { kind: "idle" }
  | { kind: "loading"; stage: UrlIntakeStage; sourceType: "tiktok" | "article"; spoken?: boolean }
  | { kind: "error"; code: string; message: string; stage?: UrlIntakeStage; sourceType?: "tiktok" | "article"; spoken?: boolean }
  | { kind: "ready"; source: UrlIntakeSource; rewrite: UrlIntakeRewrite | { status: "pending" }; applied: IntakeTarget | null };

export type IntakeTarget = "topic" | "script";

/** Values this panel last wrote into the form - overwriting those needs no confirm; anything else the user typed does. */
export type IntakeApplied = { topic?: string; script?: string };

/** The topic made from an analysed source: the rewritten script (else the source text) cut to the 400-character topic limit, source named. */
export function intakeTopic(source: UrlIntakeSource, rewrite: UrlIntakeRewrite | { status: "pending" }): string {
  if (rewrite.status === "done") return composeSourceTopic({ text: rewrite.script, sourceName: source.sourceName, sourceUrl: source.sourceUrl });
  if (source.newsItem) return composeNewsTopic(source.newsItem);
  return composeSourceTopic({ text: source.cleanedText, sourceName: source.sourceName, sourceUrl: source.sourceUrl });
}

const needsConfirm = (current: string, next: string, lastApplied: string | undefined) => current.trim().length > 0 && current !== next && current !== lastApplied;

/**
 * VE2E-96: what "Đưa vào chủ đề" / "Đưa vào kịch bản" change in the form - only fields the form already has:
 *  - topic: Auto `topic` source / Studio topic mode, the 400-character topic;
 *  - script (needs a rewritten script): Auto `raw_script` source / Studio "revise" mode (its required topic is filled only when empty).
 * `needsConfirm` when the target field holds text the user typed (not the one this panel wrote last).
 */
export function intakeApply(form: IntakeForm, source: UrlIntakeSource, rewrite: UrlIntakeRewrite | { status: "pending" }, target: IntakeTarget, lastApplied: IntakeApplied): { patch: Partial<JobNewFormValues>; needsConfirm: boolean; written: string } | null {
  const selectedNews = source.newsItem ? serializeSelectedNews(source.newsItem) : "";
  if (target === "topic") {
    const topic = intakeTopic(source, rewrite);
    return {
      patch: { topic, selectedNews, ...(form.entryMode === "auto" ? { autoSourceType: "topic" as const } : { mode: "topic" as const }) },
      needsConfirm: needsConfirm(form.topic, topic, lastApplied.topic),
      written: topic,
    };
  }
  if (rewrite.status !== "done") return null;
  const script = rewrite.script;
  if (form.entryMode === "auto") {
    return { patch: { autoSourceType: "raw_script", autoRawScript: script, selectedNews }, needsConfirm: needsConfirm(form.autoRawScript, script, lastApplied.script), written: script };
  }
  const topic = form.topic.trim() ? null : composeSourceTopic({ text: source.title || rewrite.hook || script, sourceName: source.sourceName, sourceUrl: source.sourceUrl });
  return { patch: { mode: "revise", existingScript: script, selectedNews, ...(topic ? { topic } : {}) }, needsConfirm: needsConfirm(form.existingScript, script, lastApplied.script), written: script };
}

export type IntakeStepId = "reading" | "subtitles" | "downloading" | "speech" | "cleaning" | "rewriting" | "done";
export type IntakeStepStatus = "done" | "current" | "pending" | "failed" | "skipped";
export type IntakeStep = { id: IntakeStepId; status: IntakeStepStatus };

/** Stages that mean the speech-to-text path started (the video had no usable subtitle). `spoken` in the state remembers it. */
export const SPOKEN_STAGES: ReadonlySet<UrlIntakeStage> = new Set(["no_subtitles", "downloading", "speech"]);

const SUBTITLE_PATH: IntakeStepId[] = ["reading", "subtitles", "cleaning", "rewriting", "done"];
const SPOKEN_PATH: IntakeStepId[] = ["reading", "subtitles", "downloading", "speech", "cleaning", "rewriting", "done"];
const ARTICLE_PATH: IntakeStepId[] = ["reading", "rewriting", "done"];

/** The step a server stage is working on: after "no subtitle" the next work is fetching the audio/video. */
const STAGE_STEP: Record<UrlIntakeStage, IntakeStepId> = { reading: "reading", subtitles: "subtitles", no_subtitles: "downloading", downloading: "downloading", speech: "speech", cleaning: "cleaning" };

/** The step an error code belongs to, when it is later than the last stage seen (e.g. speech-to-text not configured, found before any download). */
const ERROR_STEP: Partial<Record<string, IntakeStepId>> = {
  no_subtitle_no_media: "downloading",
  media_unavailable: "downloading",
  too_large: "downloading",
  ssrf_blocked: "downloading",
  stt_provider_not_configured: "speech",
  stt_failed: "speech",
  stt_timeout: "speech",
  stt_auth_invalid: "speech",
  stt_rate_limited: "speech",
  stt_quota_exhausted: "speech",
  stt_unsupported_media: "speech",
  transcript_empty: "cleaning",
};

/**
 * The progress line under "Nguồn nội dung", built from what really happened (stream stages, the result's method, the rewrite status):
 *  - TikTok with a subtitle: reading > subtitles > cleaning > rewriting > done;
 *  - TikTok without one: reading > subtitles (skipped: "no subtitle, switching to speech recognition") > downloading > speech > cleaning > rewriting > done;
 *  - an article: reading > rewriting > done.
 * An error marks the step it belongs to as failed; steps it jumped over are skipped.
 */
export function intakeProgress(state: IntakeState): IntakeStep[] {
  if (state.kind === "idle") return [];
  const tiktok = (state.kind === "ready" ? state.source.sourceType : state.sourceType) === "tiktok";
  if (state.kind === "loading" || state.kind === "error") {
    const stage = state.stage ?? "reading";
    const spoken = tiktok && (state.spoken === true || SPOKEN_STAGES.has(stage));
    const path = tiktok ? (spoken ? SPOKEN_PATH : SUBTITLE_PATH) : ARTICLE_PATH;
    const current = Math.max(0, path.indexOf(tiktok ? STAGE_STEP[stage] : "reading"));
    const errorStep = state.kind === "error" ? ERROR_STEP[state.code] : undefined;
    const failed = state.kind === "error" ? Math.max(current, errorStep && path.includes(errorStep) ? path.indexOf(errorStep) : current) : -1;
    return path.map((id, index) => {
      if (state.kind === "error" && index === failed) return { id, status: "failed" };
      if (state.kind === "loading" && index === current) return { id, status: "current" };
      if (index < current) return { id, status: id === "subtitles" && spoken ? "skipped" : "done" };
      if (state.kind === "error" && index < failed) return { id, status: "skipped" };
      return { id, status: "pending" };
    });
  }
  const spoken = state.source.method === "speech_to_text";
  const read: IntakeStep[] = !tiktok
    ? [{ id: "reading", status: "done" }]
    : spoken
      ? [{ id: "reading", status: "done" }, { id: "subtitles", status: "skipped" }, { id: "downloading", status: "done" }, { id: "speech", status: "done" }, { id: "cleaning", status: "done" }]
      : [{ id: "reading", status: "done" }, { id: "subtitles", status: "done" }, { id: "cleaning", status: "done" }];
  const rewrite = state.rewrite.status;
  return [
    ...read,
    { id: "rewriting", status: rewrite === "pending" ? "current" : rewrite === "done" ? "done" : rewrite === "failed" ? "failed" : "skipped" },
    { id: "done", status: rewrite === "pending" ? "pending" : rewrite === "failed" ? "pending" : "done" },
  ];
}
