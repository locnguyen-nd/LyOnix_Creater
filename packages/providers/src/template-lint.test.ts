import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newsRecapJpTemplate, top5CountdownTemplate } from "./fixtures/creatomate-templates.js";
import { formatLintReport, lintTemplate } from "./template-lint.js";

const scene = (animations?: unknown[], extra: Record<string, unknown> = {}) => ({
  name: "Scene-1",
  type: "composition",
  elements: [
    { name: "Video-1", type: "video", dynamic: true, source: "x", ...(animations ? { animations } : {}) },
    { name: "Subtitles-1", type: "text", dynamic: true, text: "t", font_family: "M PLUS Rounded 1c", ...extra },
  ],
});
const template = (elements: unknown[]) => ({ width: 1080, height: 1920, frame_rate: 30, elements });

describe("lintTemplate (VE2E-117)", () => {
  it("classifies the news-recap template (fade/wipe/scale only, highlighted captions) as group A", () => {
    const report = lintTemplate(newsRecapJpTemplate());
    expect(report.source).toBe("creatomate");
    expect(report.group).toBe("A");
    expect(report.sceneCount).toBe(10);
    expect(report.fonts).toEqual(["Noto Sans JP"]);
    expect(report.findings.filter((f) => f.severity === "unsupported")).toEqual([]);
    expect(report.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(report.findings.some((f) => f.code === "FPS")).toBe(true); // 30 fps template -> the engine renders 60
    expect(report.slots.length).toBeGreaterThan(0);
  });

  it("classifies the top-5 countdown template (flip transition) as group B and names the unsupported feature", () => {
    const report = lintTemplate(top5CountdownTemplate());
    expect(report.group).toBe("B");
    expect(report.transitions).toEqual(["circular-wipe", "flip", "slide", "wipe"]);
    const unsupported = report.findings.filter((f) => f.severity === "unsupported");
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toMatchObject({ code: "TRANSITION" });
    expect(unsupported[0]!.detail).toContain('"flip"');
    expect(unsupported[0]!.detail).toContain("circular-wipe"); // lists what IS supported
    expect(report.elementTypes).toMatchObject({ composition: 5, video: 5, shape: 5, audio: 5 });
  });

  it("templates built only from supported features are group A (fade / wipe / scale + highlight captions + rectangles)", () => {
    const report = lintTemplate(
      template([
        scene([{ type: "wipe", transition: true, duration: 0.4 }]),
        { name: "Scene-2", type: "composition", elements: [{ type: "image", animations: [{ type: "scale", start_scale: "100%", end_scale: "106%" }] }, { type: "shape", path: "M 0 0 L 100 0 L 100 100 L 0 100 Z" }, { type: "text", transcript_source: "Voiceover-1", transcript_effect: "highlight", text: "x" }] },
      ]),
    );
    expect(report.group).toBe("A");
    expect(report.findings.filter((f) => f.severity !== "info")).toEqual([]);
  });

  it("flags per-letter text animations, keyframes, unknown transitions/animations/element types and caption effects as unsupported", () => {
    const cases: Array<[string, unknown, string]> = [
      ["text-scale by character", template([scene(undefined, { animations: [{ type: "text-scale", split: "letter", scope: "element" }] })]), "TEXT_ANIMATION"],
      ["text-slide", template([scene(undefined, { animations: [{ type: "text-slide" }] })]), "TEXT_ANIMATION"],
      ["flip", template([scene([{ type: "flip", transition: true }])]), "TRANSITION"],
      ["unknown animation", template([scene([{ type: "pulse-glow" }])]), "ANIMATION"],
      ["keyframes", template([{ type: "composition", name: "Scene-1", elements: [{ type: "text", x: { keyframes: [1, 2] } }] }]), "KEYFRAMES"],
      ["exotic element", template([{ type: "composition", name: "Scene-1", elements: [{ type: "lottie" }] }]), "ELEMENT_TYPE"],
      ["caption effect", template([scene(undefined, { transcript_source: "Voiceover-1", transcript_effect: "karaoke" })]), "TRANSCRIPT_EFFECT"],
    ];
    for (const [label, raw, code] of cases) {
      const report = lintTemplate(raw);
      expect(report.group, label).toBe("B");
      expect(report.findings.map((f) => f.code), label).toContain(code);
    }
  });

  it("partial support (shadow, custom shape path, text fade) is reported but keeps the template in group A", () => {
    const report = lintTemplate(
      template([
        { type: "composition", name: "Scene-1", elements: [{ type: "shape", path: "M 0 0 C 10 10 20 20 30 30" }, { type: "text", shadow_color: "#000", animations: [{ type: "fade" }] }] },
      ]),
    );
    expect(report.group).toBe("A");
    expect(report.findings.map((f) => f.code).sort()).toEqual(expect.arrayContaining(["SHADOW", "SHAPE_PATH", "TEXT_FADE"]));
    expect(report.findings.every((f) => f.severity !== "unsupported")).toBe(true);
  });

  it("recognises an Orshot-style template, and rejects garbage without throwing", () => {
    const orshot = lintTemplate({ pages_data: [{ layers: [{ type: "text", font_family: "Inter" }, { type: "image" }] }] });
    expect(orshot.source).toBe("orshot");
    expect(orshot.fonts).toEqual(["Inter"]);
    for (const junk of [null, 42, "x", [], {}]) {
      const report = lintTemplate(junk);
      expect(report.group).toBe("B");
      expect(report.findings.map((f) => f.code)).toContain("FORMAT");
    }
  });

  it("formats a readable summary", () => {
    const text = formatLintReport("top5.json", lintTemplate(top5CountdownTemplate()));
    expect(text).toContain("B  top5.json");
    expect(text).toContain("✗ TRANSITION");
    expect(text).toContain("fonts: Noto Sans JP");
  });
});

describe("template:lint CLI", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsx = resolve(here, "../node_modules/.bin/tsx");
  const cli = resolve(here, "../scripts/template-lint.ts");
  it.skipIf(!existsSync(tsx))("reads files and directories, prints the A/B split, and exits 2 on unreadable JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "lyonix-lint-"));
    try {
      writeFileSync(join(dir, "news.json"), JSON.stringify(newsRecapJpTemplate()));
      writeFileSync(join(dir, "top5.json"), JSON.stringify({ id: "x", source: top5CountdownTemplate() })); // a saved get_template response
      const ok = spawnSync(tsx, [cli, dir], { encoding: "utf8", cwd: resolve(here, "..") });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("A  news.json");
      expect(ok.stdout).toContain("B  top5.json");
      expect(ok.stdout).toContain("group A (internal engine): 1 · group B (provider-only): 1");
      writeFileSync(join(dir, "broken.json"), "{not json");
      const bad = spawnSync(tsx, [cli, join(dir, "broken.json")], { encoding: "utf8", cwd: resolve(here, "..") });
      expect(bad.status).toBe(2);
      const json = spawnSync(tsx, [cli, join(dir, "news.json"), "--json"], { encoding: "utf8", cwd: resolve(here, "..") });
      expect(JSON.parse(json.stdout)[0]).toMatchObject({ file: "news.json", group: "A" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
