import { describe, expect, it } from "vitest";
import { selectSubtitlesForScenes } from "./subtitle-selection.js";

type Row = { id: string; audioVersionId: string; version: number; status: "current" | "stale"; source: string; segments: Array<{ text: string; startMs: number; endMs: number }> };

const cue = (text: string) => [{ text, startMs: 0, endMs: 1000 }];

/** In-memory `subtitleVersion.findMany` honouring the `id`/`audioVersionId` filters and `version desc` ordering. */
const prismaWith = (rows: Row[]) =>
  ({
    subtitleVersion: {
      findMany: async ({ where, orderBy }: { where: { id?: { in: string[] }; audioVersionId?: { in: string[] } }; orderBy?: unknown }) => {
        const matched = rows.filter((row) => (!where.id || where.id.in.includes(row.id)) && (!where.audioVersionId || where.audioVersionId.in.includes(row.audioVersionId)));
        return orderBy ? [...matched].sort((a, b) => b.version - a.version) : matched;
      },
    },
  }) as never;

describe("selectSubtitlesForScenes (V03-03)", () => {
  const rows: Row[] = [
    { id: "sub-a1", audioVersionId: "audio-a", version: 1, status: "stale", source: "elevenlabs_alignment", segments: cue("auto") },
    { id: "sub-a2", audioVersionId: "audio-a", version: 2, status: "current", source: "manual_edit", segments: cue("edited") },
    { id: "sub-b1", audioVersionId: "audio-b", version: 1, status: "current", source: "elevenlabs_alignment", segments: cue("b current") },
    { id: "sub-b2", audioVersionId: "audio-b", version: 2, status: "stale", source: "manual_edit", segments: cue("b stale newer") },
    { id: "sub-c1", audioVersionId: "audio-c", version: 1, status: "stale", source: "elevenlabs_alignment", segments: cue("c only stale") },
  ];

  it("uses the version the timeline pinned, even when a newer one exists", async () => {
    const selected = await selectSubtitlesForScenes(prismaWith(rows), [{ audioVersionId: "audio-a", subtitleVersionId: "sub-a1" }]);
    expect(selected.get("audio-a")).toMatchObject({ subtitleVersionId: "sub-a1", segments: cue("auto") });
  });

  it("ignores a pin that belongs to another voice and falls back to the voice's newest current version", async () => {
    const selected = await selectSubtitlesForScenes(prismaWith(rows), [{ audioVersionId: "audio-a", subtitleVersionId: "sub-b1" }]);
    expect(selected.get("audio-a")).toMatchObject({ subtitleVersionId: "sub-a2", source: "manual_edit" });
  });

  it("without a pin picks the newest CURRENT version, not a newer stale one", async () => {
    const selected = await selectSubtitlesForScenes(prismaWith(rows), [{ audioVersionId: "audio-b", subtitleVersionId: null }]);
    expect(selected.get("audio-b")).toMatchObject({ subtitleVersionId: "sub-b1" });
  });

  it("keeps the pre-V03-03 behaviour (newest of any status) when a voice has no current version", async () => {
    const selected = await selectSubtitlesForScenes(prismaWith(rows), [{ audioVersionId: "audio-c" }]);
    expect(selected.get("audio-c")).toMatchObject({ subtitleVersionId: "sub-c1", segments: cue("c only stale") });
  });

  it("returns nothing for scenes without a voice", async () => {
    const selected = await selectSubtitlesForScenes(prismaWith(rows), [{ audioVersionId: null, subtitleVersionId: "sub-a1" }]);
    expect(selected.size).toBe(0);
  });
});
