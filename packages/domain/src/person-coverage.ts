/**
 * Strict person media mode: a video about ONE specific person (typed on the create form, or a person the script is clearly centered
 * on) must SHOW that person. Pure, browser-safe.
 *
 * - `strictPersonModeFor`: on for a typed target person, or a news / model person the title names (and the first scene, or >= 30% of
 *   the scenes, names too);
 *   `STRICT_PERSON_MEDIA_MODE=1|0` forces it on / off (default `auto`).
 * - `personMediaRoleOf`: the role of a scene's source - `person_primary` (vision-verified or a strong metadata match),
 *   `person_support` (weaker evidence of the person), `context` (directly related context: the person's team / group / event),
 *   `generic` (stock / backdrop / placeholder).
 * - `assessPersonCoveragePreflight`: the pre-render coverage rules - scene 1 shows the person, >= 2 of the first 3 scenes, >= 60% of
 *   all scenes, never 2 non-person scenes in a row, context / generic never the majority. A failure blocks the render
 *   (`PERSON_MEDIA_INSUFFICIENT`) instead of filling the timeline with generic footage.
 */
import { assessScriptPersonFocus, type PersonTarget } from "./person-target.js";

export const PERSON_MEDIA_ROLES = ["person_primary", "person_support", "context", "generic"] as const;
export type PersonMediaRole = (typeof PERSON_MEDIA_ROLES)[number];

/** Share of scenes that must show the person in strict mode (env `STRICT_PERSON_MIN_COVERAGE`, 0.6..0.9). */
export const STRICT_PERSON_MIN_COVERAGE = 0.6;
/** At least this many of the first 3 scenes show the person. */
export const STRICT_PERSON_FIRST_THREE_MIN = 2;
/** At most this many non-person (context / generic) scenes in a row. */
export const STRICT_PERSON_MAX_CONSECUTIVE_NON_PERSON = 1;
/** Metadata evidence from which a named source counts as primary (a vision `match` always does). */
export const PERSON_PRIMARY_MIN_CONFIDENCE = 0.6;
/** A news / model person named by the title is a high-confidence target when the first scene or this share of scenes names it too. */
export const STRICT_PERSON_SCRIPT_MIN_COVERAGE = 0.3;

export const strictPersonMinCoverageFromEnv = (env: Record<string, string | undefined> = {}): number => {
  const value = Number(env.STRICT_PERSON_MIN_COVERAGE);
  return env.STRICT_PERSON_MIN_COVERAGE !== undefined && Number.isFinite(value) && value >= 0.6 && value <= 0.9 ? value : STRICT_PERSON_MIN_COVERAGE;
};

/** Strict mode for a person target: typed by the user, or a news / model person the title names and the script stays on. */
export function strictPersonModeFor(
  target: PersonTarget,
  script: { title?: string | null; scenes: ReadonlyArray<{ sceneId: string; narration: string; screenText?: string | null }> },
  env: Record<string, string | undefined> = {},
): boolean {
  const forced = (env.STRICT_PERSON_MEDIA_MODE ?? "").trim().toLowerCase();
  if (/^(1|true|on|yes)$/.test(forced)) return true;
  if (/^(0|false|off|no)$/.test(forced)) return false;
  if (target.source === "user") return true;
  // High confidence: the TITLE names the person, and the first scene names them too or the script keeps naming them (ja scripts often
  // drop the subject after the hook, so the coverage alone would miss a video that is plainly about one person).
  const titleNames = Boolean(script.title) && assessScriptPersonFocus(target, { title: script.title ?? null, scenes: [] }).hookNamesTarget;
  if (!titleNames) return false;
  const focus = assessScriptPersonFocus(target, { scenes: script.scenes });
  return focus.hookNamesTarget || focus.coverage >= STRICT_PERSON_SCRIPT_MIN_COVERAGE;
}

export type PersonEvidenceLike = {
  match: "verified" | "metadata" | "generic";
  identityConfidence: number;
  tier?: string | undefined;
  flags?: readonly string[] | undefined;
} | null | undefined;

