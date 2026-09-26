import { Inject, Injectable } from "@nestjs/common";
import { canAccessChannel } from "./grant-access.js";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";
import { buildChannelInsights, parsePeriod, type PeriodKey } from "./channel-insights.js";
import {
  hasTiktokScope,
  parseTiktokUser,
  parseTiktokVideoTotals,
  refreshTiktokToken,
  TIKTOK_USER_BASIC_FIELDS,
  TIKTOK_USER_STATS_FIELDS,
  type TiktokTokenSet,
  type TiktokUser,
} from "./tiktok.js";

export type ChannelAuthType = "oauth2" | "token" | "api_key" | "fixture";

export type PublicChannel = {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  authType: ChannelAuthType;
  connected: boolean;
  lastSyncAt: string | null;
  grantedScopes: string[];
  coverage: { from: string | null; to: string | null; sampleCount: number };
};

const webOrigin = () => process.env.WEB_ORIGIN ?? "http://localhost:5173";

const publicChannel = (row: { id: string; displayName: string; externalChannelId: string; username: string | null; avatarUrl: string | null; authType: ChannelAuthType; status: string; grantedScopes: string[]; updatedAt: Date }, coverage: PublicChannel["coverage"], lastSyncAt: string | null): PublicChannel => ({
  id: row.id,
  name: row.displayName,
  handle: row.username ? `@${row.username}` : "",
  avatarUrl: row.avatarUrl,
  authType: row.authType,
  connected: row.status === "connected",
  lastSyncAt,
  grantedScopes: row.grantedScopes,
  coverage,
});

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  private async visible(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.prisma.channelConnection.findUnique({ where: { id } });
    if (!row) return null;
    const grants = await this.grants.forUser(userId, role);
    if (!canAccessChannel(role, grants, row.id)) return null;
    return row;
  }

  private async coverage(channelId: string) {
    const snapshots = await this.prisma.metricSnapshot.findMany({ where: { channelId }, orderBy: { capturedAt: "asc" } });
    const last = snapshots.at(-1);
    return {
      coverage: {
        from: snapshots[0]?.capturedAt.toISOString() ?? null,
        to: last?.capturedAt.toISOString() ?? null,
        sampleCount: snapshots.length,
      },
      lastSyncAt: last?.capturedAt.toISOString() ?? null,
    };
  }

  async list(userId: string, role: "admin" | "staff") {
    const grants = await this.grants.forUser(userId, role);
    const rows = await this.prisma.channelConnection.findMany({
      where: role === "admin" ? {} : { id: { in: grants.channelIds } },
      orderBy: { updatedAt: "desc" },
    });
    return Promise.all(rows.map(async (row) => {
      const extra = await this.coverage(row.id);
      return publicChannel(row, extra.coverage, extra.lastSyncAt ?? row.updatedAt.toISOString());
    }));
  }

  async get(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.visible(id, userId, role);
    if (!row) return null;
    const extra = await this.coverage(row.id);
    const snapshots = await this.prisma.metricSnapshot.findMany({ where: { channelId: id }, orderBy: { capturedAt: "desc" }, take: 2000 });
    return {
      channel: publicChannel(row, extra.coverage, extra.lastSyncAt ?? row.updatedAt.toISOString()),
      snapshots: snapshots.map((item) => ({
        metric: item.metricName,
        value: item.value === null ? null : item.value.toString(),
        currency: item.currency,
        availability: item.availability,
        reasonCode: item.reasonCode,
        capturedAt: item.capturedAt.toISOString(),
      })),
    };
  }

  async insights(id: string, userId: string, role: "admin" | "staff", period: PeriodKey | string | undefined) {
    const detail = await this.get(id, userId, role);
    if (!detail) return null;
    return {
      channel: detail.channel,
      ...buildChannelInsights({
        snaps: detail.snapshots.map((item) => ({
          metric: item.metric,
          value: item.value,
          availability: item.availability,
          reasonCode: item.reasonCode,
          capturedAt: item.capturedAt,
        })),
        scopes: detail.channel.grantedScopes,
        period: parsePeriod(typeof period === "string" ? period : undefined),
      }),
    };
  }

  async connectToken(userId: string, input: { name?: string; secret: string; authType: "token" | "api_key" }) {
    const profile = await this.lookupUser(input.secret);
    if (!profile) return "invalid" as const;
    const row = await this.upsertConnection({
      userId,
      openId: profile.openId,
      displayName: input.name?.trim() || profile.displayName,
      username: profile.username,
      avatarUrl: profile.avatarUrl,
      authType: input.authType,
      tokens: { accessToken: input.secret, refreshToken: null, openId: profile.openId, scope: ["user.info.basic"], expiresAt: null },
    });
    const extra = await this.coverage(row.id);
    await this.grants.shareChannel(row.id);
    return publicChannel(row, extra.coverage, extra.lastSyncAt);
  }

  async upsertConnection(input: { userId: string; openId: string; displayName: string; username?: string | null; avatarUrl?: string | null; authType: ChannelAuthType; tokens: TiktokTokenSet }) {
    const row = await this.prisma.channelConnection.upsert({
      where: { userId_externalChannelId: { userId: input.userId, externalChannelId: input.openId } },
      create: {
        userId: input.userId,
        externalChannelId: input.openId,
        displayName: input.displayName,
        username: input.username ?? null,
        avatarUrl: input.avatarUrl ?? null,
        authType: input.authType,
        encryptedSecret: encryptSecret(JSON.stringify(input.tokens)),
        grantedScopes: input.tokens.scope,
        status: "connected",
        isFixture: false,
      },
      update: {
        displayName: input.displayName,
        username: input.username ?? null,
        avatarUrl: input.avatarUrl ?? null,
        authType: input.authType,
        encryptedSecret: encryptSecret(JSON.stringify(input.tokens)),
        grantedScopes: input.tokens.scope,
        status: "connected",
        isFixture: false,
      },
    });
    await this.grants.shareChannel(row.id);
    return row;
  }

  async disable(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.visible(id, userId, role);
    if (!row) return null;
    if (role !== "admin") return "forbidden" as const;
    await this.prisma.channelConnection.update({ where: { id }, data: { status: "disabled" } });
    return "disabled" as const;
  }

  async sync(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.visible(id, userId, role);
    if (!row || row.status !== "connected" || !row.encryptedSecret) return null;
    const outcome = await this.performSync(row);
    if (outcome === "invalid") return "invalid" as const;
    return this.get(id, userId, role);
  }

  /**
   * Privileged sync entry point for the periodic scheduler (`TiktokSyncSchedulerService`):
   * no `userId`/grant check, because a scheduled tick acts on behalf of the platform, not a
   * single logged-in user. Iterates every `connected` TikTok channel, syncs it, and never lets
   * one channel's failure (revoked token, TikTok outage) stop the rest of the batch.
   */
  async syncAllConnected(): Promise<{ total: number; synced: number; invalid: number; failed: number }> {
    const rows = await this.prisma.channelConnection.findMany({ where: { status: "connected", authType: "oauth2" } });
    let synced = 0;
    let invalid = 0;
    let failed = 0;
    for (const row of rows) {
      if (!row.encryptedSecret) {
        invalid += 1;
        continue;
      }
      try {
        const outcome = await this.performSync(row);
        if (outcome === "invalid") invalid += 1;
        else synced += 1;
      } catch {
        failed += 1;
      }
    }
    return { total: rows.length, synced, invalid, failed };
  }

  private async performSync(row: { id: string; encryptedSecret: string | null; grantedScopes: string[] }): Promise<"synced" | "invalid"> {
    if (!row.encryptedSecret) return "invalid";
    let tokens = JSON.parse(decryptSecret(row.encryptedSecret)) as TiktokTokenSet;
    tokens = await this.refreshIfNeeded(row.id, row.grantedScopes, tokens);
    let profile = await this.lookupUser(tokens.accessToken);
    if (!profile && tokens.refreshToken) {
      tokens = await this.refreshIfNeeded(row.id, row.grantedScopes, { ...tokens, expiresAt: 0 });
      profile = await this.lookupUser(tokens.accessToken);
    }
    if (!profile) return "invalid" as const;
    const scopes = [...tokens.scope, ...row.grantedScopes];
    const withStats = hasTiktokScope(scopes, "user.info.stats")
      ? await this.lookupUser(tokens.accessToken, TIKTOK_USER_STATS_FIELDS)
      : null;
    const user: TiktokUser = withStats ?? profile;
    const totals = hasTiktokScope(scopes, "video.list") ? await this.lookupVideos(tokens.accessToken) : null;
    const capturedAt = new Date();
    const snapshot = (metricName: string, value: number | null | undefined, granted: boolean) => ({
      metricName,
      value: granted && value !== null && value !== undefined ? String(value) : null,
      availability: granted ? "available" : "not_granted",
      reasonCode: granted ? null : "TIKTOK_SCOPE_NOT_GRANTED",
      currency: null,
    });
    const metrics = [
      snapshot("followers", user.followerCount, hasTiktokScope(scopes, "user.info.stats")),
      snapshot("likes", user.likesCount ?? totals?.likes, hasTiktokScope(scopes, "user.info.stats") || Boolean(totals)),
      snapshot("views", totals?.views, Boolean(totals)),
      snapshot("comments", totals?.comments, Boolean(totals)),
      snapshot("shares", totals?.shares, Boolean(totals)),
      snapshot("video_count", user.videoCount, hasTiktokScope(scopes, "user.info.stats")),
      snapshot("revenue_from_views", null, false),
    ];
    await this.updateChannelRow(row.id, {
      displayName: user.displayName,
      username: user.username,
      avatarUrl: user.avatarUrl,
      status: "connected",
      grantedScopes: tokens.scope.length ? tokens.scope : row.grantedScopes,
    });
    await this.prisma.metricSnapshot.createMany({
      data: metrics.map((metric) => ({ channelId: row.id, capturedAt, ...metric })),
    });
    return "synced" as const;
  }

  private async updateChannelRow(id: string, data: { displayName: string; username: string | null; avatarUrl: string | null; status: string; grantedScopes: string[] }) {
    try {
      await this.prisma.channelConnection.update({ where: { id }, data });
    } catch {
      await this.prisma.channelConnection.update({
        where: { id },
        data: { displayName: data.displayName, status: data.status, grantedScopes: data.grantedScopes },
      });
    }
  }

  private async refreshIfNeeded(channelId: string, grantedScopes: string[], tokens: TiktokTokenSet) {
    const stale = tokens.expiresAt !== null && tokens.expiresAt < Date.now() + 30_000;
    if (!stale || !tokens.refreshToken) return tokens;
    const next = await refreshTiktokToken(tokens.refreshToken);
    if (!next) return tokens;
    await this.prisma.channelConnection.update({
      where: { id: channelId },
      data: {
        encryptedSecret: encryptSecret(JSON.stringify(next)),
        grantedScopes: next.scope.length ? next.scope : grantedScopes,
      },
    });
    return next;
  }

  async lookupUser(accessToken: string, fields = TIKTOK_USER_BASIC_FIELDS) {
    const response = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(fields)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return parseTiktokUser(await response.json().catch(() => null));
  }

  async lookupVideos(accessToken: string) {
    const response = await fetch("https://open.tiktokapis.com/v2/video/list/?fields=id,view_count,like_count,comment_count,share_count", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ max_count: 20 }),
    });
    return parseTiktokVideoTotals(await response.json().catch(() => null));
  }

  uiRedirect(query: Record<string, string>) {
    const url = new URL("/channels", webOrigin());
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }
}
