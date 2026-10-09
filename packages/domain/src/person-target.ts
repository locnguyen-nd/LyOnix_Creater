/**
 * Person-focused sourcing: pure helpers used ONLY when the video's main subject is one person (`videoSubject.kind === "person"`).
 * Every other video keeps the subject rules of VE2E-88/89 unchanged - nothing here runs for a team, a place or an event.
 *
 * - `personTargetOf`: the target entity: name variants split into strong (full name: one hit = the person) and weak (given name,
 *   family name, nickname: needs a context term such as the group/team when the target has one, to tell same-name people apart).
 * - `matchPersonIdentity`: candidate metadata (caption / hashtags / title / alt text / author) vs the target.
 * - `personMetadataFlags`: cheap metadata hints - news / publisher post, quote / meme / text card, group, close-up / fancam, slideshow.
 * - `scorePersonCandidate`: tiers verified (vision) > strong metadata > single-person portrait > group > generic > rejected, and inside a
 *   tier clean (little text, no logo) > framing > motion. Metadata / hashtags never conclude the identity on their own: only the vision
 *   identity verdict (same moderation call, `VisionIdentityFindings`) reaches the `verified` tier; without vision the metadata ranking runs.
 * - `parseTargetPersonInput` / `resolveTargetPerson`: the target by precedence user-typed > selected news > model-extracted.
 * - `assessScriptPersonFocus` / `assessPersonMediaCoverage`: script and job-level checks for the quality gate.
 *
 * Browser-safe (imported through `media-ranking.ts` by apps/web): no node imports.
 */
import type { VisionIdentityFindings, VisionShotFindings } from "./media-candidate.js";

export const SUBJECT_KINDS = ["person", "group", "team", "place", "event", "other"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const parseSubjectKind = (value: unknown): SubjectKind | null => {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (SUBJECT_KINDS as readonly string[]).includes(text) ? (text as SubjectKind) : null;
};

export type PersonTarget = {
  name: string;
  /** Unambiguous spellings (multi-part full name, kanji / hangul full name, reversed Latin order): one hit identifies the person. */
  strongNames: string[];
  /** Single-part spellings (given name, family name, nickname, stage name): a hit needs a context term when `context` is not empty. */
  weakNames: string[];
  /** Disambiguating context (group, team, occupation) - the subject's `mustInclude`. */
  context: string[];
  exclude: string[];
  /** Other people the script mentions (context only): media naming them and not the target shows someone else. */
  others: string[];
  /** Who named the target: the user (typed on the create form), the selected news, or the model. */
  source: TargetPersonSource;
};

export type PersonSubjectInput =
  | { kind?: unknown; main?: unknown; aliases?: unknown; mustInclude?: unknown; mustExclude?: unknown; otherPeople?: unknown; source?: unknown }
  | null
  | undefined;

const MAX_NAMES = 16;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []);

const JA_HONORIFIC = /(?:さん|さま|様|氏|選手|くん|君|ちゃん|先生|監督|容疑者|被告)$/u;
const KO_HONORIFIC = /(?:씨|님)$/u;
const EN_TITLE = /^(?:mr|mrs|ms|miss|dr|sir|prof)\.?\s+/i;
/** Separators inside one name: spaces, katakana middle dot (full/half width after NFKC), interpunct, double hyphen used in katakana names. */
const NAME_SEPARATORS = /[\s・·=＝]+/u;
const KANJI = /[㐀-鿿]/u;
const HANGUL = /[가-힯]/u;
const LATIN = /[A-Za-z]/;

