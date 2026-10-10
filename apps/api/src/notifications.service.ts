import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@lyonix/db";
import type { NotificationListResponse, NotificationResponse } from "@lyonix/contracts";
import { PrismaService } from "./prisma.service.js";

/**
 * VE2E-158: in-app notifications (the dashboard bell). One row per recipient; `(userId, dedupeKey)` is unique, so the same event (e.g. topic X
 * reached Hot) is created once per person whatever the number of runs / API replicas - `createMany(skipDuplicates)` is the whole anti-spam
 * rule. Nothing leaves the app: no e-mail, chat or push service is called.
 */

export type NotificationInput = { kind: string; title: string; body?: string | null; link?: string | null; dedupeKey: string; data?: Record<string, unknown> | null };

const toResponse = (row: { id: string; kind: string; title: string; body: string | null; link: string | null; data: unknown; readAt: Date | null; createdAt: Date }): NotificationResponse => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  link: row.link,
  data: row.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : null,
  readAt: row.readAt ? row.readAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
});

@Injectable()
export class NotificationsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Every active account (approved, not disabled) - Trend Radar topics concern the whole team. */
  async activeUserIds(): Promise<string[]> {
    const users = await this.prisma.user.findMany({ where: { disabled: false, approved: true }, select: { id: true } });
    return users.map((user) => user.id);
  }

  /** Creates the notification for each recipient that does not have it yet; returns how many were really new. */
  async notify(userIds: readonly string[], input: NotificationInput): Promise<number> {
    if (userIds.length === 0) return 0;
    const result = await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        kind: input.kind,
        title: input.title.slice(0, 300),
        body: input.body?.slice(0, 1000) ?? null,
        link: input.link ?? null,
        dedupeKey: input.dedupeKey,
        ...(input.data ? { data: input.data as Prisma.InputJsonValue } : {}),
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async list(userId: string, options: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationListResponse> {
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 30)));
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({ where: { userId, ...(options.unreadOnly ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: limit }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items: rows.map(toResponse), unread };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /** Marks one of the user's own notifications read; false when it is not theirs / does not exist. */
  async markRead(userId: string, id: string): Promise<boolean> {
    const result = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (result.count > 0) return true;
    return (await this.prisma.notification.count({ where: { id, userId } })) > 0;
  }

  async markAllRead(userId: string): Promise<number> {
    return (await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } })).count;
  }
}
