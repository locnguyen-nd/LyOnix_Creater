import type { ErrorCode, UiLocale } from "@lyonix/contracts";
import { createSeedState, IDS } from "./seed";
import { isAttentionStatus } from "./metrics";
import type {
  AuthType,
  Job,
  JobStatus,
  JobStepKey,
  Me,
  ProviderAccount,
  ProviderRole,
  ProviderScope,
  StudioState,
  PeriodKey,
} from "./types";
import { avatarDataUri } from "./avatar";

export const LOGIN_ERROR_MESSAGE = "Email hoặc mật khẩu không đúng";
export const STORAGE_KEY = "lyx-studio-v2";
export const SESSION_KEY = "lyx-session";

export class StudioError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const STEPS: JobStepKey[] = [
  "intake",
  "check",
  "script",
  "review",
  "produce",
  "edit",
  "vrew",
  "done",
];

export function visibleChannels(state: StudioState, me: Me) {
  if (me.role === "admin") return state.channels;
  const allowed = new Set(me.grants.channelIds);
  return state.channels.filter((c) => allowed.has(c.id));
}

export function visibleJobs(state: StudioState, me: Me) {
  const channels = new Set(visibleChannels(state, me).map((c) => c.id));
  return state.jobs.filter((j) => channels.has(j.channelId));
}

export function visibleProviders(state: StudioState, me: Me) {
  return state.providers.filter((p) => {
    if (p.scope === "organization") return true;
    return p.ownerUserId === me.id || me.role === "admin";
  });
}

export function attentionJobs(state: StudioState, me: Me) {
  return visibleJobs(state, me).filter((j) => isAttentionStatus(j.status));
}

export function dashboardMetrics(state: StudioState, me: Me, channelId: string | "all") {
  const channels = visibleChannels(state, me);
  const selected =
    channelId === "all" ? channels[0] : channels.find((c) => c.id === channelId);
  if (!selected) return [];
  return state.metricsByChannel[selected.id] ?? [];
}

function stamp(): string {
  return new Date().toISOString();
}

function nextCode(jobs: Job[]): string {
  const n = jobs.length + 1001;
  return `JOB-${n}`;
}

export function login(state: StudioState, email: string, password: string): Me {
  const key = email.trim().toLowerCase();
  const expected = state.passwords[key];
  if (!expected || expected !== password) {
    throw new StudioError("UNAUTHENTICATED", LOGIN_ERROR_MESSAGE);
  }
  const user = state.users.find((u) => u.email === key);
  if (!user) throw new StudioError("UNAUTHENTICATED", LOGIN_ERROR_MESSAGE);
  const org = state.orgUsers.find((row) => row.id === user.id);
  if (org?.disabled) throw new StudioError("FORBIDDEN", "Tài khoản đã vô hiệu");
  return user;
}

export function channelPulse(state: StudioState, channelId: string, period: PeriodKey) {
  return (
    state.periodStats[channelId]?.[period] ?? {
      views: 0,
      likes: 0,
      comments: 0,
      series: [],
    }
  );
}

export function creatorLabel(state: StudioState, userId: string): string {
  const user = state.users.find((u) => u.id === userId) ?? state.orgUsers.find((u) => u.id === userId);
  if (!user) return userId;
  return "displayName" in user && user.displayName ? user.displayName : user.email;
}