/** Honorifics and titles off a name ("大谷翔平選手" -> "大谷翔平", "Mr. Kim" -> "Kim"); never shortens a name below 2 characters. */
export function stripHonorifics(name: string): string {
  const text = name.normalize("NFKC").trim();
  const stripped = text.replace(EN_TITLE, "").replace(JA_HONORIFIC, "").replace(KO_HONORIFIC, "").trim();
  return [...stripped].length >= 2 ? stripped : text;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const pushUnique = (list: string[], value: string) => {
  if (value && !list.some((existing) => sameName(existing, value))) list.push(value);
};

/** A single-part name is strong only as a kanji / hangul full name (3+ characters, e.g. 大谷翔平, 이용복); kana and Latin single words are weak. */
const strongSinglePart = (part: string): boolean => [...part].length >= 3 && (KANJI.test(part) || HANGUL.test(part)) && !LATIN.test(part);

/** Strong and weak spellings of one name: the full name (and the reversed order of a Latin 2-3 part name) are strong, each part is weak. */
export function personNameVariants(rawName: string): { strong: string[]; weak: string[] } {
  const name = stripHonorifics(rawName);
  const parts = name.split(NAME_SEPARATORS).filter(Boolean);
  const strong: string[] = [];
  const weak: string[] = [];
  if (parts.length === 0) return { strong, weak };
  if (parts.length === 1) {
    (strongSinglePart(parts[0]!) ? strong : weak).push(parts[0]!);
    return { strong, weak };
  }
  pushUnique(strong, parts.join(" "));
  if (parts.every((part) => LATIN.test(part)) && parts.length <= 3) pushUnique(strong, [...parts].reverse().join(" "));
  for (const part of parts) if ([...part].length >= 2) pushUnique(weak, part);
  return { strong, weak };
}

/** The target entity of a `kind: "person"` subject; `null` for any other subject (person-focused rules then never apply). */
export function personTargetOf(subject: PersonSubjectInput): PersonTarget | null {
  if (!subject || parseSubjectKind(subject.kind) !== "person") return null;
  const main = typeof subject.main === "string" ? subject.main.trim() : "";
  if (!main) return null;
  const strongNames: string[] = [];
  const weakNames: string[] = [];
  for (const name of [main, ...strings(subject.aliases)]) {
    const variants = personNameVariants(name);
    for (const value of variants.strong) pushUnique(strongNames, value);
    for (const value of variants.weak) pushUnique(weakNames, value);
  }
  const weak = weakNames.filter((value) => !strongNames.some((strongName) => sameName(strongName, value)));
  const others: string[] = [];
  for (const name of strings(subject.otherPeople)) {
    const cleaned = stripHonorifics(name);
    if (!strongNames.some((value) => sameName(value, cleaned)) && !weak.some((value) => sameName(value, cleaned))) pushUnique(others, cleaned);
  }
  return {
    name: stripHonorifics(main),
    strongNames: strongNames.slice(0, MAX_NAMES),
    weakNames: weak.slice(0, MAX_NAMES),
    context: strings(subject.mustInclude).slice(0, MAX_NAMES),
    exclude: strings(subject.mustExclude).slice(0, MAX_NAMES),
    others: others.slice(0, MAX_NAMES),
    source: parseTargetPersonSource(subject.source) ?? "model",
  };
}

// --- target person: user input > selected news > model ---------------------------------------------------------------------

export const TARGET_PERSON_SOURCES = ["user", "news", "model"] as const;
export type TargetPersonSource = (typeof TARGET_PERSON_SOURCES)[number];
export const parseTargetPersonSource = (value: unknown): TargetPersonSource | null =>
  typeof value === "string" && (TARGET_PERSON_SOURCES as readonly string[]).includes(value) ? (value as TargetPersonSource) : null;

/** A person typed by the user: names / aliases (JP, romaji, nickname...) and the disambiguating group / team / occupation. */
export type TargetPersonInput = { main: string; aliases: string[]; context: string[] };
export const TARGET_PERSON_MAX_CHARS = 200;
const LIST_SEPARATORS = /[/,、;|\n]+/u;
const BRACKETS = /[(\[【「『]([^)\]】」』]*)[)\]】」』]/gu;

/**
 * Parses the create-form field: names separated by "/", ",", "、", ";", "|" or new lines (the first is the main name), the group / team /
 * occupation in brackets: `Lee Felix / フィリックス / 이용복 (Stray Kids)`. Full-width forms are NFKC-normalised first. `null` = nothing usable.
 */
