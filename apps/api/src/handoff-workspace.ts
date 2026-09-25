import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptionPlanV1 } from "@lyonix/providers";
import type { ScriptDraft } from "./script-draft.js";

export type HandoffFile = { relativePath: string; mediaType: string; sha256: string; bytes: number; source: "generated" | "fixture" };
export type HandoffManifest = {
  schemaVersion: "handoff-workspace.v1";
  productionRequestId: string;
  scriptVersionId: string;
  timelineVersionId: string;
  locale: string;
  title: string;
  voiceDelegation: "vrew";
  expectedDurationMs: number;
  outputPreset: { aspect: "9:16"; width: 1080; height: 1920; fps: 30 };
  sceneOrder: string[];
  files: HandoffFile[];
  status: "ready" | "incomplete";
  errors: string[];
  renderTarget: "vrew_manual";
};

export type HandoffInput = {
  productionRequestId: string;
  scriptVersionId: string;
  scriptVersion: number;
  locale: string;
  topic: string;
  provider: string;
  model: string;
  promptTemplateVersion: string;
  schemaVersion: string;
  providerConfigVersion: number;
  assetSource: "generated" | "fixture";
  script: ScriptDraft;
  captionPlan: CaptionPlanV1;
};

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

export const mediaRoot = () => resolve(repoRoot, process.env.MEDIA_ROOT ?? "./data/media");

export const handoffFingerprint = (input: Pick<HandoffInput, "productionRequestId" | "scriptVersion" | "promptTemplateVersion" | "schemaVersion" | "providerConfigVersion">) =>
  createHash("sha256").update(JSON.stringify({
    productionRequestId: input.productionRequestId,
    scriptVersion: input.scriptVersion,
    promptTemplateVersion: input.promptTemplateVersion,
    schemaVersion: input.schemaVersion,
    providerConfigVersion: input.providerConfigVersion,
    layout: "vrew-novoice.v1",
  })).digest("hex");

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const fileEntry = (relativePath: string, body: string, mediaType: string, source: "generated" | "fixture"): HandoffFile & { body: string } => ({
  relativePath,
  body,
  mediaType,
  source,
  bytes: Buffer.byteLength(body),
  sha256: sha256(body),
});

export function buildHandoffDocuments(input: HandoffInput) {
  const plan = input.captionPlan;
  const vrewPaste = plan.scenes.map((scene) => scene.spokenText.trim()).filter(Boolean).join("\n\n");
  const sceneMap = {
    schemaVersion: "scene-map.v1",
    scenes: plan.scenes.map((scene, index) => ({
      sceneId: scene.sceneId,
      order: index + 1,
      durationHintMs: scene.durationHintMs,
      visualAsset: scene.visualAsset,
    })),
  };
  const captionPlan = {
    schemaVersion: plan.schemaVersion,
    language: plan.language,
    voiceDelegation: plan.voiceDelegation,
    scenes: plan.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      segments: scene.segments,
    })),
  };
  const scriptSource = {
    schemaVersion: "script-source.v1",
    title: input.script.title,
    hook: input.script.hook,
    body: input.script.body,
    cta: input.script.cta,
    language: input.script.language,
    scenes: plan.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      spokenText: scene.spokenText,
      captionSegments: scene.segments,
      visualIntent: scene.visualIntent,
      visualAsset: scene.visualAsset,
      durationHint: scene.durationHintMs,
    })),
  };
  const checklist = [
    "# Operator checklist",
    "",
    "1. Create Video from Text in Vrew (9:16).",
    "2. Paste script/vrew-paste.txt. Do not rewrite facts.",
    "3. Split captions using scenes/caption-plan.json.",
    "4. Place visuals from visuals/{sceneId}.txt briefs (Vrew AI images or imported stills).",
    "5. Confirm spoken words match captions before export.",
    "",
  ].join("\n");
  const files = [
    fileEntry("manifest.json", "", "application/json", input.assetSource),
    fileEntry("script/script-source.json", JSON.stringify(scriptSource, null, 2), "application/json", input.assetSource),
    fileEntry("script/vrew-paste.txt", vrewPaste, "text/plain", input.assetSource),
    fileEntry("scenes/scene-map.json", JSON.stringify(sceneMap, null, 2), "application/json", input.assetSource),
    fileEntry("scenes/caption-plan.json", JSON.stringify(captionPlan, null, 2), "application/json", input.assetSource),
    fileEntry("operator-checklist.md", checklist, "text/markdown", input.assetSource),
    fileEntry("style/caption-style.json", JSON.stringify({
      status: "draft",
      font: "sans-serif",
      color: "#ffffff",
      emphasis: "#f5c518",
      position: "bottom-center",
      maxLines: 2,
    }, null, 2), "application/json", input.assetSource),
    ...plan.scenes.map((scene) => fileEntry(
      scene.visualAsset.startsWith("visuals/") ? scene.visualAsset : `visuals/${scene.sceneId}.txt`,
      `${scene.visualIntent}\n`,
      "text/plain",
      input.assetSource,
    )),
  ];
  const errors: string[] = [];
  if (!vrewPaste.trim()) errors.push("missing_spoken_script");
  if (plan.scenes.length < 1) errors.push("missing_scenes");
  const expectedDurationMs = plan.scenes.reduce((sum, scene) => sum + scene.durationHintMs, 0);
  const withoutManifest = files.filter((file) => file.relativePath !== "manifest.json");
  const manifest: HandoffManifest = {
    schemaVersion: "handoff-workspace.v1",
    productionRequestId: input.productionRequestId,
    scriptVersionId: input.scriptVersionId,
    timelineVersionId: `script-v${input.scriptVersion}`,
    locale: input.locale,
    title: input.script.title,
    voiceDelegation: "vrew",
    expectedDurationMs,
    outputPreset: { aspect: "9:16", width: 1080, height: 1920, fps: 30 },
    sceneOrder: plan.scenes.map((scene) => scene.sceneId),
    files: [],
    status: errors.length ? "incomplete" : "ready",
    errors,
    renderTarget: "vrew_manual",
  };
  const manifestBody = JSON.stringify({
    ...manifest,
    files: withoutManifest.map(({ relativePath, mediaType, sha256, bytes, source }) => ({ relativePath, mediaType, sha256, bytes, source })),
  }, null, 2);
  const manifestFile = fileEntry("manifest.json", manifestBody, "application/json", input.assetSource);
  manifest.files = [manifestFile, ...withoutManifest].map(({ relativePath, mediaType, sha256, bytes, source }) => ({ relativePath, mediaType, sha256, bytes, source }));
  return { files: [manifestFile, ...withoutManifest], manifest };
}

export async function writeHandoffWorkspace(input: HandoffInput) {
  const docs = buildHandoffDocuments(input);
  const relativePath = `render-handoff/${input.productionRequestId}/script-v${input.scriptVersion}`;
  const finalDir = join(mediaRoot(), relativePath);
  const staging = `${finalDir}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const file of docs.files) {
    const abs = join(staging, file.relativePath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.body, "utf8");
  }
  await mkdir(dirname(finalDir), { recursive: true });
  await rm(finalDir, { recursive: true, force: true });
  await rename(staging, finalDir);
  return {
    relativePath: relative(mediaRoot(), finalDir).replaceAll("\\", "/"),
    manifest: docs.manifest,
    files: docs.files,
  };
}
