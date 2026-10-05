export type Role = "admin" | "staff";
export type ProjectGrantSet = { projectIds: string[] };

/** Admin has access to every project; staff only to projects granted directly or via team. */
export const canAccessProject = (role: Role, grants: ProjectGrantSet, projectId: string): boolean =>
  role === "admin" || grants.projectIds.includes(projectId);

/** Only admin creates/archives projects and manages project grants in this slice. */
export const canManageProject = (role: Role): boolean => role === "admin";

export const canWriteProjectResource = (role: Role, grants: ProjectGrantSet, projectId: string): boolean =>
  canAccessProject(role, grants, projectId);