export function createJob(
  state: StudioState,
  me: Me,
  input: {
    mode: Job["mode"];
    channelId: string;
    topic: string;
    promptSpec?: string;
    contentLanguage: UiLocale;
    providerAccountIds: Job["providerAccountIds"];
  },
): StudioState {
  const channels = visibleChannels(state, me);
  if (!channels.some((c) => c.id === input.channelId)) {
    throw new StudioError("NOT_FOUND", "Kênh không tồn tại");
  }
  if (!input.topic.trim()) {
    throw new StudioError("VALIDATION_FAILED", "Thiếu chủ đề");
  }
  const id = crypto.randomUUID();
  const job: Job = {
    id,
    code: nextCode(state.jobs),
    mode: input.mode,
    topic: input.topic.trim(),
    channelId: input.channelId,
    projectId: IDS.PROJECT_ID,
    status: "accepted",
    currentStep: "intake",
    providerAccountIds: input.providerAccountIds,
    updatedAt: stamp(),
    events: [{ id: crypto.randomUUID(), at: stamp(), message: "Tạo việc" }],
    script: {
      hook: input.topic,
      body: "",
      cta: "",
      title: input.topic,
      caption: "",
      version: 1,
      approvedVersion: null,
      scenes: [
        {
          sceneId: "scene-1",
          narration: "",
          screenText: input.topic,
          visualBrief: "",
        },
      ],
    },
    vrewUrl: null,
    contentLanguage: input.contentLanguage,
    createdByUserId: me.id,
    promptSpec: input.promptSpec?.trim() ?? "",
  };
  return { ...state, jobs: [job, ...state.jobs] };
}

export function applyJobAction(
  state: StudioState,
  me: Me,
  jobId: string,
  action: "approve" | "resume" | "cancel" | "switch_account" | "rewind",
  extra?: { providerAccountId?: string; reason?: string },
): StudioState {
  const job = visibleJobs(state, me).find((j) => j.id === jobId);
  if (!job) throw new StudioError("NOT_FOUND", "Không tìm thấy việc");

  if (action === "switch_account") {
    if (job.status !== "blocked_provider") {
      throw new StudioError("INVALID_STATE", "Chỉ đổi tài khoản khi bị chặn provider");
    }
    const account = visibleProviders(state, me).find((p) => p.id === extra?.providerAccountId);
    if (!account) throw new StudioError("NOT_FOUND", "Không có tài khoản");
    const next: Job = {
      ...job,
      status: "producing",
      currentStep: "produce",
      providerAccountIds: { ...job.providerAccountIds, [account.role]: account.id },
      updatedAt: stamp(),
      events: [
        {
          id: crypto.randomUUID(),
          at: stamp(),
          message: `Đổi tài khoản ${account.role}: ${account.name}`,
        },
        ...job.events,
      ],
    };
    return { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? next : j)) };
  }

  if (action === "rewind") {
    const idx = STEPS.indexOf(job.currentStep);
    if (idx <= 0 || job.status === "cancelled") {
      throw new StudioError("INVALID_STATE", "Không thể quay lại bước trước");
    }
    const prevStep = STEPS[idx - 1] ?? "intake";
    const next: Job = {
      ...job,
      currentStep: prevStep,
      status: prevStep === "review" ? "awaiting_staff_ack" : "producing",
      updatedAt: stamp(),
      events: [{ id: crypto.randomUUID(), at: stamp(), message: "Quay lại bước trước" }, ...job.events],
    };
    return { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? next : j)) };
  }

  if (action === "cancel") {
    const next: Job = {
      ...job,
      status: "cancelled",
      updatedAt: stamp(),
      events: [{ id: crypto.randomUUID(), at: stamp(), message: "Hủy việc" }, ...job.events],
    };
    return { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? next : j)) };
  }

  if (action === "approve") {
    const idx = STEPS.indexOf(job.currentStep);
    const nextStep = STEPS[Math.min(idx + 1, STEPS.length - 1)] ?? "done";
    const next: Job = {
      ...job,
      currentStep: nextStep,
      status: nextStep === "done" ? "completed" : "producing",
      updatedAt: stamp(),
      events: [{ id: crypto.randomUUID(), at: stamp(), message: "Duyệt bước" }, ...job.events],
    };
    return { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? next : j)) };
  }

  const next: Job = {
    ...job,
    status: "producing",
    updatedAt: stamp(),
    events: [{ id: crypto.randomUUID(), at: stamp(), message: "Tiếp tục" }, ...job.events],
  };
  return { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? next : j)) };
}

