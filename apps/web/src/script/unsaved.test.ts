import { describe, expect, it } from "vitest";
import { locales } from "../i18n/locales";
import { isInAppNavigation, isScriptDirty } from "./unsaved";

const click = (extra: Partial<MouseEvent> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...extra }) as MouseEvent;
const anchor = (href: string, target = "", download = false) => ({ href, target, hasAttribute: (name: string) => name === "download" && download }) as unknown as HTMLAnchorElement;
const here = { origin: "http://localhost:5173", pathname: "/jobs/j1/script", search: "" } as Location;

describe("ScriptPage unsaved-edit helpers (VE2E-124)", () => {
  it("detects an edit, ignoring key order", () => {
    const saved = { title: "A", hook: "h", scenes: [{ sceneId: "s1", narration: "n" }] };
    expect(isScriptDirty({ hook: "h", title: "A", scenes: [{ narration: "n", sceneId: "s1" }] }, saved)).toBe(false);
    expect(isScriptDirty({ ...saved, scenes: [{ sceneId: "s1", narration: "n2" }] }, saved)).toBe(true);
  });

  it("only interrupts a plain in-app navigation to another route", () => {
    expect(isInAppNavigation(click(), anchor("http://localhost:5173/jobs"), here)).toBe(true);
    expect(isInAppNavigation(click(), anchor("http://localhost:5173/jobs/j1/script#scene-2"), here)).toBe(false);
    expect(isInAppNavigation(click({ ctrlKey: true }), anchor("http://localhost:5173/jobs"), here)).toBe(false);
    expect(isInAppNavigation(click(), anchor("http://localhost:5173/jobs", "_blank"), here)).toBe(false);
    expect(isInAppNavigation(click(), anchor("https://example.com/x"), here)).toBe(false);
    expect(isInAppNavigation(click({ defaultPrevented: true }), anchor("http://localhost:5173/jobs"), here)).toBe(false);
  });

  it("has the unsaved strings in every locale", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      expect(locales[locale].script.unsavedChanges, locale).toBeTruthy();
      expect(locales[locale].script.unsavedLeaveConfirm, locale).toBeTruthy();
    }
  });
});
