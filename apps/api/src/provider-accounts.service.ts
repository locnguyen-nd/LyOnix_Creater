import { Inject, Injectable } from "@nestjs/common";
import {
  CURATED_CONTENT_MODELS,
  CURATED_ELEVENLABS_MODELS,
  ProviderError,
  isLiveContentKind,
  pickUsableContentModel,
  probeContentModel,
  probeCreatomateAccount,
  probeElevenLabsAccount,
  probePexelsAccount,
  probeApifyAccount,
  probePinterestAccount,
  probeYouTubeAccount,
  resolveContentModel,
  rankContentModels,
  verifyContentKey,
  isFreshCheckedAt,
  findModelSnapshotEntry,
  type ContentModelSnapshotEntry,
} from "@lyonix/providers";
import { PrismaService } from "./prisma.service.js";
import { encryptSecret, decryptSecret } from "./secret-crypto.js";

/** `elevenlabs`/`tts` is the only supported non-content provider account today (VE2E-02). Omni remains B08-blocked. */
const isSupportedTtsAccount = (provider: string, role: ProviderRole) => provider === "elevenlabs" && role === "tts";
/** `pexels`/`youtube`/`pinterest` under `visual` (VE2E-04/VE2E-15b) — media search provider accounts. YouTube is discovery/embed-only (see `packages/providers/src/youtube.ts`); Pinterest is a manual-review-only candidate source with no reliable rights signal (see `packages/providers/src/pinterest.ts`). Google is still evaluated but not implemented (VE2E-15b) and stays unsupported here. */
const isSupportedVisualAccount = (provider: string, role: ProviderRole) => role === "visual" && (provider === "pexels" || provider === "youtube" || provider === "pinterest" || provider === "apify");
/** `creatomate`/`render` (VE2E-05) — render provider account. */
const isSupportedRenderAccount = (provider: string, role: ProviderRole) => provider === "creatomate" && role === "render";
const isSupportedAccount = (provider: string, role: ProviderRole) =>
  (isLiveContentKind(provider) && role === "content") || isSupportedTtsAccount(provider, role) || isSupportedVisualAccount(provider, role) || isSupportedRenderAccount(provider, role);

export type ProviderRole = "content" | "tts" | "visual" | "render";
export type ProviderScope = "personal" | "organization";
/** V00-10: per-model eligibility + freshness, exposed to the UI so it can distinguish usable/unverified/stale instead of trusting a flat model-name list. */
export type PublicModelSnapshotEntry = { modelId: string; status: string; checkedAt: string; source: string; reason?: string; fresh: boolean };

export type PublicProviderAccount = {
  id: string;
  name: string;
  provider: string;
  role: ProviderRole;
  scope: ProviderScope;
  ownerUserId: string | null;
  status: "unverified" | "verified" | "failed";
  model: string;
  visionModel: string | null;
  /** Real per-model verification status for content accounts (V00-10 freshness snapshot). Empty for non-content roles or before the first verify. */
  modelSnapshot: PublicModelSnapshotEntry[];
  availableModels: string[];
  preferredModels: string[];
  modelCooldowns: Array<{ modelId: string; cooldownUntil: string }>;
  quota: { status: "unknown"; remaining: null; unit: null };
  isFake: boolean;
  version: number;
};

const toPublicSnapshot = (raw: unknown): PublicModelSnapshotEntry[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is ContentModelSnapshotEntry => Boolean(entry) && typeof entry === "object" && typeof (entry as ContentModelSnapshotEntry).modelId === "string")
    .map((entry) => ({ modelId: entry.modelId, status: entry.status, checkedAt: entry.checkedAt, source: entry.source, fresh: isFreshCheckedAt(entry.checkedAt), ...(entry.reason ? { reason: entry.reason } : {}) }));
};

