import { extractJsonObject, isContentLanguage, type ContentLanguage, type ScriptDraftV1 } from "./script-draft-v1.js";

export const CAPTION_PLAN_SCHEMA_VERSION = "caption-plan.v1" as const;

export type CaptionSegmentV1 = { text: string; breakAfter: boolean };
export type CaptionSceneV1 = {
  sceneId: string;
  spokenText: string;
  segments: CaptionSegmentV1[];
  visualIntent: string;
  visualAsset: string;
  durationHintMs: number;
};
export type CaptionPlanV1 = {
  schemaVersion: typeof CAPTION_PLAN_SCHEMA_VERSION;
  language: ContentLanguage;
  voiceDelegation: "vrew";
  scenes: CaptionSceneV1[];
};

export const CAPTION_PLAN_V1_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "language", "voiceDelegation", "scenes"],
  properties: {
    schemaVersion: { type: "string", enum: [CAPTION_PLAN_SCHEMA_VERSION] },
    language: { type: "string", enum: ["vi", "en", "ja", "ko"] },
    voiceDelegation: { type: "string", enum: ["vrew"] },
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: 14,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sceneId", "spokenText", "segments", "visualIntent", "visualAsset", "durationHintMs"],
        properties: {
          sceneId: { type: "string" },
          spokenText: { type: "string" },
          visualIntent: { type: "string" },
          visualAsset: { type: "string" },
          durationHintMs: { type: "integer", minimum: 1000, maximum: 15000 },
          segments: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "breakAfter"],
              properties: {
                text: { type: "string" },
                breakAfter: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function splitSpokenCaptions(spoken: string): CaptionSegmentV1[] {
  const cleaned = spoken.replace(/\s+/g, " ").trim();
  if (!cleaned) return [{ text: "…", breakAfter: true }];
  const parts = cleaned.split(/(?<=[.!?…,;:])\s+/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const part of parts.length ? parts : [cleaned]) {
    const next = current ? `${current} ${part}` : part;
    if (next.length <= 42 || !current) current = next;
    else {
      chunks.push(current);
      current = part;
    }
    if (current.length > 42) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  const limited = (chunks.length ? chunks : [cleaned]).slice(0, 3);
  return limited.map((item, index) => ({ text: item, breakAfter: index < limited.length - 1 }));
}

export function captionPlanFromScript(script: ScriptDraftV1): CaptionPlanV1 {
  return {
    schemaVersion: CAPTION_PLAN_SCHEMA_VERSION,
    language: script.language,
    voiceDelegation: "vrew",
    scenes: script.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      spokenText: scene.narration || scene.screenText,
      segments: splitSpokenCaptions(scene.narration || scene.screenText),
      visualIntent: scene.visualBrief || scene.screenText,
      visualAsset: `visuals/${scene.sceneId}.txt`,
      durationHintMs: scene.estimatedDurationMs,
    })),
  };
}

export function parseCaptionPlan(value: unknown, language: ContentLanguage, fallback: CaptionPlanV1): CaptionPlanV1 | null {
  const root = asRecord(extractJsonObject(value));
  if (!root) return null;
  const nested = asRecord(root.captionPlan) ?? root;
  const scenesRaw = Array.isArray(nested.scenes) ? nested.scenes : [];
  const incoming = new Map<string, Record<string, unknown>>();
  for (const item of scenesRaw) {
    const row = asRecord(item);
    const sceneId = text(row?.sceneId);
    if (row && sceneId) incoming.set(sceneId, row);
  }
  const scenes: CaptionSceneV1[] = [];
  for (const base of fallback.scenes) {
    const row = incoming.get(base.sceneId);
    if (!row) return null;
    const segmentsRaw = Array.isArray(row.segments) ? row.segments : [];
    const segments = segmentsRaw.map((seg) => {
      const rec = asRecord(seg) ?? {};
      return { text: text(rec.text), breakAfter: rec.breakAfter !== false };
    }).filter((seg) => seg.text);
    scenes.push({
      sceneId: base.sceneId,
      spokenText: text(row.spokenText) || base.spokenText,
      segments: segments.length ? segments.slice(0, 3) : base.segments,
      visualIntent: text(row.visualIntent) || base.visualIntent,
      visualAsset: text(row.visualAsset) || base.visualAsset,
      durationHintMs: Number(row.durationHintMs) > 0 ? Math.round(Number(row.durationHintMs)) : base.durationHintMs,
    });
  }
  return {
    schemaVersion: CAPTION_PLAN_SCHEMA_VERSION,
    language: isContentLanguage(text(nested.language)) ? nested.language as ContentLanguage : language,
    voiceDelegation: "vrew",
    scenes,
  };
}

export function buildCaptionPlanPrompt(script: ScriptDraftV1) {
  const textPrompt = `You are LyOnix. Split the approved ScriptDraftV1 into an untimed caption plan for Vrew.
Return JSON matching ${CAPTION_PLAN_SCHEMA_VERSION}.
voiceDelegation must be "vrew". Do not invent timestamps.
Keep every spoken word. Split each scene into 1-3 caption segments (max ~42 characters, max 2 lines of meaning).
Do not rewrite facts. visualIntent is a 9:16 shot brief. visualAsset is visuals/{sceneId}.txt.
Approved script JSON:
${JSON.stringify({
    title: script.title,
    language: script.language,
    hook: script.hook,
    body: script.body,
    cta: script.cta,
    scenes: script.scenes,
  })}`;
  return {
    text: textPrompt,
    repairText: `${textPrompt}\nPrevious JSON was invalid. Return one object covering every sceneId exactly once.`,
  };
}
