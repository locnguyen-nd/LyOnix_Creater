import { beforeEach, describe, expect, it } from "vitest";
import { SubtitleVersionsService } from "./subtitle-versions.service.js";

type Row = { id: string; audioVersionId: string; version: number; status: string; source: string; segments: unknown; staleReason: string | null; staleAt?: Date | null; createdByUserId?: string; createdAt: Date };

const text = "Hi there";
const characters = Array.from(text);
const alignment = { characters, characterStartTimesSeconds: characters.map((_, i) => i * 0.1), characterEndTimesSeconds: characters.map((_, i) => i * 0.1 + 0.1) };

describe("SubtitleVersionsService (V03-03)", () => {
  let rows: Row[];
  let audio: { id: string; status: string; durationMs: number; alignment: unknown; sceneDraftVersion: { scriptDraftVersion: { sourceVersion: { projectId: string } } } };
  let service: SubtitleVersionsService;
  let seq: number;

  const db = () => ({
    findMany: async ({ where }: any) => rows.filter((row) => row.audioVersionId === where.audioVersionId).sort((a, b) => b.version - a.version),
    findFirst: async ({ where }: any) => rows.filter((row) => row.audioVersionId === where.audioVersionId && (!where.status || row.status === where.status)).sort((a, b) => b.version - a.version)[0] ?? null,
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((row) => row.id === where.id && row.status === where.status);
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    },
    create: async ({ data }: any) => {
      const row = { id: `sub-${++seq}`, staleReason: null, createdAt: new Date("2026-10-05T00:00:00Z"), ...data };
      rows.push(row);
      return row;
    },
  });

  beforeEach(() => {
    seq = 1;
    rows = [{ id: "sub-1", audioVersionId: "audio-1", version: 1, status: "current", source: "elevenlabs_alignment", segments: [{ text: "Hi there", startMs: 0, endMs: 800 }], staleReason: null, createdAt: new Date("2026-10-04T00:00:00Z") }];
    audio = { id: "audio-1", status: "current", durationMs: 1000, alignment, sceneDraftVersion: { scriptDraftVersion: { sourceVersion: { projectId: "project-1" } } } };
    const subtitleVersion = db();
    const prisma = {
      audioVersion: { findUnique: async ({ where }: any) => (where.id === audio.id ? audio : null) },
      subtitleVersion,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ subtitleVersion }),
    };
    const grants = { forUser: async (userId: string) => ({ teamIds: [], channelIds: [], projectIds: userId === "staff-in" ? ["project-1"] : [] }) };
    service = new SubtitleVersionsService(prisma as never, grants as never);
  });

  it("saves an edit as a NEW manual_edit version and retires the one it was based on", async () => {
    const outcome = await service.saveEdit("audio-1", "staff-in", "staff", {
      basedOnSubtitleVersionId: "sub-1",
      cues: [{ text: "Hi", startMs: 0, endMs: 200 }, { text: " there  you ", startMs: 300, endMs: 800 }],
    });
    expect(outcome).toMatchObject({ ok: true, data: { id: "sub-2", version: 2, status: "current", source: "manual_edit" } });
    if (outcome.ok) expect(outcome.data.segments[1]!.text).toBe("there you");
    expect(rows.find((row) => row.id === "sub-1")).toMatchObject({ status: "stale", staleReason: "edited" });
  });

  it("refuses an edit based on a version that is no longer current (VERSION_CONFLICT), without writing anything", async () => {
    await service.saveEdit("audio-1", "staff-in", "staff", { basedOnSubtitleVersionId: "sub-1", cues: [{ text: "One", startMs: 0, endMs: 800 }] });
    const stale = await service.saveEdit("audio-1", "staff-in", "staff", { basedOnSubtitleVersionId: "sub-1", cues: [{ text: "Two", startMs: 0, endMs: 800 }] });
    expect(stale).toMatchObject({ ok: false, code: "VERSION_CONFLICT", status: 409 });
    expect(rows).toHaveLength(2);
  });

  it("returns every invalid cue as a detail and names the first one in the message", async () => {
    const outcome = await service.saveEdit("audio-1", "staff-in", "staff", {
      basedOnSubtitleVersionId: "sub-1",
      cues: [{ text: "ok", startMs: 0, endMs: 500 }, { text: "", startMs: 400, endMs: 5000 }],
    });
    expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED", status: 400 });
    if (outcome.ok) return;
    expect(outcome.message).toContain("Dòng 2");
    expect(outcome.details).toEqual(expect.arrayContaining([{ field: "cues[1]", code: "TEXT_EMPTY" }, { field: "cues[1]", code: "OUT_OF_RANGE" }, { field: "cues[1]", code: "OVERLAP" }]));
    expect(rows).toHaveLength(1);
  });

  it("resets to the automatic captions rebuilt from the stored alignment (no provider call)", async () => {
    await service.saveEdit("audio-1", "staff-in", "staff", { basedOnSubtitleVersionId: "sub-1", cues: [{ text: "Edited", startMs: 0, endMs: 800 }] });
    const reset = await service.resetToAuto("audio-1", "staff-in", "staff", { basedOnSubtitleVersionId: "sub-2" });
    expect(reset).toMatchObject({ ok: true, data: { version: 3, source: "elevenlabs_alignment", status: "current" } });
    if (reset.ok) expect(reset.data.segments.map((cue) => cue.text).join(" ")).toBe("Hi there");
    expect(rows.find((row) => row.id === "sub-2")).toMatchObject({ status: "stale", staleReason: "reset" });
  });

  it("refuses to edit the captions of a stale voice", async () => {
    audio.status = "stale";
    await expect(service.saveEdit("audio-1", "staff-in", "staff", { basedOnSubtitleVersionId: "sub-1", cues: [{ text: "x", startMs: 0, endMs: 800 }] })).resolves.toMatchObject({ ok: false, code: "INVALID_STATE" });
  });

  it("hides a voice of a project the staff user has no grant for, and lists versions newest first otherwise", async () => {
    await expect(service.list("audio-1", "staff-out", "staff")).resolves.toMatchObject({ ok: false, code: "NOT_FOUND", status: 404 });
    await expect(service.saveEdit("audio-1", "staff-out", "staff", { basedOnSubtitleVersionId: "sub-1", cues: [{ text: "x", startMs: 0, endMs: 800 }] })).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
    await service.saveEdit("audio-1", "admin-1", "admin", { basedOnSubtitleVersionId: "sub-1", cues: [{ text: "Admin edit", startMs: 0, endMs: 800 }] });
    const listed = await service.list("audio-1", "admin-1", "admin");
    expect(listed.ok && listed.data.map((row) => row.version)).toEqual([2, 1]);
  });

  it("requires basedOnSubtitleVersionId", async () => {
    await expect(service.saveEdit("audio-1", "staff-in", "staff", { cues: [{ text: "x", startMs: 0, endMs: 800 }] })).resolves.toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });
});
