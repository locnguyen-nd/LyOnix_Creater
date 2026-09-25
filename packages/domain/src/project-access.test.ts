import { describe, expect, it } from "vitest";
import { canAccessProject, canManageProject, canWriteProjectResource } from "./project-access.js";

describe("canAccessProject", () => {
  it("admin can access any project", () => {
    expect(canAccessProject("admin", { projectIds: [] }, "p1")).toBe(true);
  });
  it("staff needs an explicit grant", () => {
    expect(canAccessProject("staff", { projectIds: ["p1"] }, "p1")).toBe(true);
    expect(canAccessProject("staff", { projectIds: ["p2"] }, "p1")).toBe(false);
  });
});

describe("canManageProject", () => {
  it("only admin manages project lifecycle", () => {
    expect(canManageProject("admin")).toBe(true);
    expect(canManageProject("staff")).toBe(false);
  });
});

describe("canWriteProjectResource", () => {
  it("mirrors access grant for writes", () => {
    expect(canWriteProjectResource("staff", { projectIds: ["p1"] }, "p1")).toBe(true);
    expect(canWriteProjectResource("staff", { projectIds: [] }, "p1")).toBe(false);
  });
});
