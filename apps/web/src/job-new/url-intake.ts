import type { UrlIntakeRewrite, UrlIntakeSource, UrlIntakeStage } from "@lyonix/contracts";
import type { JobNewFormValues } from "@lyonix/domain/creation-form";
import { composeNewsTopic, serializeSelectedNews } from "@lyonix/domain/news";
import { composeSourceTopic } from "@lyonix/domain/transcript";

type IntakeForm = Pick<JobNewFormValues, "topic" | "entryMode" | "autoRawScript" | "existingScript">;

/** What the "Nguồn nội dung" panel shows: nothing yet, a step running, an error, or the analysed source with its rewrite. */
export type IntakeState =
  | { kind: "idle" }
  | { kind: "loading"; stage: UrlIntakeStage; sourceType: "tiktok" | "article" }
  | { kind: "error"; code: string; message: string; stage?: UrlIntakeStage; sourceType?: "tiktok" | "article" }
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

export type IntakeStepId = "reading" | "subtitles" | "speech" | "rewriting" | "done";
export type IntakeStepStatus = "done" | "current" | "pending" | "failed" | "skipped";
export type IntakeStep = { id: IntakeStepId; status: IntakeStepStatus };

/**
 * The progress line under "Nguồn nội dung": TikTok = reading > subtitles > (speech, only when there was no subtitle) > rewriting > done;
 * an article = reading > rewriting > done. Built from what really happened (stream stages, the result's method, the rewrite status).
 */
export function intakeProgress(state: IntakeState): IntakeStep[] {
  if (state.kind === "idle") return [];
  const tiktok = (state.kind === "ready" ? state.source.sourceType : state.sourceType) === "tiktok";
  const reached = (stage: UrlIntakeStage): IntakeStepId[] => (tiktok ? (stage === "speech" ? ["reading", "subtitles", "speech"] : stage === "subtitles" ? ["reading", "subtitles"] : ["reading"]) : ["reading"]);
  const tail = (ids: IntakeStepId[]): IntakeStepId[] => [...ids, ...((tiktok ? ["subtitles"] : []) as IntakeStepId[]).filter((id) => !ids.includes(id)), "rewriting", "done"];
  if (state.kind === "loading" || state.kind === "error") {
    const ids = reached(state.stage ?? "reading");
    const current = ids.at(-1)!;
    return tail(ids).map((id) => ({ id, status: id === current ? (state.kind === "error" ? "failed" : "current") : ids.includes(id) ? "done" : "pending" }));
  }
  const spoken = state.source.method === "speech_to_text";
  const read: IntakeStep[] = tiktok
    ? [{ id: "reading", status: "done" }, { id: "subtitles", status: spoken ? "skipped" : "done" }, ...(spoken ? [{ id: "speech" as const, status: "done" as const }] : [])]
    : [{ id: "reading", status: "done" }];
  const rewrite = state.rewrite.status;
  return [
    ...read,
    { id: "rewriting", status: rewrite === "pending" ? "current" : rewrite === "done" ? "done" : rewrite === "failed" ? "failed" : "skipped" },
    { id: "done", status: rewrite === "pending" ? "pending" : rewrite === "failed" ? "pending" : "done" },
  ];
}
