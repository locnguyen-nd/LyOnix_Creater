import { internalTemplateReadiness, type InternalTemplateReadiness } from "@lyonix/domain";
import type { RenderEngine, TemplateRenderBlockReason } from "@lyonix/contracts";
import type { PrismaService } from "./prisma.service.js";

/**
 * V04-01: the ONE "can this template be applied / rendered now?" check, shared by Auto and Studio. It runs before anything is created
 * or started, so a template that cannot render is never discovered at the render step after script / TTS / media already ran:
 *  - template list (internal templates carry their readiness),
 *  - apply = pin a snapshot (`CreatomateTemplatesService.snapshot`, Studio "Dùng template" / Orshot panel / Auto intake),
 *  - Auto `setupAutoProfile` (before the project exists) and `submit` (before the source / run exist),
 *  - render enqueue of the internal engine (Studio and the Auto render step, before the RenderJob exists).
 * The rollout rule itself is the pure `internalTemplateReadiness` (packages/domain/render-router.ts).
 */

export const TEMPLATE_BLOCK_MESSAGES: Readonly<Record<TemplateRenderBlockReason, string>> = {
  incompatible_account: "Template này không tương thích với tài khoản render đang chọn. Vui lòng chọn template hoặc render provider khác.",
  account_unusable: "Tài khoản render của template này chưa sẵn sàng (không tồn tại hoặc chưa verify). Vui lòng chọn template hoặc render provider khác.",
  rollout_off: "Template này chưa sẵn sàng render: engine LyOnix chưa được admin bật cho template này (rollout 0 %). Vui lòng chọn template khác hoặc nhờ admin bật render.",
  no_fallback: "Template này chưa sẵn sàng render: rollout một phần cần mẫu provider dự phòng nhưng chưa có mẫu dự phòng dùng được.",
  engine_unavailable: "Engine LyOnix Render đang không hoạt động và template này không có mẫu dự phòng. Vui lòng thử lại sau hoặc chọn template khác.",
};

export type ReadinessSnapshot = { id: string; engine?: string | null; providerAccountId: string; rolloutPercent?: number | null; fallbackSnapshotIds?: unknown };

export type ReadinessDeps = {
  prisma: Pick<PrismaService, "templateSnapshot">;
  /** Is a provider (Creatomate / Orshot) account usable? Same check as the render path (`CreatomateTemplatesService.usableAccount`). */
  usableAccount: (providerAccountId: string) => Promise<{ ok: boolean }>;
  /** Internal engine queue status (`consumers: 0` / `null` = not running). Omitted = the engine cannot be checked here. */
  renderQueueStatus?: () => Promise<{ consumers: number } | null>;
};

export type TemplateRenderCheck =
  | { ok: true; engine: RenderEngine; hasFallback: boolean }
  | { ok: false; code: "VALIDATION_FAILED"; message: string; reason: TemplateRenderBlockReason; status: 400 };

const idList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);

/** Provider snapshots usable as fallback of an internal template, in order. v1 falls back through the dynamic Creatomate composition only. */
export async function usableFallbackSnapshotIds(deps: ReadinessDeps, snapshot: Pick<ReadinessSnapshot, "fallbackSnapshotIds">): Promise<string[]> {
  const ids = idList(snapshot.fallbackSnapshotIds);
  if (ids.length === 0) return [];
  const rows = await deps.prisma.templateSnapshot.findMany({ where: { id: { in: ids } }, select: { id: true, engine: true, providerAccountId: true } });
  const usable: string[] = [];
  for (const id of ids) {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row || row.engine !== "creatomate") continue;
    if ((await deps.usableAccount(row.providerAccountId)).ok) usable.push(row.id);
  }
  return usable;
}

/** Rollout + fallback (+ engine running, when asked and only if nothing could take over) of an internal template. */
export async function internalReadiness(deps: ReadinessDeps, snapshot: Pick<ReadinessSnapshot, "rolloutPercent" | "fallbackSnapshotIds">, options: { checkEngine: boolean }): Promise<InternalTemplateReadiness> {
  const rolloutPercent = snapshot.rolloutPercent ?? 0;
  const usableFallbackCount = rolloutPercent > 0 ? (await usableFallbackSnapshotIds(deps, snapshot)).length : 0;
  let engineAvailable: boolean | undefined;
  if (options.checkEngine && deps.renderQueueStatus && rolloutPercent > 0 && usableFallbackCount === 0) engineAvailable = ((await deps.renderQueueStatus())?.consumers ?? 0) > 0;
  return internalTemplateReadiness({ rolloutPercent, usableFallbackCount, ...(engineAvailable === undefined ? {} : { engineAvailable }) });
}

/**
 * Can `snapshot` be applied / rendered with the render account `providerAccountId`? `checkEngine` also requires a running internal
 * engine when no fallback could take over (render time and Auto submit; not when merely applying a template).
 */
export async function checkTemplateRenderable(deps: ReadinessDeps, input: { snapshot: ReadinessSnapshot; providerAccountId: string; checkEngine: boolean }): Promise<TemplateRenderCheck> {
  const block = (reason: TemplateRenderBlockReason): TemplateRenderCheck => ({ ok: false, code: "VALIDATION_FAILED", message: TEMPLATE_BLOCK_MESSAGES[reason], reason, status: 400 });
  if (input.snapshot.providerAccountId !== input.providerAccountId) return block("incompatible_account");
  const engine = (input.snapshot.engine ?? "creatomate") as RenderEngine;
  if (engine !== "lyonix") return (await deps.usableAccount(input.providerAccountId)).ok ? { ok: true, engine, hasFallback: false } : block("account_unusable");
  const readiness = await internalReadiness(deps, input.snapshot, { checkEngine: input.checkEngine });
  return readiness.ready ? { ok: true, engine, hasFallback: readiness.hasFallback } : block(readiness.reason);
}
