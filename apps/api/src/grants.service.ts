import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";
import { mergeChannelGrants, uniqueIds, type GrantSet, type Role } from "./grant-access.js";
import { hashPassword } from "./password.js";

const STUDIO_TEAM = "33333333-3333-4333-8333-333333333333";
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";

@Injectable()
export class GrantsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async forUser(userId: string, role: Role): Promise<GrantSet> {
    if (role === "admin") {
      const channels = await this.prisma.channelConnection.findMany({ select: { id: true } });
      const teams = await this.prisma.team.findMany({ select: { id: true } });
      return { teamIds: teams.map((item) => item.id), projectIds: [], channelIds: channels.map((item) => item.id) };
    }
    const [memberships, direct] = await Promise.all([
      this.prisma.teamMember.findMany({ where: { userId }, include: { team: { include: { channels: true } } } }),
      this.prisma.userChannelGrant.findMany({ where: { userId } }),
    ]);
    return {
      teamIds: memberships.map((item) => item.teamId),
      projectIds: [],
      channelIds: mergeChannelGrants(
        direct.map((item) => item.channelId),
        memberships.flatMap((item) => item.team.channels.map((link) => link.channelId)),
      ),
    };
  }

  async listTeams() {
    const teams = await this.prisma.team.findMany({ include: { members: true, channels: true }, orderBy: { name: "asc" } });
    return teams.map((team) => ({
      id: team.id,
      name: team.name,
      memberIds: team.members.map((item) => item.userId),
      channelIds: team.channels.map((item) => item.channelId),
    }));
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({ include: { teamMembers: true, channelGrants: true }, orderBy: { email: "asc" } });
    const teams = await this.listTeams();
    return users.map((user) => {
      const teamIds = user.teamMembers.map((item) => item.teamId);
      const teamChannels = teams.filter((team) => teamIds.includes(team.id)).flatMap((team) => team.channelIds);
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        disabled: user.disabled,
        teamIds,
        directChannelIds: user.channelGrants.map((item) => item.channelId),
        channelIds: mergeChannelGrants(user.channelGrants.map((item) => item.channelId), teamChannels),
      };
    });
  }

  async replaceUserGrants(userId: string, teamIds: string[], channelIds: string[]) {
    await this.prisma.$transaction([
      this.prisma.teamMember.deleteMany({ where: { userId } }),
      this.prisma.userChannelGrant.deleteMany({ where: { userId } }),
      ...uniqueIds(teamIds).map((teamId) => this.prisma.teamMember.create({ data: { userId, teamId } })),
      ...uniqueIds(channelIds).map((channelId) => this.prisma.userChannelGrant.create({ data: { userId, channelId } })),
    ]);
    return this.forUser(userId, "staff");
  }

  async upsertTeam(input: { id?: string; name: string; memberIds: string[]; channelIds: string[] }) {
    const name = input.name.trim();
    const team = input.id
      ? await this.prisma.team.update({ where: { id: input.id }, data: { name } })
      : await this.prisma.team.create({ data: { name } });
    await this.prisma.$transaction([
      this.prisma.teamMember.deleteMany({ where: { teamId: team.id } }),
      this.prisma.teamChannel.deleteMany({ where: { teamId: team.id } }),
      ...uniqueIds(input.memberIds).map((userId) => this.prisma.teamMember.create({ data: { userId, teamId: team.id } })),
      ...uniqueIds(input.channelIds).map((channelId) => this.prisma.teamChannel.create({ data: { teamId: team.id, channelId } })),
    ]);
    return (await this.listTeams()).find((item) => item.id === team.id)!;
  }

  async deleteTeam(id: string) {
    const count = await this.prisma.team.count();
    if (count <= 1) return "last" as const;
    await this.prisma.team.delete({ where: { id } });
    return "deleted" as const;
  }

  async createUser(input: { email: string; displayName: string; role: Role; password: string; disabled?: boolean; teamIds: string[]; channelIds: string[] }) {
    const email = input.email.trim().toLowerCase();
    if (!email || !input.displayName.trim() || input.password.trim().length < 8) return "invalid" as const;
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) return "duplicate" as const;
    const user = await this.prisma.user.create({
      data: { email, displayName: input.displayName.trim(), role: input.role, disabled: Boolean(input.disabled), passwordHash: hashPassword(input.password) },
    });
    await this.replaceUserGrants(user.id, input.teamIds, input.channelIds);
    return (await this.listUsers()).find((item) => item.id === user.id)!;
  }

  async updateUser(id: string, input: { displayName?: string; role?: Role; disabled?: boolean; teamIds?: string[]; channelIds?: string[] }) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return null;
    await this.prisma.user.update({
      where: { id },
      data: {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
      },
    });
    if (input.teamIds !== undefined || input.channelIds !== undefined) {
      const current = await this.prisma.user.findUnique({ where: { id }, include: { teamMembers: true, channelGrants: true } });
      await this.replaceUserGrants(
        id,
        input.teamIds ?? current?.teamMembers.map((item) => item.teamId) ?? [],
        input.channelIds ?? current?.channelGrants.map((item) => item.channelId) ?? [],
      );
    }
    return (await this.listUsers()).find((item) => item.id === id)!;
  }

  async deleteUser(id: string, actorId: string) {
    if (id === actorId) return "self" as const;
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return null;
    await this.prisma.user.delete({ where: { id } });
    return "deleted" as const;
  }

  async shareChannel(channelId: string) {
    await this.prisma.team.upsert({ where: { id: STUDIO_TEAM }, update: {}, create: { id: STUDIO_TEAM, name: "Studio LyOnix" } });
    await this.prisma.teamChannel.upsert({
      where: { teamId_channelId: { teamId: STUDIO_TEAM, channelId } },
      update: {},
      create: { teamId: STUDIO_TEAM, channelId },
    });
  }

  async ensureDemoGrants() {
    await this.prisma.team.upsert({ where: { id: STUDIO_TEAM }, update: { name: "Studio LyOnix" }, create: { id: STUDIO_TEAM, name: "Studio LyOnix" } });
    await this.prisma.teamMember.upsert({ where: { userId_teamId: { userId: ADMIN_ID, teamId: STUDIO_TEAM } }, update: {}, create: { userId: ADMIN_ID, teamId: STUDIO_TEAM } });
    await this.prisma.teamMember.upsert({ where: { userId_teamId: { userId: STAFF_ID, teamId: STUDIO_TEAM } }, update: {}, create: { userId: STAFF_ID, teamId: STUDIO_TEAM } });
    const channels = await this.prisma.channelConnection.findMany({ select: { id: true } });
    for (const channel of channels) {
      await this.prisma.teamChannel.upsert({
        where: { teamId_channelId: { teamId: STUDIO_TEAM, channelId: channel.id } },
        update: {},
        create: { teamId: STUDIO_TEAM, channelId: channel.id },
      });
    }
  }
}
