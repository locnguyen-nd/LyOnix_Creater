import { describe, expect, it } from "vitest";
import { orshotIncludePages, orshotMaxScenes } from "./orshot-page-slots.js";

const slots = (pages: number) => Array.from({ length: pages }, (_, index) => ({ key: `page${index + 1}@media`, kind: "video" }));
const keys = (pages: number) => Array.from({ length: pages }, (_, index) => `page${index + 1}@media`);

describe("orshotIncludePages", () => {
  it("renders pages 1..9 of a 10-page template when the script has 9 scenes", () => {
    expect(orshotIncludePages(slots(10), [...keys(9), "page9@subtitle"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it("renders everything (no restriction) when every page is used", () => {
    expect(orshotIncludePages(slots(10), keys(10))).toBeNull();
  });
  it("does not apply to a template without numbered pages or without any page assignment", () => {
    expect(orshotIncludePages([{ key: "title", kind: "text" }], ["title"])).toBeNull();
    expect(orshotIncludePages(slots(10), ["title"])).toBeNull();
  });
  it("exposes the page capacity as the maximum number of scenes", () => {
    expect(orshotMaxScenes(slots(10))).toBe(10);
    expect(orshotMaxScenes([{ key: "title", kind: "text" }])).toBeNull();
  });
});
