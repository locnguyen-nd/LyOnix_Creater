import { deriveTemplateModifications, type TemplateModificationSlot } from "./creatomate.js";
import { deriveOrshotModifications } from "./orshot.js";

/**
 * VE2E-117: static analysis of a Creatomate / Orshot template JSON against what the internal `lyonix` engine can render (VE2E-105/107).
 * Pure. It answers "can this template move to the internal engine?": group **A** = everything it uses is supported (candidate for a recipe),
 * group **B** = it uses at least one feature the engine does not render (`providerOnly`: keep it on the provider).
 *
 * Supported by the engine today: scene transitions fade / wipe / slide / circular-wipe, still-image zoom (scale/pan), static + voice-timed
 * word-highlight captions, boxes (`shape` rectangles), text layers, video/image/audio/composition elements.
 */

export type LintSeverity = "unsupported" | "partial" | "info";
export type LintFinding = { severity: LintSeverity; code: string; path: string; detail: string };

export type TemplateLintReport = {
  source: "creatomate" | "orshot" | "unknown";
  canvas: { width: number | null; height: number | null; fps: number | null };
  elementTypes: Record<string, number>;
  sceneCount: number;
  fonts: string[];
  transitions: string[];
  animations: string[];
  slots: TemplateModificationSlot[];
  findings: LintFinding[];
  /** A = renderable by the internal engine, B = needs the provider. */
  group: "A" | "B";
};

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

/** Scene transitions (`animations[].transition === true`) the engine renders, by Creatomate name. */
export const SUPPORTED_TRANSITIONS: ReadonlyMap<string, string> = new Map([
  ["fade", "fade"],
  ["wipe", "wipe"],
  ["slide", "slide"],
  ["circular-wipe", "circle"],
]);

/** Non-transition animations the engine reproduces (image zoom). */
const SUPPORTED_ANIMATIONS = new Set(["scale", "pan", "fade"]);
/** Per-character/word text animations: not rendered by the engine (captions are laid out by `buildCaptionAss`, not animated per letter). */
const TEXT_ANIMATION_RE = /^text-|^(typewriter|reveal|bounce|spin|rotate|wiggle|shake)/i;
const SUPPORTED_ELEMENT_TYPES = new Set(["composition", "video", "image", "audio", "text", "shape"]);

const walk = (node: unknown, path: string, visit: (el: Node, path: string) => void): void => {
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, `${path}[${index}]`, visit));
    return;
  }
  if (!isNode(node)) return;
  if (typeof node.type === "string") visit(node, path);
  for (const [key, value] of Object.entries(node)) if (key === "elements" || key === "layers" || key === "pages" || key === "pages_data" || key === "children") walk(value, `${path}.${key}`, visit);
};

