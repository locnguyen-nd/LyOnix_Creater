import type { JobNewFormValues } from "@lyonix/domain/creation-form";
import { composeNewsTopic, parseSelectedNews, serializeSelectedNews, type NewsItem } from "@lyonix/domain/news";

type PickForm = Pick<JobNewFormValues, "topic" | "entryMode" | "selectedNews">;

/**
 * VE2E-96: "Dùng tin này". The topic becomes the item's headline + feed excerpt + named source, and the run gets a `topic` source (never
 * `article_url`: the article is not fetched). A topic the user typed themselves (not the one made from the previous item) needs a confirm.
 */
export function newsPick(form: PickForm, item: NewsItem): { kind: "same" } | { kind: "apply"; needsConfirm: boolean; patch: Partial<JobNewFormValues> } {
  const previous = parseSelectedNews(form.selectedNews);
  if (previous?.id === item.id) return { kind: "same" };
  const typed = form.topic.trim();
  const fromPrevious = previous ? composeNewsTopic(previous).trim() : "";
  return {
    kind: "apply",
    needsConfirm: typed.length > 0 && typed !== fromPrevious,
    patch: { selectedNews: serializeSelectedNews(item), topic: composeNewsTopic(item), ...(form.entryMode === "auto" ? { autoSourceType: "topic" as const } : { mode: "topic" as const }) },
  };
}

/** Unpicks the item; the topic is cleared too while it is still exactly the one made from the item (an edited topic is kept). */
export function newsUnpick(form: PickForm): Partial<JobNewFormValues> {
  const previous = parseSelectedNews(form.selectedNews);
  return previous && form.topic === composeNewsTopic(previous) ? { selectedNews: "", topic: "" } : { selectedNews: "" };
}
