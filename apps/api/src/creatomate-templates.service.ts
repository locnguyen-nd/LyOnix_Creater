/**
 * VE2E-05: real Creatomate template catalog/detail + immutable snapshot pinning.
 * Listing/detail are thin, always-live proxies over the Creatomate template API (no
 * caching — a stale cached template list is exactly what pinning a snapshot exists to
 * avoid). `snapshot()` is the only place a template's shape is ever persisted, and
 * once written a `TemplateSnapshot` row is never updated in place — a render always
 * replays against the exact template the user saw when they chose it, even if the
 * live Creatomate template is edited afterwards.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Prisma } from "@lyonix/db";
import { captionDefaultsFromRecipeCaptions, type CaptionTemplateDefaults } from "@lyonix/domain";
import {
  ProviderError,
  captionDefaultsFromCreatomateTemplate,
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
import { RELEASED_RECIPES, recipeRegistry } from "@lyonix/render-recipes";
import { PrismaService } from "./prisma.service.js";
import { LYONIX_PROVIDER, RenderEngineStoreService, recipeExternalId } from "./render-engine-store.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { MediaJobsGateway, type VideoComposer } from "./media-jobs.gateway.js";
import { checkTemplateRenderable, internalReadiness, type ReadinessDeps, type TemplateRenderCheck } from "./template-readiness.js";

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

/**
 * VE2E-93: the template's own caption style for Studio's text style panel and preview - LyOnix: the pinned recipe's captions; Creatomate:
 * the caption element the dynamic composition lifts its style from. Orshot (no caption style is applied) or an underivable template: none.
 */
const captionStyleDefaultsFor = (engine: string | undefined, rawTemplate: unknown): CaptionTemplateDefaults | null => {
  try {
    if (engine === "orshot") return null;
    if (engine === "lyonix") {
      const raw = rawTemplate as { id?: unknown; version?: unknown } | null;
      const recipe = typeof raw?.id === "string" && typeof raw.version === "number" ? recipeRegistry.get(raw.id, raw.version) : null;
      return recipe ? captionDefaultsFromRecipeCaptions(recipe.captions) : null;
    }
    return captionDefaultsFromCreatomateTemplate(rawTemplate);
  } catch {
    return null;
  }
};

const toSnapshotResponse = (row: {
  id: string; externalTemplateId: string; name: string; previewUrl: string | null; modifications: unknown; capturedAt: Date; rawTemplate?: unknown;
  engine?: string; rolloutPercent?: number; fallbackSnapshotIds?: unknown; providerAccountId?: string;
}): TemplateSnapshotResponse => {
  const slots = Array.isArray(row.modifications) ? (row.modifications as TemplateSnapshotResponse["modifications"]) : [];
  const warnings = templateTtsWarnings(row.rawTemplate);
  const captionStyleDefaults = captionStyleDefaultsFor(row.engine, row.rawTemplate);
  return {
  id: row.id,
  externalTemplateId: row.externalTemplateId,
  name: row.name,
  previewUrl: row.previewUrl,
  modifications: slotsWithTtsProvider(slots, row.rawTemplate),
  capturedAt: row.capturedAt.toISOString(),
  ...(row.providerAccountId ? { providerAccountId: row.providerAccountId } : {}),
  ...(row.engine ? { engine: row.engine as RenderEngine, rolloutPercent: row.rolloutPercent ?? 0, fallbackSnapshotIds: Array.isArray(row.fallbackSnapshotIds) ? row.fallbackSnapshotIds.filter((id): id is string => typeof id === "string") : [] } : {}),
  ...(warnings.length > 0 ? { warnings } : {}),
  ...(captionStyleDefaults ? { captionStyleDefaults } : {}),
  };
};

