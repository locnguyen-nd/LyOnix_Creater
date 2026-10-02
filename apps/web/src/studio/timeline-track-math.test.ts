import { describe, expect, it } from "vitest";
import { dropIndexFromPointer, moveItem, splitMarkerRatios } from "./timeline-track-math";

describe("timeline track math", () => {
  it("places split markers proportionally to sentence length", () => {
    expect(splitMarkerRatios(["abcd", "abcd"])).toEqual([0.5]);
    expect(splitMarkerRatios(["a", "bb", "ccc"])).toEqual([1 / 6, 0.5]);
    expect(splitMarkerRatios(["only one"])).toEqual([]);
  });

  it("computes the drop gap from pointer position", () => {
    const offsets = [0, 64, 128];
    const widths = [60, 60, 60];
    expect(dropIndexFromPointer(5, offsets, widths)).toBe(0);
    expect(dropIndexFromPointer(40, offsets, widths)).toBe(1);
    expect(dropIndexFromPointer(100, offsets, widths)).toBe(2);
    expect(dropIndexFromPointer(500, offsets, widths)).toBe(3);
  });

  it("moves an item without mutating the input and ignores invalid moves", () => {
    const list = ["a", "b", "c", "d"];
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, 9, 0)).toEqual(list);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });
});
