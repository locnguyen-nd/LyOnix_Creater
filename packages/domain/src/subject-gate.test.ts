import { describe, expect, it } from "vitest";
import { candidateSubjectMatch, type MediaCandidate, type SceneBrief } from "./index.js";

const brief = { sceneId: "s", subjectAliases: ["メッシ", "Messi"] } as unknown as SceneBrief;
const candidate = (descriptorText: string) => ({ descriptorText, attribution: null, provenance: {} }) as unknown as MediaCandidate;

describe("candidateSubjectMatch (VE2E-142)", () => {
  it("is positive when the caption/hashtags name the subject and zero otherwise", () => {
    expect(candidateSubjectMatch(candidate("Messi leaves the field for the final time #messi"), brief)).toBeGreaterThan(0);
    expect(candidateSubjectMatch(candidate("Sunday service worship #church"), brief)).toBe(0);
  });
});