/** The role a scene's source plays for the person (see file header). No evidence = `generic`. */
export function personMediaRoleOf(evidence: PersonEvidenceLike): PersonMediaRole {
  if (!evidence) return "generic";
  if (evidence.match === "verified") return "person_primary";
  if (evidence.match === "metadata") {
    if (evidence.flags?.includes("frame_identity_uncertain") || evidence.flags?.includes("identity_uncertain")) return "person_support";
    return evidence.tier === "strong_metadata" || evidence.identityConfidence >= PERSON_PRIMARY_MIN_CONFIDENCE ? "person_primary" : "person_support";
  }
  return evidence.tier === "context" || evidence.flags?.includes("context") ? "context" : "generic";
}

export const isPersonRole = (role: PersonMediaRole): boolean => role === "person_primary" || role === "person_support";

export type PersonCoverageScene = {
  sceneId: string;
  targetPerson: string;
  mediaRole: PersonMediaRole;
  identityConfidence: number;
  verificationMethod: "vision" | "metadata" | "none";
};

export type PersonCoverageReason = "first_scene_not_person" | "first_three_scenes" | "coverage_below_threshold" | "consecutive_non_person" | "generic_majority";

export type PersonCoverageReport = {
  totalScenes: number;
  /** Scenes whose source is verified / strongly matched (`person_primary`). */
  exactPersonSceneCount: number;
  /** Scenes showing the person at all (primary + support). */
  personSceneCount: number;
  contextSceneCount: number;
  genericSceneCount: number;
  /** personSceneCount / totalScenes (0..1). */
  personCoverageRatio: number;
  /** Longest run of non-person (context / generic) scenes. */
  consecutiveGenericMax: number;
  minCoverage: number;
  ok: boolean;
  reasons: PersonCoverageReason[];
  scenes: PersonCoverageScene[];
};

/** The strict pre-render coverage check (see file header). Scenes in timeline order. */
export function assessPersonCoveragePreflight(scenes: readonly PersonCoverageScene[], minCoverage = STRICT_PERSON_MIN_COVERAGE): PersonCoverageReport {
  const total = scenes.length;
  const person = scenes.filter((scene) => isPersonRole(scene.mediaRole));
  let run = 0;
  let longest = 0;
  for (const scene of scenes) {
    run = isPersonRole(scene.mediaRole) ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  const ratio = total > 0 ? Math.round((person.length / total) * 1000) / 1000 : 0;
  const nonPerson = total - person.length;
  const reasons: PersonCoverageReason[] = [];
  if (!scenes[0] || !isPersonRole(scenes[0].mediaRole)) reasons.push("first_scene_not_person");
  const firstThree = scenes.slice(0, 3);
  if (firstThree.filter((scene) => isPersonRole(scene.mediaRole)).length < Math.min(STRICT_PERSON_FIRST_THREE_MIN, firstThree.length)) reasons.push("first_three_scenes");
  if (ratio < minCoverage) reasons.push("coverage_below_threshold");
  if (longest > STRICT_PERSON_MAX_CONSECUTIVE_NON_PERSON) reasons.push("consecutive_non_person");
  if (total > 0 && nonPerson * 2 > total) reasons.push("generic_majority");
  return {
    totalScenes: total,
    exactPersonSceneCount: scenes.filter((scene) => scene.mediaRole === "person_primary").length,
    personSceneCount: person.length,
    contextSceneCount: scenes.filter((scene) => scene.mediaRole === "context").length,
    genericSceneCount: scenes.filter((scene) => scene.mediaRole === "generic").length,
    personCoverageRatio: ratio,
    consecutiveGenericMax: longest,
    minCoverage,
    ok: reasons.length === 0,
    reasons,
    scenes: scenes.map((scene) => ({ ...scene })),
  };
}

/** "Đúng người: 8/12 cảnh (67%) · Cảnh bối cảnh: 4/12" (the same numbers the job page shows). */
export const personCoverageSummary = (report: Pick<PersonCoverageReport, "personSceneCount" | "totalScenes" | "personCoverageRatio" | "contextSceneCount" | "genericSceneCount">): string =>
  `Đúng người: ${report.personSceneCount}/${report.totalScenes} cảnh (${Math.round(report.personCoverageRatio * 100)}%) · Cảnh bối cảnh: ${report.contextSceneCount + report.genericSceneCount}/${report.totalScenes}`;

export const PERSON_MEDIA_INSUFFICIENT_MESSAGE = "Không đủ hình/video đúng người mục tiêu để dựng video.";
