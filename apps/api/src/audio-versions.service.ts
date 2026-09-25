/**
 * VE2E-03: generates real ElevenLabs TTS-with-timestamps audio for one
 * `SceneDraftVersion` (reusing `ElevenLabsVoiceService.generateTts` from VE2E-02 —
 * validated audio + registered `MediaAssetVersion`, no second storage path) and
 * persists it as a versioned `AudioVersion` + auto-derived `SubtitleVersion` (timed
 * captions built from the real character alignment via
 * `buildCaptionSegmentsFromAlignment`, never invented timing). Regenerating audio for
 * the same scene creates a new version and flips the previous `current` audio+subtitle
 * to `stale`.
 */
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { buildCaptionSegmentsFromAlignment, canAccessProject } from "@lyonix/domain";
import type { AudioVersionResponse, CaptionSegmentResponse, ErrorCode, SubtitleVersionResponse, TtsAlignmentResponse } from "@lyonix/contracts";
import { ElevenLabsVoiceService } from "./elevenlabs-voice.service.js";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";

export type AudioVersionOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };
export type AudioGenerationAccepted = { operationId: string; status: "queued" | "processing" | "completed" | "failed" | "unknown"; errorCode?: string };

const normalizeText = (value: string) => value.trim().replace(/\s+/g, " ");
const textChecksum = (value: string) => createHash("sha256").update(normalizeText(value)).digest("hex");
const requestFingerprint = (input: { sceneDraftVersionId: string; providerAccountId: string; voiceId: string; modelId?: string; narration: string }) =>
  createHash("sha256").update(JSON.stringify({ ...input, narration: normalizeText(input.narration) })).digest("hex");

const toSubtitleResponse = (row: {
  id: string; audioVersionId: string; version: number; status: string; source: string; segments: unknown; staleReason: string | null; createdAt: Date;
}): SubtitleVersionResponse => ({
  id: row.id,
  audioVersionId: row.audioVersionId,
  version: row.version,
  status: row.status as SubtitleVersionResponse["status"],
  source: row.source,
  segments: (Array.isArray(row.segments) ? row.segments : []) as CaptionSegmentResponse[],
  staleReason: row.staleReason,
  createdAt: row.createdAt.toISOString(),
});

const toAudioResponse = (
  row: {
    id: string; sceneDraftVersionId: string; version: number; status: string; providerAccountId: string; provider: string;
    externalVoiceId: string; modelId: string; mediaAssetVersionId: string; durationMs: number; alignment: unknown; staleReason: string | null; createdAt: Date;
  },
  subtitle: Parameters<typeof toSubtitleResponse>[0] | null,
): AudioVersionResponse => ({
  id: row.id,
  sceneDraftVersionId: row.sceneDraftVersionId,
  version: row.version,
  status: row.status as AudioVersionResponse["status"],
  providerAccountId: row.providerAccountId,
  provider: row.provider,
  externalVoiceId: row.externalVoiceId,
  modelId: row.modelId,
  mediaAssetVersionId: row.mediaAssetVersionId,
  durationMs: row.durationMs,
  alignment: row.alignment as TtsAlignmentResponse,
  staleReason: row.staleReason,
  createdAt: row.createdAt.toISOString(),
  subtitleVersion: subtitle ? toSubtitleResponse(subtitle) : null,
});