export function connectChannel(
  state: StudioState,
  me: Me,
  input: { name: string; handle: string; authType: AuthType },
): StudioState {
  if (me.role !== "admin") throw new StudioError("FORBIDDEN", "Không có quyền");
  const channel = {
    id: crypto.randomUUID(),
    name: input.name,
    handle: input.handle,
    avatarUrl: avatarDataUri(input.name),
    authType: input.authType,
    connected: true,
    lastSyncAt: null,
    coverageLabel: "—",
    projectId: IDS.PROJECT_ID,
    teamId: me.grants.teamIds[0] ?? IDS.TEAM_ID,
  };
  const users = state.users.map((u) =>
    u.role === "admin"
      ? { ...u, grants: { ...u.grants, channelIds: [...u.grants.channelIds, channel.id] } }
      : u,
  );
  const emptyPulse = {
    "1d": { views: 0, likes: 0, comments: 0, series: [1, 2, 2, 3, 3, 4, 5, 4, 6, 7, 8, 9] },
    "7d": { views: 0, likes: 0, comments: 0, series: [2, 3, 4, 5, 4, 6, 7, 8, 7, 9, 10, 12] },
    "30d": { views: 0, likes: 0, comments: 0, series: [4, 5, 6, 7, 8, 7, 9, 10, 11, 12, 13, 14] },
    "90d": { views: 0, likes: 0, comments: 0, series: [8, 9, 10, 11, 12, 13, 12, 14, 15, 16, 17, 18] },
  };
  return {
    ...state,
    channels: [...state.channels, channel],
    users,
    periodStats: { ...state.periodStats, [channel.id]: emptyPulse },
  };
}

export function syncChannel(state: StudioState, me: Me, channelId: string): StudioState {
  const channel = visibleChannels(state, me).find((c) => c.id === channelId);
  if (!channel) throw new StudioError("NOT_FOUND", "Không tìm thấy kênh");
  return {
    ...state,
    channels: state.channels.map((c) =>
      c.id === channelId ? { ...c, lastSyncAt: stamp(), coverageLabel: "1 mẫu", connected: true } : c,
    ),
  };
}

export function addProvider(
  state: StudioState,
  me: Me,
  input: {
    name: string;
    provider: string;
    role: ProviderRole;
    scope: ProviderScope;
    model: string;
    secret: string;
    isFake: boolean;
  },
): StudioState {
  if (input.scope === "organization" && me.role !== "admin") {
    throw new StudioError("FORBIDDEN", "Không có quyền");
  }
  if (!input.secret.trim()) {
    throw new StudioError("VALIDATION_FAILED", "Thiếu khóa");
  }
  const account: ProviderAccount = {
    id: crypto.randomUUID(),
    name: input.name,
    provider: input.provider,
    role: input.role,
    scope: input.scope,
    ownerUserId: me.id,
    status: "unverified",
    model: input.model,
    quotaRemaining: null,
    quotaUnit: "%",
    isFake: input.isFake,
    secretMasked: true,
    version: 1,
  };
  return { ...state, providers: [account, ...state.providers] };
}

export function verifyProvider(state: StudioState, me: Me, id: string): StudioState {
  const account = visibleProviders(state, me).find((p) => p.id === id);
  if (!account) throw new StudioError("NOT_FOUND", "Không tìm thấy account");
  if (account.scope === "organization" && me.role !== "admin" && account.ownerUserId !== me.id) {
    throw new StudioError("FORBIDDEN", "Không có quyền");
  }
  return {
    ...state,
    providers: state.providers.map((p) =>
      p.id === id ? { ...p, status: "verified", quotaRemaining: p.quotaRemaining ?? 70 } : p,
    ),
  };
}

export function updatePreferences(
  state: StudioState,
  me: Me,
  patch: Partial<Me["preferences"]>,
): { state: StudioState; me: Me } {
  const nextMe: Me = {
    ...me,
    preferences: { ...me.preferences, ...patch },
    version: me.version + 1,
  };
  return {
    me: nextMe,
    state: {
      ...state,
      users: state.users.map((u) => (u.id === me.id ? nextMe : u)),
    },
  };
}

