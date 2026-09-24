import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import type { Role, UiLocale } from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { hashPassword, passwordMatches } from "./password.js";
import { PrismaService } from "./prisma.service.js";

export type DemoUser = { id: string; email: string; displayName: string; passwordHash: string; role: Role; disabled: boolean; preferences: { uiLocale: UiLocale; theme: "light" | "dark" | "system"; timezone: string }; grants: { teamIds: string[]; projectIds: string[]; channelIds: string[] }; version: number };
export type Session = { id: string; userId: string; csrfToken: string; expiresAt: number };

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}
  async onModuleInit() {
    await this.prisma.$connect();
    if (process.env.NODE_ENV !== "production") {
      await Promise.all([
        this.seed("11111111-1111-4111-8111-111111111111", "admin@lyonix.local", "Admin LyOnix", "admin", process.env.DEMO_ADMIN_PASSWORD ?? "lyonix-admin"),
        this.seed("22222222-2222-4222-8222-222222222222", "staff@lyonix.local", "Nhân viên Studio", "staff", process.env.DEMO_STAFF_PASSWORD ?? "lyonix-staff"),
      ]);
      await this.grants.ensureDemoGrants().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Không seed được nhóm/kênh demo: ${message}. Chạy prisma migrate deploy rồi khởi động lại API.`);
      });
    }
  }
  private async seed(id: string, email: string, displayName: string, role: Role, password: string) {
    await this.prisma.user.upsert({ where: { email }, update: {}, create: { id, email, displayName, passwordHash: hashPassword(password), role } });
  }
  private map(
    u: { id: string; email: string; displayName: string; passwordHash: string; role: Role; disabled: boolean; uiLocale: string; theme: string; timezone: string; version: number },
    grants = { teamIds: [] as string[], projectIds: [] as string[], channelIds: [] as string[] },
  ): DemoUser {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      passwordHash: u.passwordHash,
      role: u.role,
      disabled: u.disabled,
      preferences: { uiLocale: u.uiLocale as UiLocale, theme: u.theme as "light" | "dark" | "system", timezone: u.timezone },
      grants,
      version: u.version,
    };
  }
  private async withGrants(u: Parameters<AuthService["map"]>[0]) {
    return this.map(u, await this.grants.forUser(u.id, u.role));
  }
  async authenticate(email: string, password: string) {
    const u = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!u || u.disabled || !passwordMatches(password, u.passwordHash)) return null;
    return this.withGrants(u);
  }
  async createSession(userId: string): Promise<Session> {
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    const s = { id: randomUUID(), userId, csrfToken: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 2592000000 };
    await this.prisma.session.create({ data: { ...s, expiresAt: new Date(s.expiresAt) } });
    return s;
  }
  async getSession(id: string | undefined) {
    if (!id) return null;
    const s = await this.prisma.session.findUnique({ where: { id } });
    if (!s || s.revokedAt || s.expiresAt.getTime() < Date.now()) return null;
    return { id: s.id, userId: s.userId, csrfToken: s.csrfToken, expiresAt: s.expiresAt.getTime() };
  }
  async getUser(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    return u ? this.withGrants(u) : null;
  }
  async revoke(id: string | undefined) {
    if (id) await this.prisma.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  async updatePreferences(id: string, p: Partial<DemoUser["preferences"]>) {
    const data = {
      ...(p.uiLocale === undefined ? {} : { uiLocale: p.uiLocale }),
      ...(p.theme === undefined ? {} : { theme: p.theme }),
      ...(p.timezone === undefined ? {} : { timezone: p.timezone }),
      version: { increment: 1 },
    };
    return this.withGrants(await this.prisma.user.update({ where: { id }, data }));
  }
  async changePassword(id: string, current: string, next: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u || !passwordMatches(current, u.passwordHash)) return "invalid" as const;
    if (next.trim().length < 8) return "weak" as const;
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { passwordHash: hashPassword(next), version: { increment: 1 } } }),
      this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return "changed" as const;
  }
}