const detectSource = (raw: unknown): TemplateLintReport["source"] => {
  if (!isNode(raw)) return "unknown";
  if (Array.isArray(raw.elements)) return "creatomate";
  if (raw.pages_data !== undefined || raw.pages !== undefined || raw.layers !== undefined) return "orshot";
  return "unknown";
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function lintTemplate(raw: unknown): TemplateLintReport {
  const source = detectSource(raw);
  const root: Node = isNode(raw) ? raw : {};
  const findings: LintFinding[] = [];
  const elementTypes: Record<string, number> = {};
  const fonts = new Set<string>();
  const transitions = new Set<string>();
  const animations = new Set<string>();
  let sceneCount = 0;

  walk(root.elements ?? root.pages_data ?? root.pages ?? root.layers ?? [], "$", (el, path) => {
    const type = el.type as string;
    elementTypes[type] = (elementTypes[type] ?? 0) + 1;
    if (type === "composition" && /^Scene[-_ ]?\d+/i.test(String(el.name ?? ""))) sceneCount += 1;
    if (!SUPPORTED_ELEMENT_TYPES.has(type)) findings.push({ severity: "unsupported", code: "ELEMENT_TYPE", path, detail: `element type "${type}" is not rendered by the internal engine` });
    for (const key of ["font_family", "fontFamily"]) if (typeof el[key] === "string" && el[key]) fonts.add(el[key] as string);
    if (type === "shape" && typeof el.path === "string" && !/^M [\d. ]+L [\d. ]+L [\d. ]+L [\d. ]+Z$/.test(el.path.trim())) findings.push({ severity: "partial", code: "SHAPE_PATH", path, detail: "only rectangular shapes are drawn (as boxes); a custom path would be approximated" });
    if (el.keyframes !== undefined || (isNode(el.x) && Array.isArray(el.x.keyframes))) findings.push({ severity: "unsupported", code: "KEYFRAMES", path, detail: "keyframed properties are not supported" });
    if (typeof el.shadow_color === "string" || typeof el.shadow_blur === "string") findings.push({ severity: "partial", code: "SHADOW", path, detail: "shadows are not rendered" });
    if (typeof el.transcript_source === "string" && el.transcript_effect !== undefined && el.transcript_effect !== "highlight") findings.push({ severity: "unsupported", code: "TRANSCRIPT_EFFECT", path, detail: `caption effect "${String(el.transcript_effect)}" is not supported (only highlight)` });
    if (Array.isArray(el.animations)) {
      for (const [index, animation] of (el.animations as unknown[]).entries()) {
        if (!isNode(animation)) continue;
        const animType = String(animation.type ?? "");
        const apath = `${path}.animations[${index}]`;
        animations.add(animType);
        if (animation.transition === true) {
          transitions.add(animType);
          if (!SUPPORTED_TRANSITIONS.has(animType)) findings.push({ severity: "unsupported", code: "TRANSITION", path: apath, detail: `transition "${animType}" is not supported (supported: ${[...SUPPORTED_TRANSITIONS.keys()].join(", ")})` });
        } else if (TEXT_ANIMATION_RE.test(animType) || animation.split !== undefined) {
          findings.push({ severity: "unsupported", code: "TEXT_ANIMATION", path: apath, detail: `text animation "${animType}"${animation.split ? ` (split by ${String(animation.split)})` : ""} is not supported` });
        } else if (!SUPPORTED_ANIMATIONS.has(animType)) {
          findings.push({ severity: "unsupported", code: "ANIMATION", path: apath, detail: `animation "${animType}" is not supported` });
        } else if (animType === "fade" && type === "text") {
          findings.push({ severity: "partial", code: "TEXT_FADE", path: apath, detail: "fade on text is not animated (the text appears/disappears at its cue)" });
        }
      }
    }
  });

  let slots: TemplateModificationSlot[] = [];
  try {
    slots = source === "orshot" ? (deriveOrshotModifications(raw) as unknown as TemplateModificationSlot[]) : deriveTemplateModifications(raw);
  } catch {
    findings.push({ severity: "info", code: "SLOTS", path: "$", detail: "could not derive modification slots" });
  }
  if (source === "unknown") findings.push({ severity: "unsupported", code: "FORMAT", path: "$", detail: "not a recognised Creatomate/Orshot template" });
  const fps = num(root.frame_rate);
  if (fps !== null && fps !== 60) findings.push({ severity: "info", code: "FPS", path: "$.frame_rate", detail: `template is ${fps} fps; the internal engine always renders 60 fps CFR` });
  return {
    source,
    canvas: { width: num(root.width), height: num(root.height), fps },
    elementTypes,
    sceneCount,
    fonts: [...fonts].sort(),
    transitions: [...transitions].sort(),
    animations: [...animations].sort(),
    slots,
    findings,
    group: findings.some((f) => f.severity === "unsupported") ? "B" : "A",
  };
}

/** Plain-text summary for the CLI. */
export function formatLintReport(name: string, report: TemplateLintReport): string {
  const lines = [`${report.group}  ${name}  (${report.source}, ${report.sceneCount} scene(s), ${report.canvas.width ?? "?"}x${report.canvas.height ?? "?"} @ ${report.canvas.fps ?? "?"} fps)`];
  lines.push(`   fonts: ${report.fonts.join(", ") || "—"}`);
  lines.push(`   transitions: ${report.transitions.join(", ") || "—"}   animations: ${report.animations.join(", ") || "—"}`);
  lines.push(`   slots: ${report.slots.length}${report.slots.length ? ` (${report.slots.slice(0, 6).map((s) => s.key).join(", ")}${report.slots.length > 6 ? ", …" : ""})` : ""}`);
  for (const finding of report.findings) lines.push(`   ${finding.severity === "unsupported" ? "✗" : finding.severity === "partial" ? "~" : "·"} ${finding.code} ${finding.path}: ${finding.detail}`);
  return lines.join("\n");
}
