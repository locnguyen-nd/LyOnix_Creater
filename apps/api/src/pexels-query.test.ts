import { describe, expect, it } from "vitest";
import { pexelsQueriesFor } from "./media-plan.service.js";

const script = (visualQuery: string | null) => ({
  language: "ja",
  scenes: [
    { sceneId: "s01", narration: "大阪の新しい街", screenText: "", visualQuery: visualQuery ?? "", durationHintMs: 4000, voiceDurationMs: null },
    { sceneId: "s02", narration: "市民の期待", screenText: "", visualQuery: "", durationHintMs: 4000, voiceDurationMs: null },
  ],
  visualPlan: null,
}) as never;
const segment = (over: Record<string, unknown> = {}) => ({ segmentId: "seg-1", sceneIds: ["s01", "s02"], durationMs: 8000, subject: null, keywords: null, ...over }) as never;

describe("Pexels queries of a segment (never an empty string)", () => {
  it("uses the caller's subject-bound queries, dropping blanks", () => {
    expect(pexelsQueriesFor(["  ", "osaka skyline"], [], script(null), segment())).toEqual(["osaka skyline"]);
  });

  it("an empty brief phrase does not hide the scenes' visual query (the `??` bug that sent query='')", () => {
    expect(pexelsQueriesFor(undefined, [""], script("osaka waterfront construction"), segment())).toEqual(["osaka waterfront construction"]);
  });

  it("on-screen text with line breaks becomes one line (a line break made Pexels answer 400 'Invalid query')", () => {
    expect(pexelsQueriesFor(["悲しいお知らせ\nStray Kids フィリックス"], [], script(null), segment())).toEqual(["悲しいお知らせ Stray Kids フィリックス"]);
  });

  it("falls back to the segment keywords / subject, and to nothing at all instead of a blank query", () => {
    expect(pexelsQueriesFor(undefined, [], script(null), segment({ keywords: { en: ["city planning"], ja: [] } }))).toEqual(["city planning"]);
    expect(pexelsQueriesFor(undefined, [], script(null), segment({ subject: "Expo site" }))).toEqual(["Expo site"]);
    expect(pexelsQueriesFor(undefined, ["", " "], script(null), segment())).toEqual([]);
  });
});