@Injectable()
export class AudioVersionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(ElevenLabsVoiceService) private readonly elevenLabs: ElevenLabsVoiceService,
  ) {}

  private async loadSceneWithAccess(sceneDraftVersionId: string, userId: string, role: "admin" | "staff") {
    const scene = await this.prisma.sceneDraftVersion.findUnique({
      where: { id: sceneDraftVersionId },
      include: { scriptDraftVersion: { include: { sourceVersion: true } } },
    });
    if (!scene) return null;
    const projectId = scene.scriptDraftVersion.sourceVersion.projectId;
    const grants = await this.grants.forUser(userId, role);
    if (!canAccessProject(role, grants, projectId)) return "forbidden" as const;
    return { scene, projectId };
  }

  /** Any non-deleted `elevenlabs`/`tts` account this user/role may use — shared by `generate()` and `generateForWorkflowRun()`. */
  private async resolveTtsAccount(providerAccountId: string, userId: string, role: "admin" | "staff"): Promise<AudioVersionOutcome<true>> {
    const account = await this.prisma.providerAccount.findFirst({ where: { id: providerAccountId, deletedAt: null } });
    if (!account || account.provider !== "elevenlabs" || account.role !== "tts") return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản ElevenLabs TTS không tồn tại", status: 404 };
    if (role !== "admin" && account.scope === "personal" && account.ownerUserId !== userId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy tài khoản provider", status: 404 };
    if (account.isFake ? process.env.NODE_ENV !== "test" : account.status !== "verified") return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản ElevenLabs chưa verify", status: 503 };
    return { ok: true, data: true };
  }

  /**
   * Shared generate-via-ElevenLabs + persist-as-new-`AudioVersion`/`SubtitleVersion`
   * logic, used by both `processNext()` (HTTP client queue path) and
   * `generateForWorkflowRun()` (trusted background orchestrator path, VE2E-06).
   * Flips the scene's previous `current` audio/subtitle to `stale` exactly like the
   * original inline implementation did.
   */
  private async synthesizeAndPersist(input: {
    sceneDraftVersionId: string;
    narration: string;
    projectId: string;
    providerAccountId: string;
    voiceId: string;
    modelId?: string;
    userId: string;
    role: "admin" | "staff";
  }): Promise<AudioVersionOutcome<AudioVersionResponse>> {
    const synthesis = await this.elevenLabs.generateTts(input.providerAccountId, input.userId, input.role, {
      projectId: input.projectId,
      voiceId: input.voiceId,
      text: input.narration,
      ...(input.modelId ? { modelId: input.modelId } : {}),
    });
    if (!synthesis.ok) return synthesis;
    const segments = buildCaptionSegmentsFromAlignment(synthesis.data.alignment);
    const result = await this.prisma.$transaction(async (tx) => {
      const previousCurrent = await tx.audioVersion.findFirst({ where: { sceneDraftVersionId: input.sceneDraftVersionId, status: "current" }, orderBy: { version: "desc" } });
      const latest = await tx.audioVersion.findFirst({ where: { sceneDraftVersionId: input.sceneDraftVersionId }, orderBy: { version: "desc" } });
      const created = await tx.audioVersion.create({
        data: {
          sceneDraftVersionId: input.sceneDraftVersionId,
          version: (latest?.version ?? 0) + 1,
          status: "current",
          providerAccountId: input.providerAccountId,
          provider: "elevenlabs",
          externalVoiceId: input.voiceId,
          modelId: synthesis.data.providerPin.modelId,
          textChecksumSha256: textChecksum(input.narration),
          mediaAssetVersionId: synthesis.data.asset.id,
          durationMs: synthesis.data.durationMs,
          alignment: synthesis.data.alignment as unknown as object,
          supersedesId: previousCurrent?.id ?? null,
          createdByUserId: input.userId,
        },
      });
      if (previousCurrent) {
        const staleAt = new Date();
        await tx.audioVersion.updateMany({ where: { id: previousCurrent.id, status: "current" }, data: { status: "stale", staleAt, staleReason: "regenerated" } });
        await tx.subtitleVersion.updateMany({ where: { audioVersionId: previousCurrent.id, status: "current" }, data: { status: "stale", staleAt, staleReason: "regenerated" } });
      }
      const subtitle = await tx.subtitleVersion.create({
        data: {
          audioVersionId: created.id,
          version: 1,
          status: "current",
          source: "elevenlabs_alignment",
          segments: segments as unknown as object,
          createdByUserId: input.userId,
        },
      });
      return { created, subtitle };
    });
    return { ok: true, data: toAudioResponse(result.created, result.subtitle) };
  }

  /**
   * Orchestrator-only synchronous generate+persist for one scene (VE2E-06). Auto mode
   * has no human clicking "generate audio" per scene, and this runs inside the
   * background `WorkflowRunnerService` process, not an HTTP request handler, so
   * blocking on the provider call here does not violate "API không chờ provider
   * trong request HTTP". Deliberately bypasses the `AudioGenerationOperation` durable
   * queue: that queue exists to protect an HTTP client's own accidental double-submit
   * under an `Idempotency-Key` contract, which does not apply to a single trusted
   * background caller advancing one `WorkflowRun` at a time. NOT exposed over HTTP.
   */
  async generateForWorkflowRun(
    sceneDraftVersionId: string,
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; voiceId: string; modelId?: string },
  ): Promise<AudioVersionOutcome<AudioVersionResponse>> {
    const loaded = await this.loadSceneWithAccess(sceneDraftVersionId, userId, role);
    if (!loaded) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy scene", status: 404 };
    if (loaded === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy scene", status: 404 };
    const { scene, projectId } = loaded;
    if (!scene.narration.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Scene chưa có narration để tạo audio" };
    const account = await this.resolveTtsAccount(input.providerAccountId, userId, role);
    if (!account.ok) return account;
    return this.synthesizeAndPersist({
      sceneDraftVersionId,
      narration: scene.narration,
      projectId,
      providerAccountId: input.providerAccountId,
      voiceId: input.voiceId,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      userId,
      role,
    });
  }

  async list(sceneDraftVersionId: string, userId: string, role: "admin" | "staff"): Promise<AudioVersionOutcome<AudioVersionResponse[]>> {
    const loaded = await this.loadSceneWithAccess(sceneDraftVersionId, userId, role);
    if (!loaded) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy scene", status: 404 };
    if (loaded === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy scene", status: 404 };
    const rows = await this.prisma.audioVersion.findMany({
      where: { sceneDraftVersionId },
      orderBy: { version: "desc" },
      include: { subtitleVersions: { orderBy: { version: "desc" }, take: 1 } },
    });
    return { ok: true, data: rows.map((row) => toAudioResponse(row, row.subtitleVersions[0] ?? null)) };
  }

  /**
   * Generates + persists a new `AudioVersion` (and its `SubtitleVersion`) for one
   * scene. The scene's own `narration` text is always what is sent to ElevenLabs — the
   * caller only picks the voice/provider account, never arbitrary text, so the
   * persisted audio always matches the pinned script.
   */
  async generate(
    sceneDraftVersionId: string,
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; voiceId: string; modelId?: string; idempotencyKey: string },
  ): Promise<AudioVersionOutcome<AudioGenerationAccepted>> {
    const loaded = await this.loadSceneWithAccess(sceneDraftVersionId, userId, role);
    if (!loaded) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy scene", status: 404 };
    if (loaded === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy scene", status: 404 };
    const { scene, projectId } = loaded;
    if (!scene.narration.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Scene chưa có narration để tạo audio" };
    const account = await this.prisma.providerAccount.findFirst({ where: { id: input.providerAccountId, deletedAt: null } });
    if (!account || account.provider !== "elevenlabs" || account.role !== "tts") return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản ElevenLabs TTS không tồn tại", status: 404 };
    if (role !== "admin" && account.scope === "personal" && account.ownerUserId !== userId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy tài khoản provider", status: 404 };
    if (account.isFake ? process.env.NODE_ENV !== "test" : account.status !== "verified") return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản ElevenLabs chưa verify", status: 503 };
    const key = input.idempotencyKey.trim();
    if (key.length < 8 || key.length > 200) return { ok: false, code: "VALIDATION_FAILED", message: "Idempotency-Key cần từ 8 đến 200 ký tự" };
    const fingerprint = requestFingerprint({ sceneDraftVersionId, providerAccountId: input.providerAccountId, voiceId: input.voiceId, ...(input.modelId ? { modelId: input.modelId } : {}), narration: scene.narration });
    const where = { userId_idempotencyKey: { userId, idempotencyKey: key } };
    let operation = await this.prisma.audioGenerationOperation.findUnique({ where });
    if (operation) {
      if (operation.requestFingerprint !== fingerprint) return { ok: false, code: "VERSION_CONFLICT", message: "Idempotency-Key đã được dùng cho một yêu cầu khác", status: 409 };
      return { ok: true, data: { operationId: operation.id, status: operation.status, ...(operation.errorCode ? { errorCode: operation.errorCode } : {}) } };
    }
    const unresolved = await this.prisma.audioGenerationOperation.findFirst({
      where: { sceneDraftVersionId, status: { in: ["queued", "processing", "unknown"] } },
      orderBy: { createdAt: "desc" },
    });
    if (unresolved) return { ok: true, data: { operationId: unresolved.id, status: unresolved.status, ...(unresolved.errorCode ? { errorCode: unresolved.errorCode } : {}) } };
    try {
      operation = await this.prisma.audioGenerationOperation.create({
        data: {
          userId,
          sceneDraftVersionId,
          providerAccountId: input.providerAccountId,
          voiceId: input.voiceId,
          modelId: input.modelId ?? null,
          idempotencyKey: key,
          requestFingerprint: fingerprint,
          status: "queued",
        },
      });
    } catch (error) {
      // A concurrent retry may win the unique(userId,idempotencyKey) insert.
      const duplicate = await this.prisma.audioGenerationOperation.findUnique({ where });
      if (!duplicate) throw error;
      if (duplicate.requestFingerprint !== fingerprint) return { ok: false, code: "VERSION_CONFLICT", message: "Idempotency-Key đã được dùng cho một yêu cầu khác", status: 409 };
      operation = duplicate;
    }
    return { ok: true, data: { operationId: operation.id, status: operation.status, ...(operation.errorCode ? { errorCode: operation.errorCode } : {}) } };
  }

  /** Atomically claim one DB-backed queue item. Only this worker path performs billable TTS. */
  async processNext(): Promise<boolean> {
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
    await this.prisma.audioGenerationOperation.updateMany({
      where: { status: "processing", startedAt: { lt: staleBefore } },
      data: { status: "unknown", errorCode: "WORKER_OUTCOME_UNKNOWN", completedAt: new Date() },
    });
    const candidate = await this.prisma.audioGenerationOperation.findFirst({ where: { status: "queued" }, orderBy: { createdAt: "asc" } });
    if (!candidate) return false;
    const claimed = await this.prisma.audioGenerationOperation.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "processing", startedAt: new Date() },
    });
    if (claimed.count !== 1) return true;

    try {
      const [scene, user] = await Promise.all([
        this.prisma.sceneDraftVersion.findUnique({ where: { id: candidate.sceneDraftVersionId }, include: { scriptDraftVersion: { include: { sourceVersion: true } } } }),
        this.prisma.user.findUnique({ where: { id: candidate.userId }, select: { id: true, role: true } }),
      ]);
      if (!scene || !user) {
        await this.prisma.audioGenerationOperation.update({ where: { id: candidate.id }, data: { status: "failed", errorCode: "RESOURCE_NOT_FOUND", completedAt: new Date() } });
        return true;
      }
      const projectId = scene.scriptDraftVersion.sourceVersion.projectId;
      const grants = await this.grants.forUser(user.id, user.role);
      const account = await this.prisma.providerAccount.findFirst({ where: { id: candidate.providerAccountId, deletedAt: null } });
      if (!canAccessProject(user.role, grants, projectId) || !account || account.provider !== "elevenlabs" || account.role !== "tts" || (user.role !== "admin" && account.scope === "personal" && account.ownerUserId !== user.id) || (account.isFake ? process.env.NODE_ENV !== "test" : account.status !== "verified")) {
        await this.prisma.audioGenerationOperation.update({ where: { id: candidate.id }, data: { status: "failed", errorCode: "ACCESS_REVOKED", completedAt: new Date() } });
        return true;
      }
      const result = await this.synthesizeAndPersist({
        sceneDraftVersionId: candidate.sceneDraftVersionId,
        narration: scene.narration,
        projectId,
        providerAccountId: candidate.providerAccountId,
        voiceId: candidate.voiceId,
        ...(candidate.modelId ? { modelId: candidate.modelId } : {}),
        userId: user.id,
        role: user.role,
      });
      if (!result.ok) {
        await this.prisma.audioGenerationOperation.update({ where: { id: candidate.id }, data: { status: "failed", errorCode: result.code, completedAt: new Date() } });
        return true;
      }
      await this.prisma.audioGenerationOperation.update({
        where: { id: candidate.id },
        data: { status: "completed", resultAudioVersionId: result.data.id, completedAt: new Date() },
      });
    } catch {
      // Never retry automatically after dispatch: a timeout/crash may hide a successful paid provider call.
      await this.prisma.audioGenerationOperation.updateMany({
        where: { id: candidate.id, status: "processing" },
        data: { status: "unknown", errorCode: "PROVIDER_OUTCOME_UNKNOWN", completedAt: new Date() },
      });
    }
    return true;
  }

  async getOperation(id: string, userId: string, role: "admin" | "staff"): Promise<AudioVersionOutcome<AudioGenerationAccepted & { audioVersion?: AudioVersionResponse }>> {
    const operation = await this.prisma.audioGenerationOperation.findUnique({
      where: { id },
      include: { sceneDraftVersion: { include: { scriptDraftVersion: { include: { sourceVersion: true } } }, }, resultAudioVersion: { include: { subtitleVersions: { orderBy: { version: "desc" }, take: 1 } } } },
    });
    if (!operation) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy yêu cầu audio", status: 404 };
    if (operation.userId !== userId && role !== "admin") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy yêu cầu audio", status: 404 };
    const projectId = operation.sceneDraftVersion.scriptDraftVersion.sourceVersion.projectId;
    const grants = await this.grants.forUser(userId, role);
    if (!canAccessProject(role, grants, projectId)) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy yêu cầu audio", status: 404 };
    const audio = operation.resultAudioVersion;
    return {
      ok: true,
      data: {
        operationId: operation.id,
        status: operation.status,
        ...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
        ...(audio ? { audioVersion: toAudioResponse(audio, audio.subtitleVersions[0] ?? null) } : {}),
      },
    };
  }
}