const publicAccount = (row: { id: string; name: string; provider: string; role: string; scope: ProviderScope; ownerUserId: string | null; status: string; model: string; visionModel?: string | null; availableModels?: string[]; preferredModels?: string[]; modelSnapshot?: unknown; isFake: boolean; version: number }): PublicProviderAccount => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  role: row.role as ProviderRole,
  scope: row.scope,
  ownerUserId: row.ownerUserId,
  status: row.status === "verified" || row.status === "failed" ? row.status : "unverified",
  model: row.model,
  visionModel: row.visionModel ?? null,
  modelSnapshot: toPublicSnapshot(row.modelSnapshot),
  preferredModels: row.preferredModels ?? [],
  modelCooldowns: [],
  // Pre-verify suggestion only (account not yet checked against any real endpoint) - once `availableModels`
  // is populated by a real verify() it always comes from account-scoped discovery/probe, never this fallback.
  availableModels: row.availableModels?.length
    ? row.availableModels
    : isLiveContentKind(row.provider) ? [...CURATED_CONTENT_MODELS[row.provider]] : [],
  quota: { status: "unknown", remaining: null, unit: null },
  isFake: row.isFake,
  version: row.version,
});

@Injectable()
export class ProviderAccountsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(userId: string, role: "admin" | "staff") {
    const rows = await this.prisma.providerAccount.findMany({
      where: role === "admin"
        ? { deletedAt: null }
        : { deletedAt: null, OR: [{ scope: "organization" }, { ownerUserId: userId }] },
      orderBy: { createdAt: "desc" },
    });
    const ids = rows.filter((row) => row.role === "content").map((row) => row.id);
    const cooldowns = ids.length ? await this.prisma.providerModelCooldown.findMany({
      where: { providerAccountId: { in: ids }, cooldownUntil: { gt: new Date() } },
      select: { providerAccountId: true, modelId: true, cooldownUntil: true },
    }) : [];
    return rows.map((row) => ({ ...publicAccount(row), modelCooldowns: cooldowns.filter((item) => item.providerAccountId === row.id).map((item) => ({ modelId: item.modelId, cooldownUntil: item.cooldownUntil.toISOString() })) }));
  }

  /** Candidates use the same account visibility rules as GET /provider-accounts; one org is the current tenant boundary. */
  async contentGenerationCandidates(userId: string, role: "admin" | "staff", preferredAccountId?: string) {
    const rows = await this.prisma.providerAccount.findMany({
      where: {
        role: "content",
        status: "verified",
        deletedAt: null,
        ...(process.env.NODE_ENV === "test" ? {} : { isFake: false }),
        ...(role === "admin" ? {} : { OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: userId }] }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return preferredAccountId
      ? [...rows.filter((row) => row.id === preferredAccountId), ...rows.filter((row) => row.id !== preferredAccountId)]
      : rows;
  }

  /**
   * Atomic Postgres admission gate shared by every API/worker replica. `role` defaults to
   * `"content"` for full backward compatibility with the original VE2E-12 content-generation
   * call sites; VE2E-15a reuses the same DB-shared `activeContentRequests`/`cooldownUntil`
   * fields (they live on every `ProviderAccount` row regardless of role) for the `"visual"`
   * media-search fan-out gate instead of inventing a second mechanism.
   */
  async acquireContentRequestSlot(accountId: string, now = new Date(), maxConcurrent = 4, role: ProviderRole = "content"): Promise<boolean> {
    const result = await this.prisma.providerAccount.updateMany({
      where: {
        id: accountId,
        role,
        status: "verified",
        deletedAt: null,
        activeContentRequests: { lt: maxConcurrent },
        OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
      },
      data: { activeContentRequests: { increment: 1 } },
    } as any);
    return result.count === 1;
  }

  async releaseContentRequestSlot(accountId: string, _role: ProviderRole = "content") {
    await this.prisma.providerAccount.updateMany({
      where: { id: accountId, activeContentRequests: { gt: 0 } },
      data: { activeContentRequests: { decrement: 1 } },
    } as any);
  }

  async cooldownContentAccount(accountId: string, retryAfterMs?: number, now = new Date(), _role: ProviderRole = "content"): Promise<Date> {
    const fallbackMs = retryAfterMs === undefined ? 60_000 : 0;
    const cooldownUntil = new Date(now.getTime() + Math.min(24 * 60 * 60_000, Math.max(1_000, retryAfterMs ?? fallbackMs)));
    await this.prisma.providerAccount.updateMany({ where: { id: accountId, deletedAt: null }, data: { cooldownUntil } } as any);
    return cooldownUntil;
  }

  /**
   * VE2E-56: per-(account, model) cooldown. Provider quotas (Gemini free tier, OpenAI per-model RPM) are per
   * model, so a model-level 429/quota only benches that model; the account stays usable for its other models.
   */
  async markModelLimited(accountId: string, modelId: string, retryAfterMs?: number, reason?: string, now = new Date()): Promise<Date> {
    const cooldownUntil = new Date(now.getTime() + Math.min(24 * 60 * 60_000, Math.max(1_000, retryAfterMs ?? 60_000)));
    const trimmed = reason ? reason.slice(0, 300) : null;
    await this.prisma.providerModelCooldown.upsert({
      where: { providerAccountId_modelId: { providerAccountId: accountId, modelId } },
      create: { providerAccountId: accountId, modelId, cooldownUntil, reason: trimmed },
      update: { cooldownUntil, reason: trimmed },
    });
    return cooldownUntil;
  }

  async getModelAvailability(accountId: string, modelId: string, now = new Date()): Promise<{ available: boolean; retryAt: Date | null }> {
    const row = await this.prisma.providerModelCooldown.findUnique({ where: { providerAccountId_modelId: { providerAccountId: accountId, modelId } } });
    if (!row || row.cooldownUntil.getTime() <= now.getTime()) return { available: true, retryAt: null };
    return { available: false, retryAt: row.cooldownUntil };
  }

  /** Active (not yet expired) model cooldowns for one account, earliest retry first. */
  async listModelCooldowns(accountId: string, now = new Date()): Promise<Array<{ modelId: string; cooldownUntil: Date; reason: string | null }>> {
    const rows = await this.prisma.providerModelCooldown.findMany({
      where: { providerAccountId: accountId, cooldownUntil: { gt: now } },
      orderBy: { cooldownUntil: "asc" },
    });
    return rows.map((row) => ({ modelId: row.modelId, cooldownUntil: row.cooldownUntil, reason: row.reason }));
  }

  private async manageable(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.prisma.providerAccount.findFirst({ where: { id, deletedAt: null } });
    if (!row) return null;
    // Staff may use an organization account, but only its administrator may alter it.
    if (role !== "admin" && (row.scope !== "personal" || row.ownerUserId !== userId)) return "forbidden" as const;
    return row;
  }

  async create(input: { name: string; provider: string; role: ProviderRole; scope: ProviderScope; model: string; secret: string }, actorId: string, actorRole: "admin" | "staff") {
    if (input.scope === "organization" && actorRole !== "admin") return null;
    if (!isSupportedAccount(input.provider, input.role)) return "unsupported" as const;
    const row = await this.prisma.providerAccount.create({
      data: {
        name: input.name,
        provider: input.provider,
        role: input.role,
        scope: input.scope,
        ownerUserId: input.scope === "personal" ? actorId : null,
        status: "unverified",
        model: input.model,
        encryptedSecret: encryptSecret(input.secret),
        isFake: false,
        ...(isLiveContentKind(input.provider) ? { availableModels: [...CURATED_CONTENT_MODELS[input.provider]] } : {}),
        ...(isSupportedTtsAccount(input.provider, input.role) ? { availableModels: [...CURATED_ELEVENLABS_MODELS] } : {}),
      },
    }).catch(async () => this.prisma.providerAccount.create({
      data: {
        name: input.name,
        provider: input.provider,
        role: input.role,
        scope: input.scope,
        ownerUserId: input.scope === "personal" ? actorId : null,
        status: "unverified",
        model: input.model,
        encryptedSecret: encryptSecret(input.secret),
        isFake: false,
      },
    }));
    return publicAccount(row);
  }

  async verify(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.manageable(id, userId, role);
    if (!row || row === "forbidden") return row;
    if (isSupportedTtsAccount(row.provider, row.role as ProviderRole)) return this.verifyElevenLabs(row);
    if (isSupportedVisualAccount(row.provider, row.role as ProviderRole)) {
      if (row.provider === "youtube") return this.verifyYouTube(row);
      if (row.provider === "pinterest") return this.verifyPinterest(row);
      if (row.provider === "apify") return this.verifyApify(row);
      return this.verifyPexels(row);
    }
    if (isSupportedRenderAccount(row.provider, row.role as ProviderRole)) return this.verifyCreatomate(row);
    if (!isLiveContentKind(row.provider)) {
      const failed = await this.prisma.providerAccount.update({ where: { id }, data: { status: "failed", version: { increment: 1 } } });
      return publicAccount(failed);
    }
    return this.verifyContentAccount(row);
  }

  /**
   * V00-10: replaces the old "list models, union with the static curated catalog, mark
   * verified" flow. `verifyContentKey` now returns account-scoped discovery only (no static
   * union - see `discoveredContentModels`), which is *listing* evidence, not proof of generate
   * access. This account can only become `verified` once `pickUsableContentModel` succeeds a
   * real, bounded generate call on the exact endpoint for the desired (or a fallback)
   * candidate - never a model ID that was merely listed. Every model actually looked at
   * (winner + rejected candidates) is persisted into `modelSnapshot` with a fresh `checkedAt`,
   * so the UI can distinguish `usable` from `unverified`/`retired`/`unsupported` instead of a
   * flat name list.
   */
  private async verifyContentAccount(row: { id: string; provider: string; model: string; encryptedSecret: string }) {
    const secret = decryptSecret(row.encryptedSecret);
    try {
      const kind = row.provider as Parameters<typeof pickUsableContentModel>[0];
      const discovered = (await verifyContentKey(row.provider as Parameters<typeof verifyContentKey>[0], secret)).models;
      const desired = resolveContentModel(row.provider as Parameters<typeof resolveContentModel>[0], row.model);
      if (discovered.length === 0) {
        throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", "Provider did not return any account-scoped content models", false);
      }
      const ranked = rankContentModels(kind, discovered);
      const preferred = discovered.includes(desired) ? desired : ranked[0]!;
      // Verification has a strict one-probe budget. Discovering a model in the account's
      // catalog is not proof of generate access; other entries remain unverified until use.
      const probed = await pickUsableContentModel(kind, secret, preferred);
      const now = new Date().toISOString();
      const listedOnly = discovered.filter((modelId) => modelId !== probed.modelId && !probed.attempted.some((entry) => entry.modelId === modelId));
      const modelSnapshot: ContentModelSnapshotEntry[] = [
        { modelId: probed.modelId, status: "usable", checkedAt: probed.verifiedAt, source: "probed" },
        ...probed.attempted,
        ...listedOnly.map((modelId): ContentModelSnapshotEntry => ({ modelId, status: "unverified", checkedAt: now, source: "listed" })),
      ];
      const availableModels = rankContentModels(kind, [probed.modelId, ...listedOnly]);
      try {
        return publicAccount(await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "verified", model: probed.modelId, availableModels, modelSnapshot: modelSnapshot as unknown as object, version: { increment: 1 } } }));
      } catch {
        return publicAccount(await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "verified", model: probed.modelId, version: { increment: 1 } } }));
      }
    } catch (error) {
      const failed = await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "failed", version: { increment: 1 } } });
      const publicRow = publicAccount(failed);
      if (error instanceof ProviderError) return { account: publicRow, code: error.code, message: error.message };
      return { account: publicRow, code: "PROVIDER_UNAVAILABLE" as const, message: error instanceof Error ? error.message : undefined };
    }
  }

  /**
   * V00-10: called when a live generate call independently discovers (outside of an explicit
   * verify click, e.g. from `ScriptGenerationService`) that the account's *currently pinned*
   * model is retired/capability-unavailable on the real endpoint. Marks just that model
   * `retired` in the snapshot and, if it was the pinned model, forces an explicit reselection
   * by removing it from `availableModels` rather than silently keeping the account "verified"
   * against a model that no longer actually works.
   */
  /**
   * Re-pins an account's default model after a live generate call fell back to a different
   * model from `availableModels` (quota/rate-limit rotation in `ScriptGenerationService`) so
   * the next request starts on the model that actually worked instead of re-spending one call
   * on the still-exhausted one every time. No version/If-Match check: this mirrors
   * `markModelUnusable`'s "server records what really happened" write, not a user-authored edit.
   */
  async repinModel(accountId: string, modelId: string) {
    const account = await this.prisma.providerAccount.findFirst({ where: { id: accountId, deletedAt: null } });
    if (!account || account.model === modelId) return;
    await this.prisma.providerAccount.update({ where: { id: account.id }, data: { model: modelId, version: { increment: 1 } } });
  }

  async markModelUnusable(accountId: string, modelId: string, reason: string) {
    const account = await this.prisma.providerAccount.findFirst({ where: { id: accountId, deletedAt: null } });
    if (!account || !isLiveContentKind(account.provider)) return;
    const resolved = resolveContentModel(account.provider as Parameters<typeof resolveContentModel>[0], modelId);
    const now = new Date().toISOString();
    const existing = Array.isArray(account.modelSnapshot) ? (account.modelSnapshot as unknown as ContentModelSnapshotEntry[]) : [];
    const nextSnapshot: ContentModelSnapshotEntry[] = [
      { modelId: resolved, status: "retired", checkedAt: now, source: "probed", reason },
      ...existing.filter((entry) => entry.modelId !== resolved),
    ];
    const nextAvailable = (account.availableModels ?? []).filter((id) => id !== resolved);
    await this.prisma.providerAccount.update({
      where: { id: account.id },
      data: { modelSnapshot: nextSnapshot as unknown as object, availableModels: nextAvailable, version: { increment: 1 } },
    });
  }

  /**
   * ElevenLabs account preflight: a lightweight, non-billed `GET /v1/user` call
   * proves the key is real and reports subscription tier — the same
   * "real-endpoint, no static assumption" principle used for content providers,
   * just without a paid generate call for every verify click (see
   * `probeElevenLabsTts` in `@lyonix/providers` for the billed, operation-specific
   * voice/model probe, used separately when a specific voice is pinned).
   */
  private async verifyElevenLabs(row: { id: string; model: string; encryptedSecret: string }) {
    try {
      await probeElevenLabsAccount(decryptSecret(row.encryptedSecret));
      const model = row.model?.trim() || CURATED_ELEVENLABS_MODELS[0];
      return publicAccount(await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "verified", model, availableModels: [...CURATED_ELEVENLABS_MODELS], version: { increment: 1 } } }));
    } catch (error) {
      const failed = await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "failed", version: { increment: 1 } } });
      const publicRow = publicAccount(failed);
      if (error instanceof ProviderError) return { account: publicRow, code: error.code, message: error.message };
      return { account: publicRow, code: "PROVIDER_UNAVAILABLE" as const, message: error instanceof Error ? error.message : undefined };
    }
  }

  /**
   * Pexels account preflight: `probePexelsAccount` is the cheapest real call
   * that proves the key works (Pexels has no dedicated "who am I" endpoint) —
   * same "real-endpoint, no static assumption" principle as `verifyElevenLabs`.
   */
  private async verifyPexels(row: { id: string; model: string; encryptedSecret: string }) {
    try {
      await probePexelsAccount(decryptSecret(row.encryptedSecret));
      return publicAccount(await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "verified", version: { increment: 1 } } }));
    } catch (error) {
      const failed = await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "failed", version: { increment: 1 } } });
      const publicRow = publicAccount(failed);
      if (error instanceof ProviderError) return { account: publicRow, code: error.code, message: error.message };
      return { account: publicRow, code: "PROVIDER_UNAVAILABLE" as const, message: error instanceof Error ? error.message : undefined };
    }
  }

  /**
   * YouTube Data API v3 account preflight (VE2E-15b): `probeYouTubeAccount` is the cheapest real
   * call that proves the key works (`videos.list?chart=mostPopular`, 1 quota unit vs 100 for
   * `search.list`) — same "real-endpoint, minimal cost" principle as `verifyPexels`. This
   * account can only ever be used for discovery/embed candidates (see
   * `packages/providers/src/youtube.ts`), never import.
   */
  private async verifyYouTube(row: { id: string; model: string; encryptedSecret: string }) {
    try {
      await probeYouTubeAccount(decryptSecret(row.encryptedSecret));
      return publicAccount(await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "verified", version: { increment: 1 } } }));
    } catch (error) {
      const failed = await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "failed", version: { increment: 1 } } });
      const publicRow = publicAccount(failed);
      if (error instanceof ProviderError) return { account: publicRow, code: error.code, message: error.message };
      return { account: publicRow, code: "PROVIDER_UNAVAILABLE" as const, message: error instanceof Error ? error.message : undefined };
    }
  }

  /** Apify account preflight (VE2E-45): read-only `GET /v2/users/me`; never starts an Actor run. */
  private async verifyApify(row: { id: string; model: string; encryptedSecret: string }) {
    try {
      await probeApifyAccount(decryptSecret(row.encryptedSecret));
      return publicAccount(await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "verified", version: { increment: 1 } } }));
    } catch (error) {
      const failed = await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "failed", version: { increment: 1 } } });
      const publicRow = publicAccount(failed);
      if (error instanceof ProviderError) return { account: publicRow, code: error.code, message: error.message };
      return { account: publicRow, code: "PROVIDER_UNAVAILABLE" as const, message: error instanceof Error ? error.message : undefined };
    }
  }

  /**
   * Pinterest account preflight (VE2E-15b): `probePinterestAccount` reuses the one confirmed-real
   * endpoint (`search/partner/pins`, `limit=1`) — see `packages/providers/src/pinterest.ts` for
   * why no separate "who am I" endpoint is assumed. This single call proves both a valid token
   * AND partner-search scope access; a token that is valid but lacks that scope still fails here
   * (`PROVIDER_CAPABILITY_UNAVAILABLE`) rather than reporting a false "verified". Pinterest
   * candidates never carry a reliable rights signal (see `pinterestPinToMediaCandidate`), so a
   * verified account here only ever produces manual-Studio-review candidates, never Auto-applied
   * ones.
   */
  private async verifyPinterest(row: { id: string; model: string; encryptedSecret: string }) {
    try {
      await probePinterestAccount(decryptSecret(row.encryptedSecret));
      return publicAccount(await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "verified", version: { increment: 1 } } }));
    } catch (error) {
      const failed = await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "failed", version: { increment: 1 } } });
      const publicRow = publicAccount(failed);
      if (error instanceof ProviderError) return { account: publicRow, code: error.code, message: error.message };
      return { account: publicRow, code: "PROVIDER_UNAVAILABLE" as const, message: error instanceof Error ? error.message : undefined };
    }
  }

  /**
   * Creatomate account preflight: listing templates (page size 1) is the cheapest
   * real call that proves the API key works — same "real-endpoint, no static
   * assumption" principle as `verifyElevenLabs`/`verifyPexels`.
   */
  private async verifyCreatomate(row: { id: string; model: string; encryptedSecret: string }) {
    try {
      await probeCreatomateAccount(decryptSecret(row.encryptedSecret));
      return publicAccount(await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "verified", version: { increment: 1 } } }));
    } catch (error) {
      const failed = await this.prisma.providerAccount.update({ where: { id: row.id }, data: { status: "failed", version: { increment: 1 } } });
      const publicRow = publicAccount(failed);
      if (error instanceof ProviderError) return { account: publicRow, code: error.code, message: error.message };
      return { account: publicRow, code: "PROVIDER_UNAVAILABLE" as const, message: error instanceof Error ? error.message : undefined };
    }
  }

  async update(
    id: string,
    userId: string,
    role: "admin" | "staff",
    expectedVersion: number,
    input: { name?: string; model?: string; visionModel?: string | null; preferredModels?: string[]; secret?: string },
  ) {
    const row = await this.manageable(id, userId, role);
    if (!row || row === "forbidden") return row;
    if (row.version !== expectedVersion) return "conflict" as const;
    const name = input.name === undefined ? row.name : input.name.trim();
    const model = input.model === undefined ? row.model : input.model.trim();
    if (!name || !model) return "invalid" as const;
    if (input.model !== undefined && row.availableModels.length > 0 && !row.availableModels.includes(model)) return "model_unavailable" as const;
    const visionModel = input.visionModel === undefined ? row.visionModel : input.visionModel?.trim() || null;
    if (visionModel && (!isLiveContentKind(row.provider) || !row.availableModels.includes(visionModel))) return "model_unavailable" as const;
    const preferredModels = input.preferredModels === undefined ? (row.preferredModels ?? []) : [...new Set(input.preferredModels.map((item) => item.trim()))];
    if (preferredModels.some((item) => !item || !row.availableModels.includes(item))) return "model_unavailable" as const;
    const secret = input.secret?.trim();
    let modelSnapshotUpdate: ContentModelSnapshotEntry[] | undefined;
    // V00-10: a content model switch is an explicit user action - reject unknown/retired/unsupported
    // outright (handled by the availableModels check above), and re-verify against the real generate
    // endpoint right now if the cached snapshot entry is missing or stale, instead of blindly accepting
    // a model that was only ever listed, or was last confirmed usable a long time ago.
    if (input.model !== undefined && model !== row.model && !secret && isLiveContentKind(row.provider)) {
      const switched = await this.reprobeModelForSwitch(row, model);
      if (!switched.ok) return "model_unavailable" as const;
      modelSnapshotUpdate = switched.modelSnapshot;
    }
    const result = await this.prisma.providerAccount.updateMany({
      where: { id: row.id, version: expectedVersion, deletedAt: null },
      data: {
        name,
        model,
        visionModel,
        preferredModels,
        version: { increment: 1 },
        ...(modelSnapshotUpdate ? { modelSnapshot: modelSnapshotUpdate as unknown as object } : {}),
        ...(secret ? { encryptedSecret: encryptSecret(secret), status: "unverified", availableModels: [], modelSnapshot: [], visionModel: null, preferredModels: [] } : {}),
      },
    });
    if (!result.count) return "conflict" as const;
    const updated = await this.prisma.providerAccount.findUnique({ where: { id: row.id } });
    return updated ? publicAccount(updated) : null;
  }

  /**
   * Bounded, single real generate call for the one model the user is switching to - only run
   * when the cached snapshot doesn't already prove it `usable` and fresh (`CONTENT_MODEL_FRESHNESS_TTL_MS`).
   * Never accepts a model on the strength of an old snapshot entry or the mere fact it was listed.
   */
  private async reprobeModelForSwitch(
    row: { provider: string; encryptedSecret: string; modelSnapshot?: unknown },
    model: string,
  ): Promise<{ ok: true; modelSnapshot: ContentModelSnapshotEntry[] } | { ok: false }> {
    const kind = row.provider as Parameters<typeof probeContentModel>[0];
    const resolved = resolveContentModel(row.provider as Parameters<typeof resolveContentModel>[0], model);
    const existing = Array.isArray(row.modelSnapshot) ? (row.modelSnapshot as unknown as ContentModelSnapshotEntry[]) : [];
    const entry = findModelSnapshotEntry(existing, resolved);
    if (entry && entry.status === "usable" && isFreshCheckedAt(entry.checkedAt)) return { ok: true, modelSnapshot: existing };
    try {
      const probed = await probeContentModel(kind, decryptSecret(row.encryptedSecret), resolved);
      const nextEntry: ContentModelSnapshotEntry = { modelId: probed.modelId, status: "usable", checkedAt: probed.verifiedAt, source: "probed" };
      return { ok: true, modelSnapshot: [nextEntry, ...existing.filter((item) => item.modelId !== nextEntry.modelId)] };
    } catch {
      return { ok: false };
    }
  }

  async remove(id: string, userId: string, role: "admin" | "staff", expectedVersion: number) {
    const row = await this.manageable(id, userId, role);
    if (!row || row === "forbidden") return row;
    if (row.version !== expectedVersion) return "conflict" as const;
    // Keep the encrypted config for already-pinned jobs, but remove it from all selection and list APIs.
    const result = await this.prisma.providerAccount.updateMany({
      where: { id: row.id, version: expectedVersion, deletedAt: null },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    return result.count ? true as const : "conflict" as const;
  }
}