export function parseTargetPersonInput(raw: unknown): TargetPersonInput | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.normalize("NFKC").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ").trim();
  if (!text || [...text].length > TARGET_PERSON_MAX_CHARS) return null;
  const context: string[] = [];
  const unbracketed = text.replace(BRACKETS, (_whole, inner: string) => {
    for (const part of inner.split(LIST_SEPARATORS)) {
      const term = part.replace(/\s+/g, " ").trim();
      if ([...term].length >= 2) pushUnique(context, term);
    }
    return " / ";
  });
  const names: string[] = [];
  for (const part of unbracketed.split(LIST_SEPARATORS)) {
    const name = stripHonorifics(part.replace(/\s+/g, " ").trim());
    if ([...name].length >= 2 && [...name].length <= 80) pushUnique(names, name);
  }
  if (names.length === 0) return null;
  return { main: names[0]!, aliases: names.slice(1, 8), context: context.slice(0, 6) };
}

/** A resolved person subject (same shape as `videoSubject`), with who named it. */
export type ResolvedTargetPerson = {
  kind: "person";
  main: string;
  aliases: string[];
  mustInclude: string[];
  mustExclude: string[];
  otherPeople: string[];
  source: TargetPersonSource;
};

/**
 * The video's target person by precedence: the person the user typed > the person of the selected news (the model's person when one
 * of its names appears in the news headline / excerpt) > the person the model extracted. The user's person keeps the model's extra
 * spellings / context only when the model named the SAME person; a different model subject becomes one of `otherPeople`.
 * `null` = no person target (the subject is a team, a place, an event, or none).
 */
export function resolveTargetPerson(input: { user?: TargetPersonInput | null; newsText?: string | null; model?: PersonSubjectInput }): ResolvedTargetPerson | null {
  const model = input.model && typeof input.model === "object" ? input.model : null;
  const modelMain = typeof model?.main === "string" ? model.main.trim() : "";
  const modelIsPerson = parseSubjectKind(model?.kind) === "person" && Boolean(modelMain);
  if (input.user) {
    const user = input.user;
    const userTarget = personTargetOf({ kind: "person", main: user.main, aliases: user.aliases, mustInclude: user.context })!;
    const modelNames = modelIsPerson ? [modelMain, ...strings(model?.aliases)] : [];
    const same = modelNames.some((name) => {
      const level = matchPersonIdentity(userTarget, { text: name }).level;
      return level !== "none" && level !== "author";
    });
    const aliases = [...user.aliases];
    const mustInclude = [...user.context];
    if (same) {
      for (const name of modelNames) if (!sameName(name, user.main)) pushUnique(aliases, name);
      for (const term of strings(model?.mustInclude)) pushUnique(mustInclude, term);
    }
    const userNames = [user.main, ...aliases];
    const otherPeople: string[] = [];
    for (const name of [...(modelIsPerson && !same ? [modelMain] : []), ...strings(model?.otherPeople)]) {
      if (!userNames.some((own) => sameName(own, name))) pushUnique(otherPeople, name);
    }
    return { kind: "person", main: user.main, aliases: aliases.slice(0, 8), mustInclude: mustInclude.slice(0, 8), mustExclude: same ? strings(model?.mustExclude).slice(0, 8) : [], otherPeople: otherPeople.slice(0, 8), source: "user" };
  }
  if (!modelIsPerson) return null;
  const modelTarget = personTargetOf({ ...model, kind: "person" })!;
  const level = input.newsText ? matchPersonIdentity(modelTarget, { text: input.newsText }).level : "none";
  const fromNews = level === "strong" || level === "context" || level === "weak";
  return {
    kind: "person",
    main: modelMain,
    aliases: strings(model?.aliases),
    mustInclude: strings(model?.mustInclude),
    mustExclude: strings(model?.mustExclude),
    otherPeople: strings(model?.otherPeople),
    // `user` comes only from the user's own input (above), never from a stored / model-written subject.
    source: fromNews ? "news" : "model",
  };
}

