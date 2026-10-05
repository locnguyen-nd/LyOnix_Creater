import { Inject, Injectable } from "@nestjs/common";
import {
  summarizePreflight,
  isLiveContentKind,
  pickUsableContentModel,
  probeElevenLabsTts,
  probePexelsAccount,
  probeCreatomateAccount,
  probeOrshotAccount,
  ProviderError,
  type PreflightOperationResult,
} from "@lyonix/providers";
import { canAccessProject } from "@lyonix/domain";
import type { Role } from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret } from "./secret-crypto.js";

type AccountRef = { providerAccountId: string; voiceId?: string } | null;

const asAccountRef = (value: unknown): AccountRef => {
  if (!value || typeof value !== "object" || !("providerAccountId" in value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.providerAccountId !== "string" || !record.providerAccountId) return null;
  const voiceId = typeof record.voiceId === "string" && record.voiceId ? record.voiceId : undefined;
  return voiceId ? { providerAccountId: record.providerAccountId, voiceId } : { providerAccountId: record.providerAccountId };
};

export const publicBaseUrlConfigured = () => Boolean(process.env.PUBLIC_BASE_URL?.trim());

type ProviderAccountRow = {
  id: string;
  provider: string;
  role: string;
  model: string;
  status: string;
  isFake: boolean;
  encryptedSecret: string;
  scope: "personal" | "organization";
  ownerUserId: string | null;
};

type ResolvedAccount = { ok: true; account: ProviderAccountRow } | { ok: false; code: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_CAPABILITY_UNAVAILABLE"; detail: string };

export type PreflightOptions = {
  /** Explicit Pexels account to check for the media-import operation. Automation profiles do not yet carry a media provider slot (VE2E-04/VE2E-06 known limitation), so the caller supplies it directly - same account id already accepted by `POST /projects/:id/pexels/import`. */
  pexelsAccountId?: string;
  /** Explicit Creatomate account to check for the render operation, same reasoning as `pexelsAccountId` (VE2E-05/VE2E-06 known limitation). */
  creatomateAccountId?: string;
  /**
   * Run the real, operation-specific (and, for content/TTS, billed) probe instead of only
   * checking the cached `verified` status. Off by default so a routine preflight poll never
   * spends money; callers doing a final pre-submit check (e.g. before an Auto/Studio render)
   * should pass `deep: true`.
   */
  deep?: boolean;
};

@Injectable()
export class ProviderCapabilitiesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  /**
   * Account-backed registry: every preflight decision resolves the live `ProviderAccount` row
   * (status/isFake/secret) from the database at request time. `@lyonix/providers`' compile-time
   * `ProviderRegistry` class is never instantiated in `apps/api` - provider accounts are DB rows
   * created/verified/rotated via `provider-accounts.service.ts`, so that DB is the real registry
   * this preflight is "backed by", not a static in-memory map.
   */
  private async resolveAccount(expectedProvider: string | null, expectedRole: string, accountId: string, userId: string, role: Role): Promise<ResolvedAccount> {
    const account = await this.prisma.providerAccount.findFirst({ where: { id: accountId, deletedAt: null } });
    if (!account) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", detail: "Tài khoản provider không tồn tại hoặc đã bị xóa" };
    if (account.role !== expectedRole) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", detail: "Tài khoản không hỗ trợ thao tác này" };
    if (expectedProvider && account.provider !== expectedProvider) {
      return { ok: false, code: "PROVIDER_NOT_CONFIGURED", detail: `Tài khoản không thuộc provider ${expectedProvider}` };
    }
    if (role !== "admin" && account.scope === "personal" && account.ownerUserId !== userId) {
      return { ok: false, code: "PROVIDER_NOT_CONFIGURED", detail: "Không có quyền sử dụng tài khoản provider này" };
    }
    const usable = account.isFake ? process.env.NODE_ENV === "test" : account.status === "verified";
    if (!usable) return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", detail: `Tài khoản ${account.provider} chưa verify` };
    return { ok: true, account };
  }

  private failureResult(role: PreflightOperationResult["role"], operation: string, resolved: Extract<ResolvedAccount, { ok: false }>): PreflightOperationResult {
    return { role, operation, status: resolved.code === "PROVIDER_NOT_CONFIGURED" ? "not_configured" : "capability_unavailable", code: resolved.code, detail: resolved.detail };
  }

  private probeFailureResult(role: PreflightOperationResult["role"], operation: string, error: unknown): PreflightOperationResult {
    const detail = error instanceof ProviderError ? error.message : "Kiểm tra khả dụng thất bại";
    return { role, operation, status: "capability_unavailable", code: "PROVIDER_CAPABILITY_UNAVAILABLE", detail };
  }

  /**
   * Content generation operation. Shallow: account exists + verified. Deep (billed): a real,
   * minimal structured-generate call on the account's pinned model via `pickUsableContentModel`
   * - the same operation-specific probe VE2E-01 built for `POST /sources/:id/script-drafts`,
   * wired here so a preflight can prove the exact generate endpoint works, not just that the
   * account was verified at some point in the past.
   */
  private async contentOperation(ref: AccountRef, deep: boolean, userId: string, role: Role): Promise<PreflightOperationResult> {
    const operationRole = "content" as const;
    const operation = "generate_script";
    if (!ref) return { role: operationRole, operation, status: "not_configured", code: "PROVIDER_NOT_CONFIGURED", detail: "Automation profile chưa gán tài khoản provider" };
    const resolved = await this.resolveAccount(null, "content", ref.providerAccountId, userId, role);
    if (!resolved.ok) return this.failureResult(operationRole, operation, resolved);
    if (deep && isLiveContentKind(resolved.account.provider)) {
      try {
        await pickUsableContentModel(resolved.account.provider, decryptSecret(resolved.account.encryptedSecret), resolved.account.model);
      } catch (error) {
        return this.probeFailureResult(operationRole, operation, error);
      }
    }
    return { role: operationRole, operation, status: "ready" };
  }

  /**
   * Voice generation operation. Shallow: account exists + verified (`GET /v1/user`, non-billed,
   * already run at Verify time). Deep (billed): `probeElevenLabsTts` on the exact voice/model
   * the automation profile pins - requires `voiceConfig.voiceId`; without it a deep check cannot
   * target a specific voice, so it falls back to the shallow result instead of guessing one.
   */
  private async ttsOperation(ref: AccountRef, deep: boolean, userId: string, role: Role): Promise<PreflightOperationResult> {
    const operationRole = "tts" as const;
    const operation = "generate_voice";
    if (!ref) return { role: operationRole, operation, status: "not_configured", code: "PROVIDER_NOT_CONFIGURED", detail: "Automation profile chưa gán tài khoản provider" };
    const resolved = await this.resolveAccount("elevenlabs", "tts", ref.providerAccountId, userId, role);
    if (!resolved.ok) return this.failureResult(operationRole, operation, resolved);
    if (deep && ref.voiceId) {
      try {
        await probeElevenLabsTts(decryptSecret(resolved.account.encryptedSecret), ref.voiceId, resolved.account.model);
      } catch (error) {
        return this.probeFailureResult(operationRole, operation, error);
      }
    }
    return { role: operationRole, operation, status: "ready" };
  }

  /**
   * Media-import operation for an explicit Pexels account (see `PreflightOptions.pexelsAccountId`).
   * `probePexelsAccount` is a cheap, non-billed real call (`GET /v1/curated?per_page=1`), so it is
   * always run live here rather than gated behind `deep` - a stale `verified` flag is not proof the
   * key still works right now.
   */
  private async visualOperation(accountId: string | undefined, userId: string, role: Role): Promise<PreflightOperationResult | null> {
    if (!accountId) return null;
    const operationRole = "visual" as const;
    const operation = "media_search";
    const resolved = await this.resolveAccount("pexels", "visual", accountId, userId, role);
    if (!resolved.ok) return this.failureResult(operationRole, operation, resolved);
    try {
      await probePexelsAccount(decryptSecret(resolved.account.encryptedSecret));
    } catch (error) {
      return this.probeFailureResult(operationRole, operation, error);
    }
    return { role: operationRole, operation, status: "ready" };
  }

  /**
   * Render operation for an explicit Creatomate account (see `PreflightOptions.creatomateAccountId`).
   * `probeCreatomateAccount` is a cheap, non-billed real call (`GET /templates?limit=1`), same
   * reasoning as `visualOperation`.
   */
  private async renderAccountOperation(accountId: string | undefined, userId: string, role: Role): Promise<PreflightOperationResult | null> {
    if (!accountId) return null;
    const operationRole = "render" as const;
    const operation = "render_submit";
    const resolved = await this.resolveAccount(null, "render", accountId, userId, role);
    if (!resolved.ok) return this.failureResult(operationRole, operation, resolved);
    try {
      const probe = resolved.account.provider === "orshot" ? probeOrshotAccount : probeCreatomateAccount;
      await probe(decryptSecret(resolved.account.encryptedSecret));
    } catch (error) {
      return this.probeFailureResult(operationRole, operation, error);
    }
    return { role: operationRole, operation, status: "ready" };
  }

  private mediaDeliveryOperation(): PreflightOperationResult {
    return publicBaseUrlConfigured()
      ? { role: "render", operation: "media_delivery", status: "ready" }
      : { role: "render", operation: "media_delivery", status: "not_configured", code: "PROVIDER_NOT_CONFIGURED", detail: "PUBLIC_BASE_URL chưa cấu hình trên server" };
  }

  async preflight(profileId: string, userId: string, role: Role, options: PreflightOptions = {}) {
    const profile = await this.prisma.automationProfileVersion.findUnique({ where: { id: profileId } });
    if (!profile) return null;
    if (profile.projectId) {
      const grants = await this.grants.forUser(userId, role);
      if (!canAccessProject(role, grants, profile.projectId)) return null;
    } else if (role !== "admin" && profile.createdByUserId !== userId) {
      return null;
    }
    const deep = options.deep ?? false;
    const operations = (
      await Promise.all([
        this.contentOperation(asAccountRef(profile.contentConfig), deep, userId, role),
        this.ttsOperation(asAccountRef(profile.voiceConfig), deep, userId, role),
        this.visualOperation(options.pexelsAccountId, userId, role),
        this.renderAccountOperation(options.creatomateAccountId, userId, role),
      ])
    ).filter((result): result is PreflightOperationResult => result !== null);
    operations.push(this.mediaDeliveryOperation());
    return { profileId, ...summarizePreflight(operations) };
  }
}