export function updateProfile(
  state: StudioState,
  me: Me,
  patch: { displayName: string; timezone?: string },
): { state: StudioState; me: Me } {
  const nextMe: Me = {
    ...me,
    displayName: patch.displayName.trim() || me.displayName,
    preferences: {
      ...me.preferences,
      timezone: patch.timezone ?? me.preferences.timezone,
    },
    version: me.version + 1,
  };
  return {
    me: nextMe,
    state: {
      ...state,
      users: state.users.map((u) => (u.id === me.id ? nextMe : u)),
      orgUsers: state.orgUsers.map((u) =>
        u.id === me.id ? { ...u, displayName: nextMe.displayName } : u,
      ),
    },
  };
}

export function changePassword(
  state: StudioState,
  me: Me,
  currentPassword: string,
  nextPassword: string,
): StudioState {
  if (state.passwords[me.email] !== currentPassword) {
    throw new StudioError("UNAUTHENTICATED", "Mật khẩu hiện tại không đúng");
  }
  if (nextPassword.trim().length < 8) {
    throw new StudioError("VALIDATION_FAILED", "Mật khẩu mới tối thiểu 8 ký tự");
  }
  return {
    ...state,
    passwords: { ...state.passwords, [me.email]: nextPassword },
  };
}

const teamIdsOf = (user: { teamIds?: string[]; teamId: string }) =>
  [...new Set(user.teamIds?.length ? user.teamIds : user.teamId ? [user.teamId] : [])];

export function upsertOrgUser(
  state: StudioState,
  me: Me,
  input: {
    id?: string;
    email: string;
    displayName: string;
    role: Me["role"];
    teamId?: string;
    teamIds?: string[];
    channelIds?: string[];
    availableChannelIds?: string[];
    disabled: boolean;
    password?: string;
  },
): StudioState {
  if (me.role !== "admin") throw new StudioError("FORBIDDEN", "Không có quyền");
  const teamIds = [...new Set(input.teamIds ?? (input.teamId ? [input.teamId] : []))];
  if (teamIds.some((teamId) => !state.teams.some((team) => team.id === teamId))) {
    throw new StudioError("NOT_FOUND", "Không tìm thấy nhóm");
  }
  const email = input.email.trim().toLowerCase();
  if (!email || !input.displayName.trim()) throw new StudioError("VALIDATION_FAILED", "Thiếu email hoặc tên hiển thị");
  const id = input.id ?? crypto.randomUUID();
  if (state.orgUsers.some((user) => user.id !== id && user.email === email)) {
    throw new StudioError("VALIDATION_FAILED", "Email đã được sử dụng");
  }
  const teamChannels = state.teams.filter((team) => teamIds.includes(team.id)).flatMap((team) => team.channelIds);
  const channelIds = [...new Set(input.channelIds ?? teamChannels)];
  const availableChannelIds = new Set(input.availableChannelIds ?? state.channels.map((channel) => channel.id));
  if (channelIds.some((channelId) => !availableChannelIds.has(channelId))) {
    throw new StudioError("NOT_FOUND", "Kênh được gán không tồn tại");
  }
  const orgUser = {
    id,
    email,
    displayName: input.displayName.trim(),
    role: input.role,
    teamId: teamIds[0] ?? "",
    teamIds,
    channelIds,
    disabled: input.disabled,
  };
  const existing = state.orgUsers.some((u) => u.id === id);
  const orgUsers = existing
    ? state.orgUsers.map((u) => (u.id === id ? orgUser : u))
    : [...state.orgUsers, orgUser];
  const sessionUser: Me = {
    id,
    email: orgUser.email,
    displayName: orgUser.displayName,
    role: orgUser.role,
    preferences: {
      uiLocale: "vi",
      theme: "system",
      timezone: state.orgTimezone,
    },
    grants: {
      teamIds,
      projectIds: [IDS.PROJECT_ID],
      channelIds,
    },
    version: 1,
  };
  const users = state.users.some((u) => u.id === id)
    ? state.users.map((u) =>
        u.id === id
          ? {
              ...u,
              email: orgUser.email,
              displayName: orgUser.displayName,
              role: orgUser.role,
              grants: { ...u.grants, teamIds, channelIds },
            }
          : u,
      )
    : [...state.users, sessionUser];
  const teams = state.teams.map((t) => ({
    ...t,
    memberIds: [...new Set([...t.memberIds.filter((memberId) => memberId !== id), ...(teamIds.includes(t.id) ? [id] : [])])],
  }));
  const passwords =
    input.password && !existing
      ? { ...state.passwords, [orgUser.email]: input.password }
      : state.passwords;
  return { ...state, orgUsers, users, teams, passwords };
}

