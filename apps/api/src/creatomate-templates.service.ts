/**
 * VE2E-05: real Creatomate template catalog/detail + immutable snapshot pinning.
 * Listing/detail are thin, always-live proxies over the Creatomate template API (no
 * caching — a stale cached template list is exactly what pinning a snapshot exists to
 * avoid). `snapshot()` is the only place a template's shape is ever persisted, and
 * once written a `TemplateSnapshot` row is never updated in place — a render always
 * replays against the exact template the user saw when they chose it, even if the
 * live Creatomate template is edited afterwards.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@lyonix/db";
import {
  ProviderError,
  deriveTemplateModifications,
  deriveOrshotModifications,
  getCreatomateTemplate,
  getOrshotTemplate,
  listCreatomateTemplates,
  listOrshotTemplates,
  type TemplateModificationSlot,
} from "@lyonix/providers";
import type { CreatomateTemplateSummaryResponse, ErrorCode, RenderEngine, TemplateSnapshotResponse } from "@lyonix/contracts";
import { slotsWithTtsProvider, templateTtsWarnings } from "./template-tts.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret } from "./secret-crypto.js";

export type RenderProviderName = "creatomate" | "orshot";
export const isRenderProvider = (provider: string): provider is RenderProviderName => provider === "creatomate" || provider === "orshot";
const providerLabel = (provider: string) => (provider === "orshot" ? "Orshot" : "Creatomate");

export type CreatomateOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };

const providerErrorMessage = (label: string): Record<string, string> => ({
  PROVIDER_AUTH_INVALID: `Khóa ${label} bị từ chối. Verify lại tài khoản.`,
  PROVIDER_RATE_LIMITED: `${label} giới hạn tốc độ, thử lại sau.`,
  PROVIDER_QUOTA_EXHAUSTED: `Tài khoản ${label} đã hết credit. Nạp thêm credit hoặc đổi gói rồi thử lại.`,
  PROVIDER_CAPABILITY_UNAVAILABLE: `${label} không tìm thấy template này.`,
  PROVIDER_TIMEOUT: `Yêu cầu ${label} hết thời gian chờ.`,
  PROVIDER_SCHEMA_INVALID: `${label} trả về dữ liệu không hợp lệ.`,
});

const mapProviderError = (error: unknown, provider: string = "creatomate"): { code: ErrorCode; message: string; status: number; retryable: boolean } => {
  const label = providerLabel(provider);
  if (error instanceof ProviderError) {
    const switchable = error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_AUTH_INVALID";
    return { code: error.code, message: providerErrorMessage(label)[error.code] ?? `${label} từ chối yêu cầu (${error.message})`, status: switchable ? 429 : 502, retryable: error.retryable };
  }
  return { code: "PROVIDER_UNAVAILABLE", message: `Lỗi mạng hoặc timeout khi gọi ${label}`, status: 502, retryable: true };
};

const toSlotResponse = (slot: TemplateModificationSlot) => ({ key: slot.key, kind: slot.kind, label: slot.label, required: slot.required, ...(slot.ttsProvider ? { ttsProvider: slot.ttsProvider } : {}) });

const toSnapshotResponse = (row: {
  id: string; externalTemplateId: string; name: string; previewUrl: string | null; modifications: unknown; capturedAt: Date; rawTemplate?: unknown;
  engine?: string; rolloutPercent?: number; fallbackSnapshotIds?: unknown;
}): TemplateSnapshotResponse => {
  const slots = Array.isArray(row.modifications) ? (row.modifications as TemplateSnapshotResponse["modifications"]) : [];
  const warnings = templateTtsWarnings(row.rawTemplate);
  return {
  id: row.id,
  externalTemplateId: row.externalTemplateId,
  name: row.name,
  previewUrl: row.previewUrl,
  modifications: slotsWithTtsProvider(slots, row.rawTemplate),
  capturedAt: row.capturedAt.toISOString(),
  ...(row.engine ? { engine: row.engine as RenderEngine, rolloutPercent: row.rolloutPercent ?? 0, fallbackSnapshotIds: Array.isArray(row.fallbackSnapshotIds) ? row.fallbackSnapshotIds.filter((id): id is string => typeof id === "string") : [] } : {}),
  ...(warnings.length > 0 ? { warnings } : {}),
  };
};

@Injectable()
export class CreatomateTemplatesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Any non-deleted `creatomate`|`orshot` / `render` account, verified (or fake in test) — same authorization shape as `PexelsService.usableAccount`. */
  async usableAccount(providerAccountId: string): Promise<CreatomateOutcome<{ id: string; encryptedSecret: string; provider: RenderProviderName }>> {
    const account = await this.prisma.providerAccount.findFirst({ where: { id: providerAccountId, deletedAt: null } });
    if (!account) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản provider không tồn tại hoặc đã bị xóa", status: 503 };
    if (account.role !== "render" || !isRenderProvider(account.provider)) {
      return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Tài khoản không phải provider render (Creatomate/Orshot)", status: 503 };
    }
    const usable = account.isFake ? process.env.NODE_ENV === "test" : account.status === "verified";
    if (!usable) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: `Tài khoản ${account.provider === "orshot" ? "Orshot" : "Creatomate"} chưa verify`, status: 503 };
    return { ok: true, data: { id: account.id, encryptedSecret: account.encryptedSecret, provider: account.provider } };
  }

  async listTemplates(providerAccountId: string): Promise<CreatomateOutcome<CreatomateTemplateSummaryResponse[]>> {
    const account = await this.usableAccount(providerAccountId);
    if (!account.ok) return account;
    try {
      const secret = decryptSecret(account.data.encryptedSecret);
      const templates = account.data.provider === "orshot" ? await listOrshotTemplates(secret) : await listCreatomateTemplates(secret);
      return { ok: true, data: templates };
    } catch (error) {
      return { ok: false, ...mapProviderError(error, account.data.provider) };
    }
  }

  /**
   * Pins an immutable snapshot of one Creatomate template: re-fetches the template
   * detail live (never trusts a client-supplied template shape), derives the
   * whitelisted modification slots from its element tree, and persists both —
   * `snapshot.id` (not the raw `externalTemplateId`) is what a render submission
   * must reference from then on.
   */
  async snapshot(providerAccountId: string, externalTemplateId: string, userId: string): Promise<CreatomateOutcome<TemplateSnapshotResponse>> {
    const account = await this.usableAccount(providerAccountId);
    if (!account.ok) return account;
    if (!externalTemplateId.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu externalTemplateId" };
    let detail: Awaited<ReturnType<typeof getCreatomateTemplate>>;
    try {
      const secret = decryptSecret(account.data.encryptedSecret);
      detail = account.data.provider === "orshot" ? await getOrshotTemplate(secret, externalTemplateId) : await getCreatomateTemplate(secret, externalTemplateId);
    } catch (error) {
      return { ok: false, ...mapProviderError(error, account.data.provider) };
    }
    const modifications = account.data.provider === "orshot" ? deriveOrshotModifications(detail.source) : deriveTemplateModifications(detail.source);
    if (modifications.length === 0) {
      return { ok: false, code: "PROVIDER_SCHEMA_INVALID", message: "Không suy ra được modification nào từ template này", status: 502 };
    }
    const row = await this.prisma.templateSnapshot.create({
      data: {
        providerAccountId,
        externalTemplateId: detail.externalTemplateId,
        name: detail.name,
        previewUrl: detail.previewUrl,
        modifications: modifications.map(toSlotResponse) as unknown as Prisma.InputJsonValue,
        rawTemplate: (detail.source ?? {}) as Prisma.InputJsonValue,
        createdByUserId: userId,
      },
    });
    return { ok: true, data: toSnapshotResponse(row) };
  }

  async getSnapshot(id: string): Promise<CreatomateOutcome<TemplateSnapshotResponse>> {
    const row = await this.prisma.templateSnapshot.findUnique({ where: { id } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };
    return { ok: true, data: toSnapshotResponse(row) };
  }
}
