/**
 * VE2E-151: the target person of an Auto run - what the user typed on the create form ("Lee Felix / フィリックス (Stray Kids)") and
 * the selected news text - validated at submit and stored on `WorkflowRun.targetPerson`; read back by the runner for the script
 * prompt, the visualPlan lock, the media plan and the quality gate. Pure, no I/O.
 */
import { parseTargetPersonInput, TARGET_PERSON_MAX_CHARS, type TargetPersonInput } from "@lyonix/domain";

export const NEWS_CONTEXT_MAX_CHARS = 800;

export type TargetPersonIntake = { user: TargetPersonInput | null; newsText: string | null };

/** Submit-time validation: an empty field is "no target"; a non-empty one that holds no usable name (or is too long) is refused. */
export function parseTargetPersonIntake(targetPerson: unknown, newsContext: unknown): { ok: true; value: TargetPersonIntake | null } | { ok: false; message: string } {
  const typed = typeof targetPerson === "string" ? targetPerson.trim() : "";
  if (targetPerson !== undefined && targetPerson !== null && typeof targetPerson !== "string") return { ok: false, message: "targetPerson phải là chuỗi" };
  const user = typed ? parseTargetPersonInput(typed) : null;
  if (typed && !user) return { ok: false, message: `Người mục tiêu không hợp lệ (tên 2-80 ký tự, tổng tối đa ${TARGET_PERSON_MAX_CHARS} ký tự)` };
  const newsText = typeof newsContext === "string" ? newsContext.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, NEWS_CONTEXT_MAX_CHARS) : "";
  return { ok: true, value: user || newsText ? { user, newsText: newsText || null } : null };
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []);

/** The stored `WorkflowRun.targetPerson` (null / older runs / malformed JSON = no target). */
export function readTargetPersonIntake(raw: unknown): TargetPersonIntake {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const userRow = row?.user && typeof row.user === "object" && !Array.isArray(row.user) ? (row.user as Record<string, unknown>) : null;
  const main = typeof userRow?.main === "string" ? userRow.main.trim() : "";
  const user = main ? { main, aliases: stringList(userRow?.aliases), context: stringList(userRow?.context) } : null;
  const newsText = typeof row?.newsText === "string" && row.newsText.trim() ? row.newsText : null;
  return { user, newsText };
}
