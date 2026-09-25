/**
 * VE2E-07: bootstraps Studio for a legacy job. All current web UI (JobPage/StudioProPage,
 * per VE2E-06's own trigger note) only ever talks to the legacy `ProductionRequest`/
 * `ScriptVersion` API (I03-03/V00-04) - none of it calls the VE2E-00..05 Project/
 * SourceVersion/ScriptDraftVersion domain that Pexels media, ElevenLabs audio and
 * Creatomate render/template are all scoped to. This service is the one-time bridge: the
 * first time a job's Studio is opened, it provisions a real `Project` +
 * `SourceVersion(raw_script)` + already-approved `ScriptDraftVersion`/`SceneDraftVersion`
 * rows mirroring the job's own approved script, recorded in `StudioProjectBridge` so every
 * later open just looks the same rows back up (idempotent, never resynced).
 *
 * Deliberately bypasses `ProjectsService.create()` (which requires `canManageProject`,
 * i.e. admin-only) - provisioning one job-scoped Studio project for a job the caller
 * already owns/has grant access to is a different, narrower operation than the general
 * "create an arbitrary project" surface, so it writes directly via Prisma + grants the job
 * owner access the same way `ProjectsService.create()` does internally
 * (`GrantsService.replaceProjectGrants`).
 */
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import type { ErrorCode, StudioContextResponse } from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { JobsService, type JobRecord } from "./jobs.service.js";
import { PrismaService } from "./prisma.service.js";
import { toTimelineVersionResponse } from "./timeline-versions.service.js";

export type StudioBridgeOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number };

@Injectable()
export class StudioBridgeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  async ensureContext(jobId: string, userId: string, role: "admin" | "staff"): Promise<StudioBridgeOutcome<StudioContextResponse>> {
    const job = await this.jobs.get(jobId, userId, role);
    if (!job) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy job", status: 404 };
    if (job.script.approvedVersion === null) {
      return { ok: false, code: "INVALID_STATE", message: "Cần duyệt kịch bản trước khi mở Studio", status: 409 };
    }

    const existing = await this.prisma.studioProjectBridge.findUnique({ where: { productionRequestId: jobId } });
    if (existing) return this.buildContext(job, existing);

    const bridge = await this.createBridge(job, userId);
    return this.buildContext(job, bridge);
  }

  private async createBridge(job: JobRecord, userId: string) {
    const account = await this.prisma.providerAccount.findUnique({ where: { id: job.contentProviderAccountId } });
    const provider = account?.provider ?? "unknown";

    const project = await this.prisma.project.create({
      data: { name: `Studio · ${job.code}`, description: job.topic, createdByUserId: userId },
    });
    await this.grants.replaceProjectGrants(project.id, [], [userId]);

    const rawText = [job.script.hook, job.script.body, job.script.cta].filter(Boolean).join("\n\n");
    const source = await this.prisma.sourceVersion.create({
      data: {
        projectId: project.id,
        type: "raw_script",
        rawText,
        extractedText: rawText,
        checksumSha256: createHash("sha256").update(rawText).digest("hex"),
        fetchStatus: "extracted",
        createdByUserId: userId,
        approvedAt: new Date(),
      },
    });

    const scriptDraft = await this.prisma.scriptDraftVersion.create({
      data: {
        sourceVersionId: source.id,
        version: 1,
        status: "approved",
        schemaVersion: "studio-bridge-v1",
        language: job.locale,
        title: job.script.title,
        hook: job.script.hook,
        body: job.script.body,
        cta: job.script.cta,
        caption: job.script.caption,
        providerPin: {
          accountId: job.contentProviderAccountId,
          provider,
          modelId: job.model,
          configVersion: job.providerConfigVersion,
          promptTemplateVersion: job.promptTemplateVersion,
        } as unknown as Prisma.InputJsonValue,
        createdByUserId: userId,
        approvedAt: new Date(),
        scenes: {
          create: job.script.scenes.map((scene, index) => ({
            sceneId: scene.sceneId,
            orderIndex: index,
            narration: scene.narration,
            screenText: scene.screenText,
            visualQuery: scene.visualBrief,
            durationHintMs: scene.estimatedDurationMs ?? 5000,
          })),
        },
      },
    });

    try {
      return await this.prisma.studioProjectBridge.create({
        data: { productionRequestId: job.id, projectId: project.id, sourceVersionId: source.id, scriptDraftVersionId: scriptDraft.id },
      });
    } catch (error) {
      // A concurrent first-open of the same job's Studio may race here - the loser's own
      // Project/SourceVersion/ScriptDraftVersion rows are simply orphaned (harmless, no
      // secret/cost involved) and it uses the winner's bridge instead of erroring.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await this.prisma.studioProjectBridge.findUnique({ where: { productionRequestId: job.id } });
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async buildContext(job: JobRecord, bridge: { projectId: string; sourceVersionId: string; scriptDraftVersionId: string }): Promise<StudioBridgeOutcome<StudioContextResponse>> {
    const [scenes, latestTimeline] = await Promise.all([
      this.prisma.sceneDraftVersion.findMany({ where: { scriptDraftVersionId: bridge.scriptDraftVersionId }, orderBy: { orderIndex: "asc" } }),
      this.prisma.timelineVersion.findFirst({ where: { projectId: bridge.projectId }, orderBy: { version: "desc" } }),
    ]);
    return {
      ok: true,
      data: {
        jobId: job.id,
        projectId: bridge.projectId,
        sourceVersionId: bridge.sourceVersionId,
        scriptDraftVersionId: bridge.scriptDraftVersionId,
        scenes: scenes.map((scene) => ({
          id: scene.id,
          sceneId: scene.sceneId,
          orderIndex: scene.orderIndex,
          narration: scene.narration,
          screenText: scene.screenText,
          visualQuery: scene.visualQuery,
          durationHintMs: scene.durationHintMs,
        })),
        latestTimelineVersion: latestTimeline ? toTimelineVersionResponse(latestTimeline) : null,
      },
    };
  }
}
