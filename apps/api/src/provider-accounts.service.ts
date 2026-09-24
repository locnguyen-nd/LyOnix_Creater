import { Inject, Injectable } from "@nestjs/common";
import { CURATED_CONTENT_MODELS, ProviderError, isLiveContentKind, mergeContentModels, resolveContentModel, verifyContentKey } from "@lyonix/providers";
import { PrismaService } from "./prisma.service.js";
import { encryptSecret, decryptSecret } from "./secret-crypto.js";

export type ProviderRole = "content" | "tts" | "visual" | "render";
export type ProviderScope = "personal" | "organization";
export type PublicProviderAccount = {
  id: string;
  name: string;
  provider: string;
  role: ProviderRole;
  scope: ProviderScope;
  ownerUserId: string | null;
  status: "unverified" | "verified" | "failed";
  model: string;
  availableModels: string[];
  quota: { status: "unknown"; remaining: null; unit: null };
  isFake: boolean;
  version: number;
};

const publicAccount = (row: { id: string; name: string; provider: string; role: string; scope: ProviderScope; ownerUserId: string | null; status: string; model: string; availableModels?: string[]; isFake: boolean; version: number }): PublicProviderAccount => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  role: row.role as ProviderRole,
  scope: row.scope,
  ownerUserId: row.ownerUserId,
  status: row.status === "verified" || row.status === "failed" ? row.status : "unverified",
  model: row.model,
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
    return rows.map(publicAccount);
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
    if (!isLiveContentKind(input.provider) || input.role !== "content") return "unsupported" as const;
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
    if (!isLiveContentKind(row.provider)) {
      const failed = await this.prisma.providerAccount.update({ where: { id }, data: { status: "failed", version: { increment: 1 } } });
      return publicAccount(failed);
    }
    try {
      const checked = await verifyContentKey(row.provider, decryptSecret(row.encryptedSecret));
      const models = mergeContentModels(row.provider, checked.models);
      const wanted = resolveContentModel(row.provider, row.model);
      const model = models.includes(wanted) ? wanted : models[0] ?? wanted;
      try {
        return publicAccount(await this.prisma.providerAccount.update({ where: { id }, data: { status: "verified", model, availableModels: models, version: { increment: 1 } } }));
      } catch {
        return publicAccount(await this.prisma.providerAccount.update({ where: { id }, data: { status: "verified", model, version: { increment: 1 } } }));
      }
    } catch (error) {
      const failed = await this.prisma.providerAccount.update({ where: { id }, data: { status: "failed", version: { increment: 1 } } });
      const publicRow = publicAccount(failed);
      if (error instanceof ProviderError && error.code === "PROVIDER_AUTH_INVALID") return { account: publicRow, code: "PROVIDER_UNAVAILABLE" as const };
      return { account: publicRow, code: "PROVIDER_UNAVAILABLE" as const };
    }
  }

  async update(
    id: string,
    userId: string,
    role: "admin" | "staff",
    expectedVersion: number,
    input: { name?: string; model?: string; secret?: string },
  ) {
    const row = await this.manageable(id, userId, role);
    if (!row || row === "forbidden") return row;
    if (row.version !== expectedVersion) return "conflict" as const;
    const name = input.name === undefined ? row.name : input.name.trim();
    const model = input.model === undefined ? row.model : input.model.trim();
    if (!name || !model) return "invalid" as const;
    if (input.model !== undefined && row.availableModels.length > 0 && !row.availableModels.includes(model)) return "model_unavailable" as const;
    const secret = input.secret?.trim();
    const result = await this.prisma.providerAccount.updateMany({
      where: { id: row.id, version: expectedVersion, deletedAt: null },
      data: {
        name,
        model,
        version: { increment: 1 },
        ...(secret ? { encryptedSecret: encryptSecret(secret), status: "unverified", availableModels: [] } : {}),
      },
    });
    if (!result.count) return "conflict" as const;
    const updated = await this.prisma.providerAccount.findUnique({ where: { id: row.id } });
    return updated ? publicAccount(updated) : null;
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
