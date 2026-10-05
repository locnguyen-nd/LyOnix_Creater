import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioVersionsService } from "./audio-versions.service.js";
import type { ElevenLabsVoiceService } from "./elevenlabs-voice.service.js";
import type { TtsGenerationResponse } from "@lyonix/contracts";

const projectId = "project-1";
const sceneId = "scene-1";
const userId = "user-1";
const key = "audio-request-0001";

const synthesisData: TtsGenerationResponse = {
  asset: { id: "asset-1" } as TtsGenerationResponse["asset"],
  alignment: {
    characters: ["h", "i", " ", "t", "h", "e", "r", "e"],
    characterStartTimesSeconds: [0, 0.06, 0.12, 0.18, 0.24, 0.3, 0.36, 0.42],
    characterEndTimesSeconds: [0.06, 0.12, 0.18, 0.24, 0.3, 0.36, 0.42, 0.48],
  },
  durationMs: 480,
  providerPin: { accountId: "account-1", provider: "elevenlabs", voiceId: "voice-1", modelId: "eleven_multilingual_v2" },
};

describe("AudioVersionsService durable generation queue", () => {
  let prisma: any;
  let grants: any;
  let elevenLabs: Partial<ElevenLabsVoiceService>;
  let service: AudioVersionsService;
  let sceneRow: any;
  let operations: any[];
  let audioRows: any[];
  let subtitleRows: any[];
  let nextId: number;

  beforeEach(() => {
    operations = [];
    audioRows = [];
    subtitleRows = [];
    nextId = 1;
    sceneRow = { id: sceneId, narration: "Xin chao", scriptDraftVersion: { sourceVersion: { projectId } } };
    prisma = {
      sceneDraftVersion: { findUnique: vi.fn(async ({ where }: any) => (where.id === sceneId ? sceneRow : null)) },
      user: { findUnique: vi.fn(async ({ where }: any) => (where.id === userId ? { id: userId, role: "staff" } : null)) },
      providerAccount: { findFirst: vi.fn(async () => ({ id: "account-1", provider: "elevenlabs", role: "tts", scope: "organization", ownerUserId: null, status: "verified", isFake: false })) },
      audioGenerationOperation: {
        findUnique: vi.fn(async ({ where }: any) => where.id ? operations.find((op) => op.id === where.id) ?? null : operations.find((op) => op.userId === where.userId_idempotencyKey.userId && op.idempotencyKey === where.userId_idempotencyKey.idempotencyKey) ?? null),
        findFirst: vi.fn(async ({ where }: any) => operations.find((op) => Array.isArray(where.status?.in) ? where.status.in.includes(op.status) : op.status === where.status) ?? null),
        create: vi.fn(async ({ data }: any) => {
          if (operations.some((op) => op.userId === data.userId && op.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
          const row = { id: `operation-${nextId++}`, createdAt: new Date(), ...data };
          operations.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = operations.find((op) => op.id === where.id);
          Object.assign(row, data);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const row = operations.find((op) => op.id === where.id && op.status === where.status);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      audioVersion: {
        findFirst: vi.fn(async ({ where, orderBy }: any) => {
          let rows = audioRows.filter((row) => row.sceneDraftVersionId === where.sceneDraftVersionId && (!where.status || row.status === where.status));
          rows.sort((a, b) => (orderBy?.version === "desc" ? b.version - a.version : a.version - b.version));
          return rows[0] ?? null;
        }),
        findMany: vi.fn(async ({ where, orderBy }: any) => {
          const rows = audioRows.filter((row) => row.sceneDraftVersionId === where.sceneDraftVersionId);
          rows.sort((a, b) => (orderBy?.version === "desc" ? b.version - a.version : a.version - b.version));
          return rows.map((row) => ({ ...row, subtitleVersions: subtitleRows.filter((subtitle) => subtitle.audioVersionId === row.id) }));
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const ids: string[] = where.id?.in ?? (where.id ? [where.id] : []);
          let count = 0;
          for (const row of audioRows) if (ids.includes(row.id) && (!where.status || row.status === where.status)) { Object.assign(row, data); count += 1; }
          return { count };
        }),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: `audio-${nextId++}`, createdAt: new Date(), ...data };
          audioRows.push(row);
          return row;
        }),
      },
      subtitleVersion: {
        updateMany: vi.fn(async ({ where, data }: any) => {
          const ids: string[] = where.audioVersionId?.in ?? [where.audioVersionId];
          let count = 0;
          for (const row of subtitleRows) if (ids.includes(row.audioVersionId) && (!where.status || row.status === where.status)) { Object.assign(row, data); count += 1; }
          return { count };
        }),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: `subtitle-${nextId++}`, createdAt: new Date(), ...data };
          subtitleRows.push(row);
          return row;
        }),
      },
      $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    };
    grants = { forUser: vi.fn(async () => ({ projectIds: [projectId] })) };
    elevenLabs = { generateTts: vi.fn(async () => ({ ok: true as const, data: synthesisData })) };
    service = new AudioVersionsService(prisma, grants, elevenLabs as ElevenLabsVoiceService);
  });

  const enqueue = (idempotencyKey = key, voiceId = "voice-1") => service.generate(sceneId, userId, "staff", { providerAccountId: "account-1", voiceId, idempotencyKey });

  it("persists the idempotent operation and does not call the paid provider in the HTTP request", async () => {
    const first = await enqueue();
    const retry = await enqueue();
    expect(first).toMatchObject({ ok: true, data: { operationId: "operation-1", status: "queued" } });
    expect(retry).toEqual(first);
    expect(prisma.audioGenerationOperation.create).toHaveBeenCalledTimes(1);
    expect(elevenLabs.generateTts).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key with a different request fingerprint", async () => {
    await enqueue();
    const result = await enqueue(key, "different-voice");
    expect(result).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(prisma.audioGenerationOperation.create).toHaveBeenCalledTimes(1);
  });

  it("worker generates scene narration, persists alignment/subtitles atomically, and completes the operation", async () => {
    const queued = await enqueue();
    expect(queued.ok).toBe(true);
    await service.processNext();
    expect(elevenLabs.generateTts).toHaveBeenCalledWith("account-1", userId, "staff", { projectId, voiceId: "voice-1", text: "Xin chao" });
    expect(operations[0]).toMatchObject({ status: "completed", resultAudioVersionId: "audio-2" });
    expect(audioRows[0]).toMatchObject({ version: 1, status: "current", mediaAssetVersionId: "asset-1" });
    expect(subtitleRows[0]).toMatchObject({ status: "current", segments: [{ text: "hi there", startMs: 0, endMs: 480 }] });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("atomically marks prior audio and subtitles stale only after replacement rows are persisted", async () => {
    await enqueue(key, "voice-1");
    await service.processNext();
    await enqueue("audio-request-0002", "voice-2");
    await service.processNext();
    expect(audioRows.map((row) => row.status)).toEqual(["stale", "current"]);
    expect(subtitleRows.map((row) => row.status)).toEqual(["stale", "current"]);
  });

  it("refuses to queue when the scene has no narration", async () => {
    sceneRow.narration = "   ";
    const result = await enqueue();
    expect(result).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(prisma.audioGenerationOperation.create).not.toHaveBeenCalled();
  });

  it("marks provider rejection failed and does not retry the paid operation automatically", async () => {
    elevenLabs.generateTts = vi.fn(async () => ({ ok: false as const, code: "PROVIDER_RATE_LIMITED" as const, message: "rate limited" }));
    await enqueue();
    await service.processNext();
    await service.processNext();
    expect(operations[0]).toMatchObject({ status: "failed", errorCode: "PROVIDER_RATE_LIMITED" });
    expect(elevenLabs.generateTts).toHaveBeenCalledOnce();
  });

  it("records an unknown provider outcome if persistence fails and never dispatches the same operation twice", async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error("database unavailable"));
    await enqueue();
    await service.processNext();
    await service.processNext();
    expect(operations[0]).toMatchObject({ status: "unknown", errorCode: "PROVIDER_OUTCOME_UNKNOWN" });
    expect(elevenLabs.generateTts).toHaveBeenCalledOnce();
    const retryWithNewKey = await enqueue("audio-request-retry-0001", "voice-2");
    expect(retryWithNewKey).toMatchObject({ ok: true, data: { operationId: "operation-1", status: "unknown", errorCode: "PROVIDER_OUTCOME_UNKNOWN" } });
    expect(prisma.audioGenerationOperation.create).toHaveBeenCalledOnce();
  });

  it("returns NOT_FOUND for a scene outside the caller's project grants", async () => {
    grants.forUser.mockResolvedValue({ projectIds: [] });
    expect(await enqueue()).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(prisma.audioGenerationOperation.create).not.toHaveBeenCalled();
  });

  it("generateForWorkflowRun synchronously persists audio+subtitle without touching the durable queue (VE2E-06 orchestrator path)", async () => {
    const outcome = await service.generateForWorkflowRun(sceneId, userId, "staff", { providerAccountId: "account-1", voiceId: "voice-1" });
    expect(outcome).toMatchObject({ ok: true, data: { status: "current", mediaAssetVersionId: "asset-1" } });
    expect(elevenLabs.generateTts).toHaveBeenCalledWith("account-1", userId, "staff", { projectId, voiceId: "voice-1", text: "Xin chao" });
    expect(prisma.audioGenerationOperation.create).not.toHaveBeenCalled();
    expect(audioRows).toHaveLength(1);
  });

  it("generateForWorkflowRun rejects an unverified provider account without calling ElevenLabs", async () => {
    prisma.providerAccount.findFirst = vi.fn(async () => ({ id: "account-1", provider: "elevenlabs", role: "tts", scope: "organization", ownerUserId: null, status: "unverified", isFake: false }));
    const outcome = await service.generateForWorkflowRun(sceneId, userId, "staff", { providerAccountId: "account-1", voiceId: "voice-1" });
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    expect(elevenLabs.generateTts).not.toHaveBeenCalled();
  });

  it("lists current and stale audio versions newest-first with their subtitle", async () => {
    await enqueue(key, "voice-1"); await service.processNext();
    await enqueue("audio-request-0002", "voice-2"); await service.processNext();
    const outcome = await service.list(sceneId, userId, "staff");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toHaveLength(2);
    expect(outcome.data[0]!.version).toBe(2);
    expect(outcome.data[0]!.status).toBe("current");
    expect(outcome.data[1]!.status).toBe("stale");
  });
});
