import type { PrismaService } from "./prisma.service.js";

export type SelectedCaptionSegment = { text: string; startMs: number; endMs: number };
export type SelectedSubtitle = { subtitleVersionId: string | null; source: string | null; segments: SelectedCaptionSegment[] };

type SubtitleRow = { id?: string; audioVersionId: string; version?: number; status?: string; source?: string; segments: unknown };

const toSelected = (row: SubtitleRow): SelectedSubtitle => ({
  subtitleVersionId: row.id ?? null,
  source: row.source ?? null,
  segments: (Array.isArray(row.segments) ? row.segments : []) as SelectedCaptionSegment[],
});

/**
 * V03-03: which `SubtitleVersion` each bound voice renders with, shared by the Creatomate dynamic path, the internal engine
 * and the preview so all three show the same captions:
 *  1. the version the timeline pinned (`subtitleVersionId`), when it really belongs to that scene's audio - an approved
 *     timeline renders exactly the captions it was approved with, even after a newer edit exists;
 *  2. otherwise (timelines saved before V03-03, or no pin) the newest `current` version of the audio;
 *  3. otherwise the newest version of any status (the pre-V03-03 behaviour, kept so an old render never loses its captions).
 * Keyed by `audioVersionId`.
 */
export async function selectSubtitlesForScenes(
  prisma: PrismaService,
  scenes: ReadonlyArray<{ audioVersionId?: string | null; subtitleVersionId?: string | null }>,
): Promise<Map<string, SelectedSubtitle>> {
  const result = new Map<string, SelectedSubtitle>();
  const audioIds = [...new Set(scenes.map((scene) => scene.audioVersionId).filter((id): id is string => Boolean(id)))];
  if (audioIds.length === 0) return result;

  const pinnedByAudio = new Map<string, string>();
  for (const scene of scenes) {
    if (scene.audioVersionId && scene.subtitleVersionId && !pinnedByAudio.has(scene.audioVersionId)) pinnedByAudio.set(scene.audioVersionId, scene.subtitleVersionId);
  }
  if (pinnedByAudio.size > 0) {
    const pinnedRows = (await prisma.subtitleVersion.findMany({
      where: { id: { in: [...new Set(pinnedByAudio.values())] }, audioVersionId: { in: [...pinnedByAudio.keys()] } },
      select: { id: true, audioVersionId: true, version: true, status: true, source: true, segments: true },
    })) as SubtitleRow[];
    for (const row of pinnedRows) {
      if (row.id && pinnedByAudio.get(row.audioVersionId) === row.id) result.set(row.audioVersionId, toSelected(row));
    }
  }

  const remaining = audioIds.filter((id) => !result.has(id));
  if (remaining.length === 0) return result;
  const rows = (await prisma.subtitleVersion.findMany({
    where: { audioVersionId: { in: remaining } },
    orderBy: { version: "desc" },
    select: { id: true, audioVersionId: true, version: true, status: true, source: true, segments: true },
  })) as SubtitleRow[];
  const newestAny = new Map<string, SubtitleRow>();
  for (const row of rows) {
    if (!newestAny.has(row.audioVersionId)) newestAny.set(row.audioVersionId, row);
    if (!result.has(row.audioVersionId) && row.status === "current") result.set(row.audioVersionId, toSelected(row));
  }
  for (const [audioVersionId, row] of newestAny) {
    if (!result.has(audioVersionId)) result.set(audioVersionId, toSelected(row));
  }
  return result;
}
