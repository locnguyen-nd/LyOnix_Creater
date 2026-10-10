import type { JobNewFormValues } from "@lyonix/domain/creation-form";
import { composeNewsTopic, parseSelectedNews } from "@lyonix/domain/news";

type PickForm = Pick<JobNewFormValues, "topic" | "entryMode" | "selectedNews">;

/** VE2E-158: `/jobs/new?trend=<clusterId>&angle=<n>` - the Trend Radar topic (and the AI angle picked there) to start from. */
export function trendIntent(params: URLSearchParams): { clusterId: string; angleIndex: number | null } | null {
  const clusterId = params.get("trend")?.trim();
  if (!clusterId || !/^[\w-]{1,64}$/.test(clusterId)) return null;
  const rawAngle = params.get("angle");
  const angle = rawAngle !== null && /^\d$/.test(rawAngle) ? Number(rawAngle) : null;
  return { clusterId, angleIndex: angle };
}

/**
 * The form change for a Trend Radar topic: the composed topic (headline + angle + named sources), a `topic` source, Japanese script (the
 * channel's content is Japanese; the existing Gemini flow writes it after the user creates the job). A topic the user typed (not the one
 * made from a picked news item) is only replaced after a confirm - the same rule as "Dùng tin này".
 */
export function trendPick(form: PickForm, topic: string): { kind: "same" } | { kind: "apply"; needsConfirm: boolean; patch: Partial<JobNewFormValues> } {
  const typed = form.topic.trim();
  if (typed === topic.trim()) return { kind: "same" };
  const previous = parseSelectedNews(form.selectedNews);
  const fromNews = previous ? composeNewsTopic(previous).trim() : "";
  return {
    kind: "apply",
    needsConfirm: typed.length > 0 && typed !== fromNews,
    patch: { topic, selectedNews: "", language: "ja", ...(form.entryMode === "auto" ? { autoSourceType: "topic" as const } : { mode: "topic" as const }) },
  };
}
