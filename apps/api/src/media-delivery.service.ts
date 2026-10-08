import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { canAccessProject, isSafeRelativePath } from "@lyonix/domain";
import { mediaRoot } from "./handoff-workspace.js";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";

const DEFAULT_TTL_SEC = 600;
const MAX_TTL_SEC = 3600;

export const publicBaseUrlConfigured = () => Boolean(process.env.PUBLIC_BASE_URL?.trim());

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

export type ResolvedDelivery = { absolutePath: string; mimeType: string; originalFileName: string; bytes: number };

/**
 * Who fetches the delivery URL:
 * - "provider" (Creatomate, ...) is outside our network and needs the public absolute URL, so it requires PUBLIC_BASE_URL;
 * - "browser" (Studio thumbnails / players) reaches the API directly and only needs `path`, resolved against the API origin
 *   it already talks to. A stale or missing PUBLIC_BASE_URL (e.g. an expired dev tunnel) must not blank every thumbnail.
 */
export type DeliveryAudience = "provider" | "browser";

export const deliveryPath = (rawToken: string) => `/api/v1/media-delivery/${rawToken}`;

@Injectable()
export class MediaDeliveryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  /** Issue a short-lived, single-scope signed capability URL for exactly one media asset version. */
  async issueToken(mediaAssetVersionId: string, userId: string, role: "admin" | "staff", ttlSeconds = DEFAULT_TTL_SEC, audience: DeliveryAudience = "provider") {
    if (audience === "provider" && !publicBaseUrlConfigured()) return "not_configured" as const;
    const asset = await this.prisma.mediaAssetVersion.findFirst({ where: { id: mediaAssetVersionId, deletedAt: null } });
    if (!asset) return null;
    const grants = await this.grants.forUser(userId, role);
    if (!canAccessProject(role, grants, asset.projectId)) return "forbidden" as const;
    const ttl = Math.min(Math.max(ttlSeconds, 30), MAX_TTL_SEC);
    const raw = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await this.prisma.mediaDeliveryToken.create({
      data: {
        tokenHash: hashToken(raw),
        mediaAssetVersionId: asset.id,
        scope: "media_read",
        expiresAt,
        createdByUserId: userId,
      },
    });
    const path = deliveryPath(raw);
    const base = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/$/, "");
    return { token: raw, url: base ? `${base}${path}` : path, path, expiresAt: expiresAt.toISOString() };
  }

  /** Resolve a raw delivery token to a server-controlled absolute path. Never trusts client-supplied paths. */
  async resolve(rawToken: string): Promise<ResolvedDelivery | null> {
    if (!rawToken || rawToken.length < 16) return null;
    const tokenHash = hashToken(rawToken);
    const row = await this.prisma.mediaDeliveryToken.findUnique({ where: { tokenHash }, include: { mediaAssetVersion: true } });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    const asset = row.mediaAssetVersion;
    if (!asset || asset.deletedAt) return null;
    if (!isSafeRelativePath(asset.relativePath)) return null;
    const absolutePath = join(mediaRoot(), asset.relativePath);
    const exists = await stat(absolutePath).then((info) => info.isFile()).catch(() => false);
    if (!exists) return null;
    await this.prisma.mediaDeliveryToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }).catch(() => undefined);
    return { absolutePath, mimeType: asset.mimeType, originalFileName: asset.originalFileName, bytes: asset.bytes };
  }
}