@Injectable()
export class CreatomateTemplatesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // VE2E-111: optional so provider-only unit tests keep constructing the service with one argument.
    @Optional() @Inject(RenderEngineStoreService) private readonly engineStore?: RenderEngineStoreService,
    // V04-01: optional - only used to tell whether the internal engine is running (Auto submit preflight).
    @Optional() @Inject(MediaJobsGateway) private readonly composer?: VideoComposer,
  ) {}

  /** V04-01: dependencies of the shared readiness check (template-readiness.ts). */
  readinessDeps(): ReadinessDeps {
    return { prisma: this.prisma, usableAccount: (id) => this.usableAccount(id), ...(this.composer ? { renderQueueStatus: () => this.composer!.renderQueueStatus() } : {}) };
  }

  /**
   * V04-01: THE check before a pinned template is used with a render account - same rule for Auto (setup / submit) and Studio (apply,
   * render). Unknown snapshot = NOT_FOUND; otherwise see `checkTemplateRenderable`.
   */
  async checkRenderable(templateSnapshotId: string, providerAccountId: string, options: { checkEngine: boolean }): Promise<TemplateRenderCheck | { ok: false; code: "NOT_FOUND"; message: string; status: 404 }> {
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: templateSnapshotId } });
    if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };
    return checkTemplateRenderable(this.readinessDeps(), { snapshot, providerAccountId, checkEngine: options.checkEngine });
  }

  /** VE2E-111: is this the internal engine's system account? (No secret, no network: its templates are the repo's released recipes.) */
  private async isInternalAccount(providerAccountId: string): Promise<boolean> {
    const row = await this.prisma.providerAccount.findFirst({ where: { id: providerAccountId, deletedAt: null }, select: { provider: true } });
    return row?.provider === LYONIX_PROVIDER;
  }

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
    if (await this.isInternalAccount(providerAccountId)) {
      // V04-01: each internal template says whether it can be applied / rendered now (rollout + fallback of its pinned snapshot).
      const pinned = await this.prisma.templateSnapshot.findMany({ where: { providerAccountId, engine: LYONIX_PROVIDER }, select: { externalTemplateId: true, rolloutPercent: true, fallbackSnapshotIds: true } });
      const deps = this.readinessDeps();
      const data: CreatomateTemplateSummaryResponse[] = [];
      for (const recipe of RELEASED_RECIPES) {
        const externalTemplateId = recipeExternalId(recipe);
        const row = pinned.find((candidate) => candidate.externalTemplateId === externalTemplateId);
        const readiness = row ? await internalReadiness(deps, row, { checkEngine: false }) : ({ ready: false, reason: "rollout_off" } as const);
        data.push({
          externalTemplateId,
          name: recipe.name,
          previewUrl: null,
          tags: ["lyonix", `v${recipe.version}`],
          internalRender: readiness.ready
            ? { ready: true, reason: null, rolloutPercent: row?.rolloutPercent ?? 0, hasFallback: readiness.hasFallback }
            : { ready: false, reason: readiness.reason === "no_fallback" ? "no_fallback" : "rollout_off", rolloutPercent: row?.rolloutPercent ?? 0, hasFallback: false },
        });
      }
      return { ok: true, data };
    }
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
    if (await this.isInternalAccount(providerAccountId)) {
      // Internal templates are pinned by the API itself (immutable recipe versions); "snapshotting" one just returns that pinned row.
      if (!RELEASED_RECIPES.some((recipe) => recipeExternalId(recipe) === externalTemplateId)) return { ok: false, code: "NOT_FOUND", message: "Không có mẫu nội bộ này", status: 404 };
      let row = await this.prisma.templateSnapshot.findFirst({ where: { providerAccountId, externalTemplateId } });
      if (!row && this.engineStore) {
        await this.engineStore.sync();
        row = await this.prisma.templateSnapshot.findFirst({ where: { providerAccountId, externalTemplateId } });
      }
      if (!row) return { ok: false, code: "NOT_FOUND", message: "Mẫu nội bộ chưa được nạp vào kho mẫu", status: 404 };
      // V04-01: applying a template that cannot render is refused here, for Studio and Auto alike (preview stays possible).
      const renderable = await checkTemplateRenderable(this.readinessDeps(), { snapshot: row, providerAccountId, checkEngine: false });
      if (!renderable.ok) return { ok: false, code: renderable.code, message: renderable.message, status: renderable.status };
      return { ok: true, data: toSnapshotResponse(row) };
    }
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