export function deleteOrgUser(state: StudioState, me: Me, id: string): StudioState {
  if (me.role !== "admin") throw new StudioError("FORBIDDEN", "Không có quyền");
  if (id === me.id) throw new StudioError("INVALID_STATE", "Không xóa chính mình");
  const user = state.orgUsers.find((u) => u.id === id);
  return {
    ...state,
    orgUsers: state.orgUsers.filter((u) => u.id !== id),
    users: state.users.filter((u) => u.id !== id),
    teams: state.teams.map((t) => ({ ...t, memberIds: t.memberIds.filter((memberId) => memberId !== id) })),
    passwords: user
      ? Object.fromEntries(Object.entries(state.passwords).filter(([email]) => email !== user.email))
      : state.passwords,
  };
}

export function upsertTeam(
  state: StudioState,
  me: Me,
  input: { id?: string; name: string; channelIds: string[]; memberIds: string[]; availableChannelIds?: string[] },
): StudioState {
  if (me.role !== "admin") throw new StudioError("FORBIDDEN", "Không có quyền");
  const id = input.id ?? crypto.randomUUID();
  const name = input.name.trim();
  if (!name) throw new StudioError("VALIDATION_FAILED", "Thiếu tên nhóm");
  const channelIds = [...new Set(input.channelIds)];
  const memberIds = [...new Set(input.memberIds)];
  const availableChannelIds = new Set(input.availableChannelIds ?? state.channels.map((channel) => channel.id));
  if (channelIds.some((channelId) => !availableChannelIds.has(channelId))) {
    throw new StudioError("NOT_FOUND", "Kênh được gán không tồn tại");
  }
  if (memberIds.some((memberId) => !state.orgUsers.some((user) => user.id === memberId))) {
    throw new StudioError("NOT_FOUND", "Thành viên không tồn tại");
  }
  const team = {
    id,
    name,
    projectNames: ["MVP Demo"],
    channelIds,
    memberIds,
  };
  const teams = state.teams.some((t) => t.id === id)
    ? state.teams.map((t) => (t.id === id ? team : t))
    : [...state.teams, team];
  const orgUsers = state.orgUsers.map((user) => {
    const current = teamIdsOf(user).filter((teamId) => teamId !== id);
    const nextTeamIds = memberIds.includes(user.id) ? [...current, id] : current;
    const assigned = teams.filter((item) => nextTeamIds.includes(item.id));
    const nextChannels = [...new Set(assigned.flatMap((item) => item.channelIds))];
    return { ...user, teamIds: nextTeamIds, teamId: nextTeamIds[0] ?? "", channelIds: nextChannels };
  });
  const users = state.users.map((user) => {
    const orgUser = orgUsers.find((item) => item.id === user.id);
    return !orgUser
      ? user
      : { ...user, grants: { ...user.grants, teamIds: orgUser.teamIds, channelIds: orgUser.channelIds } };
  });
  return { ...state, teams, orgUsers, users };
}

export function deleteTeam(state: StudioState, me: Me, id: string): StudioState {
  if (me.role !== "admin") throw new StudioError("FORBIDDEN", "Không có quyền");
  if (state.teams.length <= 1) throw new StudioError("INVALID_STATE", "Cần ít nhất một nhóm");
  const teams = state.teams.filter((team) => team.id !== id);
  const orgUsers = state.orgUsers.map((user) => {
    const nextTeamIds = teamIdsOf(user).filter((teamId) => teamId !== id);
    const assigned = teams.filter((item) => nextTeamIds.includes(item.id));
    return {
      ...user,
      teamIds: nextTeamIds,
      teamId: nextTeamIds[0] ?? "",
      channelIds: [...new Set(assigned.flatMap((item) => item.channelIds))],
    };
  });
  const users = state.users.map((user) => {
    const orgUser = orgUsers.find((item) => item.id === user.id);
    return !orgUser
      ? user
      : { ...user, grants: { ...user.grants, teamIds: orgUser.teamIds, channelIds: orgUser.channelIds } };
  });
  return { ...state, teams: teams.map((team) => ({ ...team, memberIds: orgUsers.filter((user) => teamIdsOf(user).includes(team.id)).map((user) => user.id) })), orgUsers, users };
}

