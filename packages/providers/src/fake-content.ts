import {
  SCRIPT_DRAFT_SCHEMA_VERSION,
  type ContentLanguage,
  type ScriptDraftV1,
} from "./script-draft-v1.js";

const hash = (value: string) => {
  let n = 2166136261;
  for (const char of value) n = Math.imul(n ^ char.charCodeAt(0), 16777619);
  return n >>> 0;
};

const copy: Record<ContentLanguage, { hook: string; cta: string; caption: string; visual: string }> = {
  vi: { hook: "Ba giây đầu", cta: "Theo dõi để xem phần sau", caption: "Kịch bản ngắn", visual: "cận mặt, chữ lớn, nhịp cắt nhanh" },
  en: { hook: "First three seconds", cta: "Follow for the next beat", caption: "Short script", visual: "close-up, big type, fast cuts" },
  ja: { hook: "最初の3秒", cta: "続きはフォロー", caption: "短い台本", visual: "クローズアップ、大きな文字" },
  ko: { hook: "처음 3초", cta: "이어서 보려면 팔로우", caption: "짧은 대본", visual: "클로즈업, 큰 글씨" },
};

export function generateFakeScriptDraft(input: {
  topic: string;
  language: ContentLanguage;
  direction: string;
  promptSpec?: string;
  version: number;
}): ScriptDraftV1 {
  const salt = hash(`${input.topic}|${input.direction}|${input.promptSpec ?? ""}|${input.version}|${input.language}`);
  const pack = copy[input.language];
  const sceneCount = 10 + (salt % 5);
  const duration = Math.round(60_000 / sceneCount);
  const angle = input.direction.trim() || input.promptSpec?.trim() || pack.hook;
  const scenes = Array.from({ length: sceneCount }, (_, index) => {
    const n = index + 1;
    const narration = `${input.topic}. ${angle}. ${pack.hook} #${n}/${sceneCount} (${salt.toString(16)}).`;
    return {
      sceneId: `s${String(n).padStart(2, "0")}`,
      narration,
      screenText: `${input.topic} · ${n}`,
      visualBrief: pack.visual,
      estimatedDurationMs: duration,
    };
  });
  const body = scenes.map((scene) => scene.narration).join(" ");
  return {
    schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
    language: input.language,
    title: `${input.topic} · v${input.version}`,
    hook: `${pack.hook}: ${input.topic} (${angle})`,
    body,
    cta: pack.cta,
    caption: `${pack.caption} · ${input.topic}`,
    scenes,
  };
}
