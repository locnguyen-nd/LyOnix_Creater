import { describe, expect, it } from "vitest";
import { BinaryNotFoundError, type ProcessRunner } from "../process.js";
import { checkFontsAvailable, parseFamilies } from "./fonts.js";

const runnerWith = (outputs: Record<string, { stdout: string; exitCode?: number } | "missing">): ProcessRunner => async (binary) => {
  const out = outputs[binary];
  if (!out || out === "missing") throw new BinaryNotFoundError(binary);
  return { exitCode: out.exitCode ?? 0, stdout: out.stdout, stderrTail: "" };
};

describe("checkFontsAvailable", () => {
  const listing = "Noto Sans CJK JP,Noto Sans CJK JP Bold\nDejaVu Sans\nM PLUS Rounded 1c,M PLUS Rounded 1c Medium\n";
  it("parses fontconfig family lists case-insensitively", () => {
    expect([...parseFamilies(listing)]).toEqual(expect.arrayContaining(["noto sans cjk jp", "dejavu sans", "m plus rounded 1c"]));
  });
  it("passes when every required family is installed", async () => {
    expect(await checkFontsAvailable(runnerWith({ "fc-list": { stdout: listing } }), ["Noto Sans CJK JP", "dejavu sans"], null)).toEqual({ ok: true, checked: true });
  });
  it("reports exactly the missing families", async () => {
    expect(await checkFontsAvailable(runnerWith({ "fc-list": { stdout: listing } }), ["Noto Sans CJK JP", "Comic Sans"], null)).toEqual({ ok: false, missing: ["Comic Sans"] });
  });
  it("counts fonts found in RENDER_FONTS_DIR via fc-scan", async () => {
    const runner = runnerWith({ "fc-list": { stdout: "DejaVu Sans\n" }, "fc-scan": { stdout: "Noto Sans JP\n" } });
    expect(await checkFontsAvailable(runner, ["Noto Sans JP"], "/fonts")).toEqual({ ok: true, checked: true });
    expect(await checkFontsAvailable(runner, ["Noto Sans JP"], null)).toEqual({ ok: false, missing: ["Noto Sans JP"] });
  });
  it("skips (unchecked) where fontconfig tools are not installed or fail, and needs nothing for no fonts", async () => {
    expect(await checkFontsAvailable(runnerWith({ "fc-list": "missing" }), ["X"], null)).toEqual({ ok: true, checked: false });
    expect(await checkFontsAvailable(runnerWith({ "fc-list": { stdout: "", exitCode: 1 } }), ["X"], null)).toEqual({ ok: true, checked: false });
    expect(await checkFontsAvailable(runnerWith({}), [], null)).toEqual({ ok: true, checked: true });
  });
});
