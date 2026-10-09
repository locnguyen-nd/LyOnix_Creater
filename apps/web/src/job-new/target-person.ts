/**
 * VE2E-151: the create form's optional "target person" field - what is sent with an Auto submit, the direction line of a manual
 * (Studio) script, and the summary row. The server re-validates with the same parser (`parseTargetPersonInput`).
 */
import { parseTargetPersonInput, TARGET_PERSON_MAX_CHARS } from "@lyonix/domain/person-target";
import { parseSelectedNews } from "@lyonix/domain/news";
import type { JobNewFormValues } from "@lyonix/contracts";

export { TARGET_PERSON_MAX_CHARS };

/** Auto submit fields: the typed person (highest priority) and the selected news text (lets the server tag a model person as `news`). */
export function targetPersonSubmitFields(values: Pick<JobNewFormValues, "targetPerson" | "selectedNews">): { targetPerson?: string; newsContext?: string } {
  const typed = values.targetPerson.trim();
  const news = parseSelectedNews(values.selectedNews);
  const newsContext = news ? [news.title, news.excerpt].filter(Boolean).join(" ").slice(0, 800) : "";
  return { ...(typed ? { targetPerson: typed } : {}), ...(newsContext ? { newsContext } : {}) };
}

/** Summary row text ("Lee Felix · フィリックス (Stray Kids)"); `null` = nothing usable typed. */
export function targetPersonSummary(raw: string): string | null {
  const person = parseTargetPersonInput(raw);
  if (!person) return null;
  return `${[person.main, ...person.aliases].join(" · ")}${person.context.length ? ` (${person.context.join(", ")})` : ""}`;
}

/** Manual (Studio) scripts have no visualPlan lock: the chosen person is added to the direction the model receives. */
export function withTargetPersonDirection(direction: string, raw: string): string {
  const person = parseTargetPersonInput(raw);
  if (!person) return direction;
  const names = [person.main, ...person.aliases].join(" / ");
  return `${direction}\nTarget person (chosen by the user, highest priority): ${names}${person.context.length ? ` (${person.context.join(", ")})` : ""}. The whole script is about ${person.main}; mention other people only as direct context.`;
}