export function updateOrgSettings(state: StudioState, me: Me, timezone: string): StudioState {
  if (me.role !== "admin") throw new StudioError("FORBIDDEN", "Không có quyền");
  return { ...state, orgTimezone: timezone };
}

export function updateScript(
  state: StudioState,
  me: Me,
  jobId: string,
  script: Job["script"],
): StudioState {
  const job = visibleJobs(state, me).find((j) => j.id === jobId);
  if (!job) throw new StudioError("NOT_FOUND", "Không tìm thấy việc");
  const next: Job = {
    ...job,
    script: { ...script, version: job.script.version + 1, approvedVersion: null },
    updatedAt: stamp(),
  };
  return { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? next : j)) };
}

export function approveScript(state: StudioState, me: Me, jobId: string): StudioState {
  const job = visibleJobs(state, me).find((j) => j.id === jobId);
  if (!job) throw new StudioError("NOT_FOUND", "Không tìm thấy việc");
  const next: Job = {
    ...job,
    status: "producing",
    currentStep: "produce",
    script: { ...job.script, approvedVersion: job.script.version },
    updatedAt: stamp(),
    events: [{ id: crypto.randomUUID(), at: stamp(), message: `Đã duyệt kịch bản phiên bản v${job.script.version}. Việc chuyển sang bước sản xuất.` }, ...job.events],
  };
  return { ...state, jobs: state.jobs.map((j) => (j.id === jobId ? next : j)) };
}

export function simulateRender(state: StudioState, me: Me, jobId: string): StudioState {
  const job = visibleJobs(state, me).find((j) => j.id === jobId);
  if (!job) throw new StudioError("NOT_FOUND", "Không tìm thấy việc");
  const next: Job = {
    ...job,
    status: "rendering_vrew",
    currentStep: "vrew",
    updatedAt: stamp(),
    events: [
      { id: crypto.randomUUID(), at: stamp(), message: "Gửi render Fake Vrew (mô phỏng)" },
      ...job.events,
    ],
  };
  const artifact = {
    id: crypto.randomUUID(),
    jobId,
    channelId: job.channelId,
    durationLabel: "45s",
    qc: "pending",
    vrewUrl: null as string | null,
    renderStatus: "fake_simulated",
  };
  return {
    ...state,
    jobs: state.jobs.map((j) => (j.id === jobId ? next : j)),
    artifacts: [artifact, ...state.artifacts],
  };
}

export function filterJobs(
  jobs: Job[],
  query: { q?: string; status?: JobStatus | "all" | "running" | "blocked" | "done" | "error" | "review" },
): Job[] {
  return jobs.filter((j) => {
    if (query.q) {
      const q = query.q.toLowerCase();
      if (!`${j.code} ${j.topic}`.toLowerCase().includes(q)) return false;
    }
    const tab = query.status;
    if (!tab || tab === "all") return true;
    if (tab === "running") {
      return ["accepted", "validating", "transcribing", "scripting", "producing", "editing", "rendering_vrew", "verifying"].includes(j.status);
    }
    if (tab === "review") return j.status === "awaiting_staff_ack";
    if (tab === "blocked") return j.status === "blocked_provider" || j.status === "needs_attention";
    if (tab === "done") return j.status === "completed";
    if (tab === "error") return j.status === "failed";
    return j.status === tab;
  });
}

export function loadPersistedState(): StudioState {
  if (typeof localStorage === "undefined") return createSeedState();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createSeedState();
  try {
    return JSON.parse(raw) as StudioState;
  } catch {
    return createSeedState();
  }
}

export function persistState(state: StudioState) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
