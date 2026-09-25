import { describe, expect, it } from "vitest";
import { formatMetricDisplay } from "./metrics";
import { createSeedState, IDS, SEED_PASSWORDS } from "./seed";
import {
  addProvider,
  applyJobAction,
  changePassword,
  channelPulse,
  createJob,
  dashboardMetrics,
  LOGIN_ERROR_MESSAGE,
  login,
  StudioError,
  deleteTeam,
  upsertOrgUser,
  upsertTeam,
  visibleChannels,
  visibleJobs,
} from "./store";
import type { DashboardMetric } from "./types";

describe("formatMetricDisplay", () => {
  it("does not coerce unavailable revenue to 0", () => {
    const metric: DashboardMetric = {
      id: "revenue_from_views",
      value: null,
      currency: null,
      availability: "not_granted",
      reasonCode: "TIKTOK_SCOPE_NOT_GRANTED",
      missingBaseline: false,
    };
    const result = formatMetricDisplay(metric);
    expect(result.unavailable).toBe(true);
    expect(result.display).not.toBe("0");
    expect(result.reason).toBe("TIKTOK_SCOPE_NOT_GRANTED");
  });
});

describe("people and team allocation fixtures", () => {
  it("assigns an individual user's selected channels without widening access", () => {
    const state = createSeedState();
    const admin = state.users[0]!;
    const next = upsertOrgUser(state, admin, {
      email: "new.staff@lyonix.local",
      displayName: "New staff",
      role: "staff",
      teamId: IDS.TEAM_ID,
      channelIds: [IDS.CHANNEL_B],
      disabled: false,
      password: "safe-pass-123",
    });
    const added = next.users.find((user) => user.email === "new.staff@lyonix.local")!;
    expect(added.grants.channelIds).toEqual([IDS.CHANNEL_B]);
    expect(visibleChannels(next, added).map((channel) => channel.id)).toEqual([IDS.CHANNEL_B]);
  });

  it("keeps a person in every remaining team and their combined channels", () => {
    const state = createSeedState();
    const admin = state.users[0]!;
    const staff = state.users[1]!;
    const twoTeams = upsertOrgUser(state, admin, {
      id: staff.id,
      email: staff.email,
      displayName: staff.displayName,
      role: "staff",
      teamIds: [IDS.TEAM_ID, IDS.TEAM_LABS],
      channelIds: [IDS.CHANNEL_A],
      disabled: false,
    });
    expect(twoTeams.users.find((user) => user.id === staff.id)?.grants.teamIds).toEqual([IDS.TEAM_ID, IDS.TEAM_LABS]);
    expect(twoTeams.orgUsers.find((user) => user.id === staff.id)?.teamIds).toEqual([IDS.TEAM_ID, IDS.TEAM_LABS]);

    const edited = upsertTeam(twoTeams, admin, {
      id: IDS.TEAM_ID,
      name: "Studio updated",
      channelIds: [IDS.CHANNEL_A],
      memberIds: [staff.id, admin.id],
    });
    expect(edited.orgUsers.find((user) => user.id === staff.id)?.teamIds).toContain(IDS.TEAM_LABS);
    expect(edited.users.find((user) => user.id === staff.id)?.grants.channelIds).toEqual(expect.arrayContaining([IDS.CHANNEL_A, IDS.CHANNEL_B]));

    const deleted = deleteTeam(edited, admin, IDS.TEAM_ID);
    expect(deleted.orgUsers.find((user) => user.id === staff.id)?.teamIds).toEqual([IDS.TEAM_LABS]);
    expect(deleted.users.find((user) => user.id === staff.id)?.grants.channelIds).toEqual([IDS.CHANNEL_B]);
  });
});

describe("studio fixture RBAC", () => {
  const state = createSeedState();
  const admin = state.users[0]!;
  const staff = state.users[1]!;

  it("logs in seed roles and hides user existence on bad password", () => {
    expect(login(state, "admin@lyonix.local", SEED_PASSWORDS["admin@lyonix.local"]!).role).toBe("admin");
    expect(login(state, "staff@lyonix.local", SEED_PASSWORDS["staff@lyonix.local"]!).role).toBe("staff");
    try {
      login(state, "admin@lyonix.local", "wrong");
      throw new Error("should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StudioError);
      expect((error as StudioError).message).toBe(LOGIN_ERROR_MESSAGE);
    }
  });

  it("limits staff to granted channels and jobs", () => {
    expect(visibleChannels(state, staff).map((c) => c.id)).toEqual([IDS.CHANNEL_A]);
    expect(visibleJobs(state, staff).some((j) => j.channelId === IDS.CHANNEL_B)).toBe(false);
    expect(visibleJobs(state, admin).some((j) => j.channelId === IDS.CHANNEL_B)).toBe(true);
  });

  it("creates a topic job with prompt and creator, and can rewind a step", () => {
    const created = createJob(state, staff, {
      mode: "topic",
      channelId: IDS.CHANNEL_A,
      topic: "Demo topic",
      promptSpec: "45s, giọng ấm",
      contentLanguage: "vi",
      providerAccountIds: {
        content: IDS.CONTENT_FAKE,
        tts: IDS.TTS_FAKE,
        visual: IDS.VISUAL_FAKE,
        render: IDS.RENDER_FAKE,
      },
    });
    expect(created.jobs[0]?.mode).toBe("topic");
    expect(created.jobs[0]?.createdByUserId).toBe(staff.id);
    expect(created.jobs[0]?.promptSpec).toBe("45s, giọng ấm");
    const switched = applyJobAction(state, admin, "j-1002", "switch_account", {
      providerAccountId: IDS.RENDER_ORG,
    });
    expect(switched.jobs.find((j) => j.id === "j-1002")?.status).toBe("producing");
    const rewind = applyJobAction(state, admin, "j-1001", "rewind");
    expect(rewind.jobs.find((j) => j.id === "j-1001")?.currentStep).toBe("review");
  });

  it("blocks staff from adding organization provider accounts", () => {
    try {
      addProvider(state, staff, {
        name: "Org key",
        provider: "fake_openai",
        role: "content",
        scope: "organization",
        model: "x",
        secret: "sk-demo",
        isFake: true,
      });
      throw new Error("should fail");
    } catch (error) {
      expect((error as StudioError).code).toBe("FORBIDDEN");
    }
  });

  it("returns revenue unavailable on dashboard fixtures", () => {
    const metrics = dashboardMetrics(state, admin, IDS.CHANNEL_A);
    const revenue = metrics.find((m) => m.id === "revenue_from_views");
    expect(revenue?.availability).toBe("not_granted");
    expect(formatMetricDisplay(revenue!).unavailable).toBe(true);
  });

  it("changes channel pulse by period and updates password", () => {
    expect(channelPulse(state, IDS.CHANNEL_A, "1d").views).not.toBe(
      channelPulse(state, IDS.CHANNEL_A, "7d").views,
    );
    const next = changePassword(state, admin, SEED_PASSWORDS[admin.email]!, "new-admin-pass");
    expect(() => login(next, admin.email, "lyonix-admin")).toThrow(StudioError);
    expect(login(next, admin.email, "new-admin-pass").id).toBe(admin.id);
  });
});
