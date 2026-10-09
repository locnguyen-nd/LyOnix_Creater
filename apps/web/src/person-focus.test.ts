import { describe, expect, it } from "vitest";
import { personFocusWarnings } from "./person-focus";

describe("VE2E-151 person focus warnings", () => {
  it("keeps only the person-focus codes of the quality gate", () => {
    const gate = {
      checks: [],
      fixes: [],
      warnings: [
        { code: "subtitle_over_lines", sceneId: "s1", detail: "x" },
        { code: "script_off_target", detail: "Kịch bản chưa bám sát Lee Felix" },
        { code: "person_media_low_confidence", detail: "Không đủ media chắc chắn là Lee Felix" },
      ],
      degraded: { count: 0, sceneIds: [], tiers: {} },
      failure: null,
    };
    expect(personFocusWarnings(gate).map((warning) => warning.code)).toEqual(["script_off_target", "person_media_low_confidence"]);
    expect(personFocusWarnings(null)).toEqual([]);
  });
});