/**
 * Text folded for name matching: NFKC, lower case, diacritics off, and romaji long vowels collapsed on both sides so "Ohtani",
 * "Otani" and "Ōtani" match ("ou"/"oo"/"oh"+consonant -> "o", "uu" -> "u").
 */
const plainFold = (text: string): string => text.normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFKC").toLowerCase();
const fold = (text: string): string =>
  plainFold(text)
    .replace(/oh(?=[^aeiou]|$)/g, "o")
    .replace(/o[ou]/g, "o")
    .replace(/uu/g, "u");
const compact = (text: string): string => fold(text).replace(/[^\p{L}\p{N}]+/gu, "");
const spaced = (text: string): string => ` ${fold(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

const LATIN_ONLY = /^[a-z0-9 ]+$/;

/** Whether `name` occurs in `text`: a Latin weak (one-word) name only as a whole word, everything else on the compacted text (hashtags glue words). */
const nameIn = (text: string, name: string, wholeWord: boolean): boolean => {
  const needle = compact(name);
  if (needle.length < 2) return false;
  const folded = fold(name).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (wholeWord && LATIN_ONLY.test(folded)) return spaced(text).includes(` ${folded} `);
  return compact(text).includes(needle);
};

const anyIn = (text: string, names: readonly string[], wholeWord: boolean) => names.some((name) => nameIn(text, name, wholeWord));

export type PersonIdentityLevel = "strong" | "context" | "weak" | "author" | "none";
export type PersonIdentity = { level: PersonIdentityLevel; score: number; namesOthers: boolean };

/** strong = full name; context = a short name + the group/team/occupation; weak = a short name alone; author = only the uploader's name. */
export const PERSON_IDENTITY_SCORES = { strong: 1, context: 0.85, weakNoContext: 0.7, weakMissingContext: 0.45, author: 0.4, none: 0 } as const;

export type PersonMeta = { text?: string | null | undefined; author?: string | null | undefined };

/** How strongly the candidate's own metadata names the target. A short name of a target that has a context term needs that term (same-name people). */
export function matchPersonIdentity(target: PersonTarget, meta: PersonMeta): PersonIdentity {
  const text = meta.text ?? "";
  const author = meta.author ?? "";
  const othersNamed = text ? anyIn(text, target.others, true) : false;
  const result = (level: PersonIdentityLevel, score: number): PersonIdentity => ({ level, score, namesOthers: othersNamed && level !== "strong" });
  if (text && anyIn(text, target.strongNames, false)) return result("strong", PERSON_IDENTITY_SCORES.strong);
  if (text && anyIn(text, target.weakNames, true)) {
    if (target.context.length === 0) return result("weak", PERSON_IDENTITY_SCORES.weakNoContext);
    const hasContext = anyIn(`${text} ${author}`, target.context, false);
    return hasContext ? result("context", PERSON_IDENTITY_SCORES.context) : result("weak", PERSON_IDENTITY_SCORES.weakMissingContext);
  }
  if (author && (anyIn(author, target.strongNames, false) || anyIn(author, target.weakNames, false))) return result("author", PERSON_IDENTITY_SCORES.author);
  return result("none", PERSON_IDENTITY_SCORES.none);
}

export type PersonMediaFlag = "news" | "text_card" | "group" | "close_up" | "slideshow" | "other_person" | "generic" | "impostor_risk" | "identity_uncertain" | "wrong_person";

/** News / publisher posts: usually a headline card or lower-third over the footage. A press conference itself is NOT flagged (real footage of the person). */
const NEWS = /(?:^|[^a-z])(?:news|breaking|headlines?|tin tuc|bao chi)(?:[^a-z]|$)|ニュース|速報|報道|新聞|記事/u;
/** Text-first media: quote / meme / ranking / tweet screenshot / lyric cards. */
const TEXT_CARD = /(?:^|[^a-z])(?:quotes?|memes?|ranking|tweet|screenshot|lyrics?|top ?\d+)(?:[^a-z]|$)|名言|格言|ミーム|まとめ|ランキング|ツイート|スクショ|歌詞/u;
const GROUP = /(?:^|[^a-z])(?:members|group photo|ensemble|ot\d+)(?:[^a-z]|$)|メンバー|全員|集合|ユニット|×/u;
const CLOSE_UP = /(?:^|[^a-z])(?:fancam|focus ?cam|close ?up|portrait|selca|selfie|solo)(?:[^a-z]|$)|直カム|個人カム|フォーカス|セルカ|自撮り|ソロ|アップ|ビジュ/u;
const SLIDESHOW = /(?:^|[^a-z])(?:slideshow|photo ?dump)(?:[^a-z]|$)|スライドショー|画像まとめ|写真まとめ/u;

/** Metadata hints of one candidate (caption / hashtags / title / alt text; the author for the news-publisher check). */
export function personMetadataFlags(target: PersonTarget, meta: PersonMeta): PersonMediaFlag[] {
  const text = plainFold(meta.text ?? "");
  const author = plainFold(meta.author ?? "");
  const flags: PersonMediaFlag[] = [];
  if (NEWS.test(text) || NEWS.test(author)) flags.push("news");
  if (TEXT_CARD.test(text)) flags.push("text_card");
  if (GROUP.test(text)) flags.push("group");
  if (CLOSE_UP.test(text)) flags.push("close_up");
  if (SLIDESHOW.test(text)) flags.push("slideshow");
  if (meta.text && anyIn(meta.text, target.others, true) && !anyIn(meta.text, target.strongNames, false)) flags.push("other_person");
  return flags;
}

/** Weights of the within-tier quality (the tier decides the order first, see {@link PERSON_TIER_BANDS}). */
export const PERSON_SCORE_WEIGHTS = { cleanliness: 0.35, framing: 0.2, motion: 0.15, base: 0.3 } as const;

/**
 * Person-mode tiers, best first:
 *  verified        - the vision identity check confirmed the target person (one person in frame),
 *  strong_metadata - the full name in the candidate's own metadata, not contradicted or doubted by vision,
 *  single_portrait - weaker evidence of ONE person (short name + group, short name, uploader, or a full name vision could not confirm),
 *  group           - names the person but shows several people (group photo, members post, another person tagged) or is a news post,
 *  generic         - does not name the person (stock / backdrop context),
 *  rejected        - another person (vision), a news / quote card, nobody in a frame that claims the person, a stranger's close-up.
 */
export const PERSON_TIERS = ["rejected", "generic", "group", "single_portrait", "strong_metadata", "verified"] as const;
export type PersonTier = (typeof PERSON_TIERS)[number];
/** Combined-score band of each tier: a lower tier can never outrank a higher one. `generic` stays above the 0.45 auto-pick threshold, `rejected` below. */
export const PERSON_TIER_BANDS: Record<PersonTier, readonly [number, number]> = {
  verified: [0.88, 1],
  strong_metadata: [0.76, 0.88],
  single_portrait: [0.64, 0.76],
  group: [0.55, 0.64],
  generic: [0.46, 0.55],
  rejected: [0, 0.3],
};
/** A vision identity verdict counts from this confidence on; below it is treated as uncertain. */
export const PERSON_VERIFY_MIN_CONFIDENCE = 0.6;
/** Metadata alone never concludes the identity: its confidence is capped here (a vision `match` goes above). */
export const METADATA_IDENTITY_CAP = 0.75;

export type PersonVerificationMethod = "vision" | "metadata" | "none";
export type PersonRejectionReason = "person_wrong_person" | "person_news_card" | "person_not_visible" | "person_text_card" | "person_impostor_risk";

export type PersonCandidateScore = {
  identity: PersonIdentity;
  flags: PersonMediaFlag[];
  tier: PersonTier;
  framing: number;
  cleanliness: number;
  motion: number;
  /** 0..1 within-tier quality (cleanliness, framing, motion and the caller's base score). */
  inner: number;
  /** Combined person-mode score: the tier band + the within-tier quality (0 for a hard reject). */
  score: number;
  /** 0..1 how sure it IS the person: the vision verdict when there is one, else the metadata capped at {@link METADATA_IDENTITY_CAP}. */
  identityConfidence: number;
  verificationMethod: PersonVerificationMethod;
  /** Why a `rejected` candidate is at the bottom. */
  rejectionReason?: PersonRejectionReason;
  /** Never auto-picked at all (combined score 0): a sure wrong person, a news card, an empty frame claiming the person. */
  hardReject?: boolean;
  /** One person vs several (vision people count, else metadata hints): a hook for a later face-crop task. */
  framingKind: "single" | "group" | "unknown";
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Person-mode score of one candidate. Tier first (see {@link PERSON_TIERS}), then the quality inside the tier. Vision findings (shot +
 * identity, same moderation call) win over the metadata hints; with no vision verdict (budget, quota, no vision account) the metadata
 * tiers apply and nothing blocks. `base` = the caller's normal 0..1 score (semantic / continuity / quality / cost), default 0.5.
 */
export function scorePersonCandidate(
  target: PersonTarget,
  input: PersonMeta & { mediaType: "video" | "photo" | "image"; shot?: VisionShotFindings | null; identity?: VisionIdentityFindings | null; base?: number },
): PersonCandidateScore {
  const identity = matchPersonIdentity(target, input);
  const flags = personMetadataFlags(target, input);
  const shot = input.shot ?? null;
  const verdict = input.identity ?? null;
  const named = identity.score > 0;
  if (!named) flags.push("generic");

  let cleanliness = 1;
  if (shot) {
    cleanliness = shot.textCoverage === "heavy" ? 0.25 : shot.textCoverage === "little" ? 0.7 : 1;
    if (shot.logo) cleanliness -= 0.3;
  } else {
    if (flags.includes("news")) cleanliness -= 0.35;
    if (flags.includes("text_card")) cleanliness -= 0.5;
  }
  cleanliness = clamp01(cleanliness);

  let framing: number;
  if (shot) {
    const people = Math.max(0, Math.round(shot.peopleCount));
    if (named) framing = people === 0 ? 0 : people === 1 ? (shot.closeUp ? 1 : 0.75) : people <= 3 ? 0.4 : 0.15;
    else {
      framing = people === 0 ? 1 : people === 1 ? 0.1 : people <= 3 ? 0.3 : 0.6;
      if (people === 1) flags.push("impostor_risk");
    }
  } else if (named) {
    framing = flags.includes("close_up") ? 0.85 : flags.includes("group") || flags.includes("other_person") ? 0.35 : 0.55;
  } else {
    framing = 0.5;
  }
  const motion = input.mediaType === "video" ? (flags.includes("slideshow") ? 0.4 : 1) : 0.6;

  // Identity: only a confident vision `match` is a verification; metadata stays capped; `different_person` sinks the candidate.
  const sure = Boolean(verdict && verdict.confidence >= PERSON_VERIFY_MIN_CONFIDENCE);
  let identityConfidence: number;
  if (verdict?.match === "match" && sure) identityConfidence = Math.max(verdict.confidence, METADATA_IDENTITY_CAP * identity.score);
  else if (verdict?.match === "different_person") identityConfidence = sure ? 0 : 0.2 * identity.score;
  else if (verdict) identityConfidence = 0.5 * METADATA_IDENTITY_CAP * identity.score;
  else identityConfidence = METADATA_IDENTITY_CAP * identity.score;
  const verificationMethod: PersonVerificationMethod = verdict ? "vision" : named ? "metadata" : "none";
  if (verdict?.match === "different_person") flags.push("wrong_person");
  else if (verdict && named && !(verdict.match === "match" && sure)) flags.push("identity_uncertain");

  const group = shot ? shot.peopleCount >= 2 : flags.includes("group") || flags.includes("other_person");
  const framingKind: PersonCandidateScore["framingKind"] = group ? "group" : shot ? (shot.peopleCount === 1 ? "single" : "unknown") : flags.includes("close_up") ? "single" : "unknown";
  let tier: PersonTier;
  let rejectionReason: PersonRejectionReason | undefined;
  let hardReject = false;
  if (verdict?.match === "different_person") {
    tier = "rejected";
    rejectionReason = "person_wrong_person";
    hardReject = sure;
  } else if (shot?.newsCard) {
    tier = "rejected";
    rejectionReason = "person_news_card";
    hardReject = true;
  } else if (named && (shot ? shot.peopleCount <= 0 : verdict?.match === "no_person")) {
    tier = "rejected";
    rejectionReason = "person_not_visible";
    hardReject = true;
  } else if (!shot && flags.includes("text_card")) {
    tier = "rejected"; // a quote / meme / lyric card by its metadata: last resort only (vision may still clear it)
    rejectionReason = "person_text_card";
  } else if (!named) {
    tier = flags.includes("impostor_risk") ? "rejected" : "generic";
    if (tier === "rejected") rejectionReason = "person_impostor_risk";
  } else if (group || flags.includes("news")) {
    tier = "group";
  } else if (verdict?.match === "match" && sure) {
    tier = "verified";
  } else if (identity.level === "strong" && !flags.includes("identity_uncertain")) {
    tier = "strong_metadata";
  } else {
    tier = "single_portrait";
  }

  const w = PERSON_SCORE_WEIGHTS;
  const inner = clamp01(w.cleanliness * cleanliness + w.framing * framing + w.motion * motion + w.base * clamp01(input.base ?? 0.5));
  const [floor, ceil] = PERSON_TIER_BANDS[tier];
  const score = hardReject ? 0 : round3(floor + (ceil - floor) * inner);
  return {
    identity,
    flags,
    tier,
    framing,
    cleanliness,
    motion,
    inner: round3(inner),
    score,
    identityConfidence: round3(identityConfidence),
    verificationMethod,
    ...(rejectionReason ? { rejectionReason } : {}),
    ...(hardReject ? { hardReject } : {}),
    framingKind,
  };
}

/** What the vision identity check is told about the target (name, other spellings, group / team, other people). */
export const visionTargetOf = (target: PersonTarget): { name: string; aliases: string[]; context: string[]; others: string[] } => ({
  name: target.name,
  aliases: [...target.strongNames, ...target.weakNames].filter((name) => !sameName(name, target.name)).slice(0, 6),
  context: target.context.slice(0, 4),
  others: target.others.slice(0, 6),
});

/** verified = vision confirmed the person; metadata = named in the candidate's metadata (not rejected); generic = stock / backdrop / rejected. */
export type PersonMatchLevel = "verified" | "metadata" | "generic";

export const personMatchLevelOf = (score: Pick<PersonCandidateScore, "identity" | "tier">): PersonMatchLevel =>
  score.tier === "verified" ? "verified" : score.identity.score > 0 && score.tier !== "rejected" ? "metadata" : "generic";

/** Rejection reasons of a ranked pool (person mode), for the segment diagnostics. */
export const personRejectionCounts = (scores: ReadonlyArray<PersonCandidateScore | undefined>): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const score of scores) if (score?.rejectionReason) counts[score.rejectionReason] = (counts[score.rejectionReason] ?? 0) + 1;
  return counts;
};

/** A search phrase with the person's names (and group / team context) removed: the backdrop query for stock sources that never show the real person. */
export function stripPersonNames(phrase: string, target: PersonTarget): string {
  let out = ` ${phrase.normalize("NFKC")} `;
  const names = [...target.strongNames, ...target.weakNames, ...target.context].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const escaped = name.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(LATIN.test(name) ? `(^|[^\\p{L}\\p{N}])${escaped}(?=[^\\p{L}\\p{N}]|$)` : escaped, "giu"), " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

// --- script focus ---------------------------------------------------------------------------------------------------------

/** At least this share of scenes names the person (pronouns cover the rest; ja scripts often drop the subject). */
export const SCRIPT_PERSON_MIN_COVERAGE = 0.25;
/** At most this share of scenes may be about another named person without naming the target. */
export const SCRIPT_PERSON_MAX_OFF_TARGET = 0.3;

export type ScriptPersonFocusReason = "target_missing_in_hook" | "target_coverage_low" | "other_person_dominates" | "too_many_off_target_scenes";

export type ScriptPersonFocus = {
  ok: boolean;
  /** Share of scenes whose narration / on-screen text names the target. */
  coverage: number;
  hookNamesTarget: boolean;
  /** Scenes naming another person (or a mustExclude term) and not the target. */
  offTargetSceneIds: string[];
  /** Another person named in more scenes than the target. */
  dominantOther: string | null;
  reasons: ScriptPersonFocusReason[];
};

export function assessScriptPersonFocus(
  target: PersonTarget,
  script: { title?: string | null; scenes: ReadonlyArray<{ sceneId: string; narration: string; screenText?: string | null }> },
): ScriptPersonFocus {
  const names = [...target.strongNames, ...target.weakNames];
  const sceneTexts = script.scenes.map((scene) => ({ sceneId: scene.sceneId, text: `${scene.narration} ${scene.screenText ?? ""}` }));
  const targetScenes = sceneTexts.filter((scene) => anyIn(scene.text, names, true));
  const coverage = sceneTexts.length > 0 ? targetScenes.length / sceneTexts.length : 0;
  const first = sceneTexts[0];
  const hookNamesTarget = Boolean((first && anyIn(first.text, names, true)) || (script.title && anyIn(script.title, names, true)));
  const offTarget = sceneTexts.filter((scene) => !anyIn(scene.text, names, true) && (anyIn(scene.text, target.others, true) || anyIn(scene.text, target.exclude, false)));
  let dominantOther: string | null = null;
  for (const other of target.others) {
    const count = sceneTexts.filter((scene) => nameIn(scene.text, other, true)).length;
    if (count > targetScenes.length && (!dominantOther || count > sceneTexts.filter((scene) => nameIn(scene.text, dominantOther!, true)).length)) dominantOther = other;
  }
  const reasons: ScriptPersonFocusReason[] = [];
  if (!hookNamesTarget) reasons.push("target_missing_in_hook");
  if (coverage < SCRIPT_PERSON_MIN_COVERAGE) reasons.push("target_coverage_low");
  if (dominantOther) reasons.push("other_person_dominates");
  if (sceneTexts.length > 0 && offTarget.length / sceneTexts.length > SCRIPT_PERSON_MAX_OFF_TARGET) reasons.push("too_many_off_target_scenes");
  return { ok: reasons.length === 0, coverage: Math.round(coverage * 1000) / 1000, hookNamesTarget, offTargetSceneIds: offTarget.map((scene) => scene.sceneId), dominantOther, reasons };
}

// --- job-level media coverage ---------------------------------------------------------------------------------------------

/** Below this share of the video's duration showing media that names the person, the job carries a clear low-confidence warning. */
export const PERSON_MEDIA_MIN_SHARE = 0.5;

export type PersonMediaCoverage = {
  /** Share of duration (0..1) with media naming the person (verified + metadata). */
  onTargetShare: number;
  verifiedShare: number;
  genericShare: number;
  lowConfidence: boolean;
};

export function assessPersonMediaCoverage(items: ReadonlyArray<{ durationMs: number; personMatch: PersonMatchLevel | null | undefined }>, minShare = PERSON_MEDIA_MIN_SHARE): PersonMediaCoverage {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
  const share = (predicate: (level: PersonMatchLevel | null | undefined) => boolean) =>
    total > 0 ? Math.round((items.filter((item) => predicate(item.personMatch)).reduce((sum, item) => sum + Math.max(0, item.durationMs), 0) / total) * 1000) / 1000 : 0;
  const onTargetShare = share((level) => level === "verified" || level === "metadata");
  return { onTargetShare, verifiedShare: share((level) => level === "verified"), genericShare: share((level) => level !== "verified" && level !== "metadata"), lowConfidence: onTargetShare < minShare };
}
