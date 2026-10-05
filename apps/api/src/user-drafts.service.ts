/**
 * VE2E-124: the signed-in user's own in-progress form, one per flow (`job_new` = the new-job page). A draft is NOT a job: saving
 * it creates no ProductionRequest/WorkflowRun and calls no provider (no AI, TTS, media or render - no cost). Strictly per user:
 * every query is keyed by the session's userId, there is no way to read or write another user's draft (admin included).
 *
 * Compare-and-set by `version`: a save carries the version it was based on, and a save based on an older version is refused with
 * `VERSION_CONFLICT`, so an autosave that completes late (or another tab) can never overwrite newer state silently.
 * The payload is whitelisted by `@lyonix/domain` creation-form (form values and identifiers only, never a secret).
 */
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import { isCreationFlowType, sanitizeJobNewDraft } from "@lyonix/domain";
import type { CreationFlowType, ErrorCode, UserDraftResponse } from "@lyonix/contracts";
import { PrismaService } from "./prisma.service.js";

export type DraftOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number };

/** Upper bound of a stored draft (the whitelist already caps each field). */
const MAX_PAYLOAD_BYTES = 300_000;

type DraftRow = { flowType: string; payload: unknown; version: number; updatedAt: Date };

const toResponse = (row: DraftRow): UserDraftResponse => ({
  flowType: row.flowType as CreationFlowType,
  payload: sanitizeJobNewDraft(row.payload),
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});

const conflict = (): DraftOutcome<never> => ({ ok: false, code: "VERSION_CONFLICT", message: "Bản nháp đã được lưu ở nơi khác (tab hoặc máy khác).", status: 409 });

@Injectable()
export class UserDraftsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private flow(flowType: string): DraftOutcome<CreationFlowType> {
    return isCreationFlowType(flowType) ? { ok: true, data: flowType } : { ok: false, code: "NOT_FOUND", message: "Không có loại bản nháp này", status: 404 };
  }

  async get(userId: string, flowType: string): Promise<DraftOutcome<UserDraftResponse | null>> {
    const flow = this.flow(flowType);
    if (!flow.ok) return flow;
    const row = await this.prisma.userDraft.findUnique({ where: { userId_flowType: { userId, flowType: flow.data } } });
    return { ok: true, data: row ? toResponse(row) : null };
  }

  async save(userId: string, flowType: string, input: { payload?: unknown; baseVersion?: unknown }): Promise<DraftOutcome<UserDraftResponse>> {
    const flow = this.flow(flowType);
    if (!flow.ok) return flow;
    const baseVersion = input.baseVersion ?? null;
    if (baseVersion !== null && (!Number.isInteger(baseVersion) || (baseVersion as number) < 1)) return { ok: false, code: "VALIDATION_FAILED", message: "baseVersion không hợp lệ", status: 400 };
    const payload = sanitizeJobNewDraft(input.payload);
    if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) return { ok: false, code: "VALIDATION_FAILED", message: "Bản nháp quá lớn", status: 400 };
    const json = payload as Prisma.InputJsonValue;
    const key = { userId_flowType: { userId, flowType: flow.data } };

    if (baseVersion === null) {
      try {
        return { ok: true, data: toResponse(await this.prisma.userDraft.create({ data: { userId, flowType: flow.data, payload: json } })) };
      } catch (error) {
        // A draft already exists (another tab created it first): never overwrite it blindly.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return conflict();
        throw error;
      }
    }
    const updated = await this.prisma.userDraft.updateMany({ where: { userId, flowType: flow.data, version: baseVersion as number }, data: { payload: json, version: { increment: 1 } } });
    if (updated.count !== 1) return conflict();
    const row = await this.prisma.userDraft.findUnique({ where: key });
    return row ? { ok: true, data: toResponse(row) } : conflict();
  }

  /** Idempotent: deleting a draft that does not exist is fine (e.g. after a submit in another tab). */
  async remove(userId: string, flowType: string): Promise<DraftOutcome<{ deleted: boolean }>> {
    const flow = this.flow(flowType);
    if (!flow.ok) return flow;
    const deleted = await this.prisma.userDraft.deleteMany({ where: { userId, flowType: flow.data } });
    return { ok: true, data: { deleted: deleted.count > 0 } };
  }
}
