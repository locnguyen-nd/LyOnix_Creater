import { describe, expect, it } from "vitest";
import { canDeleteJob, canReviewJob, mergeChannelGrants } from "./grant-access.js";

const empty = () => ({ teamIds: [] as string[], projectIds: [] as string[], channelIds: [] as string[] });

describe("grant access", () => {
  it("lets a person keep channels from every team plus personal grants", () => {
    expect(mergeChannelGrants(["c1"], ["c2", "c1"])).toEqual(["c1", "c2"]);
  });

  it("lets staff review jobs on granted channels they did not create", () => {
    const grants = { teamIds: ["t1"], projectIds: [], channelIds: ["ch-a"] };
    expect(canReviewJob("staff", grants, { ownerUserId: "admin", channelId: "ch-a" }, "staff-1")).toBe(true);
    expect(canReviewJob("staff", grants, { ownerUserId: "admin", channelId: "ch-b" }, "staff-1")).toBe(false);
    expect(canReviewJob("admin", empty(), { ownerUserId: "staff-1", channelId: "ch-b" }, "admin")).toBe(true);
  });

  it("lets owners and admins delete jobs", () => {
    expect(canDeleteJob("staff", { ownerUserId: "staff-1" }, "staff-1")).toBe(true);
    expect(canDeleteJob("staff", { ownerUserId: "admin" }, "staff-1")).toBe(false);
    expect(canDeleteJob("admin", { ownerUserId: "staff-1" }, "admin")).toBe(true);
  });
});
