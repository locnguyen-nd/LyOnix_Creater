export type Role = "admin" | "staff";
export type GrantSet = { teamIds: string[]; projectIds: string[]; channelIds: string[] };

export const uniqueIds = (ids: Array<string | null | undefined>) => [...new Set(ids.filter((id): id is string => Boolean(id)))];

export const emptyGrants = (): GrantSet => ({ teamIds: [], projectIds: [], channelIds: [] });

export const mergeChannelGrants = (directChannelIds: string[], teamChannelIds: string[]) =>
  uniqueIds([...directChannelIds, ...teamChannelIds]);

export const canAccessChannel = (role: Role, grants: GrantSet, channelId: string | null | undefined) => {
  if (role === "admin") return true;
  if (!channelId) return false;
  return grants.channelIds.includes(channelId);
};

export const canReviewJob = (role: Role, grants: GrantSet, job: { ownerUserId: string; channelId: string }, userId: string) => {
  if (role === "admin") return true;
  return job.ownerUserId === userId || canAccessChannel(role, grants, job.channelId);
};

export const canDeleteJob = (role: Role, job: { ownerUserId: string }, userId: string) =>
  role === "admin" || job.ownerUserId === userId;
