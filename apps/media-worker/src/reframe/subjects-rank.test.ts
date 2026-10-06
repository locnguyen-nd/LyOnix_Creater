import { describe, expect, it } from "vitest";
import { rankSubjects, type FrameDetections } from "./subjects.js";

const W = 720;
const H = 1280;
const face = (x: number, y: number, size: number, score = 0.9) => ({ box: { x, y, w: size, h: size }, score });
const frames = (build: () => ReturnType<typeof face>[]): FrameDetections[] => [0, 500, 1000].map((tMs) => ({ tMs, faces: build(), persons: null }));

describe("main-character ranking (central + confident)", () => {
  it("an equally large bystander at the frame edge does not beat the person near the centre", () => {
    const ranked = rankSubjects(frames(() => [face(20, 100, 140), face(290, 480, 140)]), W, H, null);
    const primary = ranked.tracks.find((track) => track.subjectId === ranked.primaryId)!;
    const box = primary.samples[0]!.box;
    expect(box.xPx + box.widthPx / 2).toBeGreaterThan(W * 0.3);
    expect(box.xPx + box.widthPx / 2).toBeLessThan(W * 0.7);
  });

  it("a clearly larger face still wins over a small central one", () => {
    const ranked = rankSubjects(frames(() => [face(20, 100, 260), face(330, 560, 80)]), W, H, null);
    const primary = ranked.tracks.find((track) => track.subjectId === ranked.primaryId)!;
    expect(primary.samples[0]!.box.widthPx).toBeGreaterThan(300);
  });

  it("a faint detection does not outrank a confident one of similar size", () => {
    const ranked = rankSubjects(frames(() => [face(300, 400, 150, 0.15), face(120, 500, 140, 0.95)]), W, H, null);
    const primary = ranked.tracks.find((track) => track.subjectId === ranked.primaryId)!;
    const box = primary.samples[0]!.box;
    expect(box.xPx + box.widthPx / 2).toBeLessThan(W / 2 + 10);
  });
});
