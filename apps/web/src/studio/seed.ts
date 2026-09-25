import type { DashboardMetric, Job, PeriodKey, ScriptDraft, StudioState } from "./types";
import { avatarDataUri, imageThumbUri } from "./avatar";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "33333333-3333-4333-8333-333333333333";
const TEAM_LABS = "33333333-3333-4333-8333-333333333334";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const CHANNEL_A = "55555555-5555-4555-8555-555555555555";
const CHANNEL_B = "66666666-6666-4666-8666-666666666666";
const CONTENT_FAKE = "77777777-7777-4777-8777-777777777777";
const TTS_FAKE = "88888888-8888-4888-8888-888888888888";
const VISUAL_FAKE = "99999999-9999-4999-8999-999999999999";
const RENDER_FAKE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RENDER_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const now = "2026-09-19T10:00:00Z";

const script = (topic: string): ScriptDraft => ({
  hook: `${topic} — hook`,
  body: "Nội dung chính cho bản nháp.",
  cta: "Theo dõi kênh để xem phần tiếp.",
  title: topic,
  caption: `#lyonix ${topic}`,
  version: 1,
  approvedVersion: null,
  scenes: [
    {
      sceneId: "scene-1",
      narration: "Mở đầu.",
      screenText: topic,
      visualBrief: "Close-up, 9:16",
    },
    {
      sceneId: "scene-2",
      narration: "Thân bài.",
      screenText: "Điểm chính",
      visualBrief: "B-roll desk",
    },
  ],
});

const job = (
  id: string,
  code: string,
  topic: string,
  channelId: string,
  status: Job["status"],
  currentStep: Job["currentStep"],
  extra?: Partial<Job>,
): Job => ({
  id,
  code,
  mode: "topic",
  topic,
  channelId,
  projectId: PROJECT_ID,
  status,
  currentStep,
  providerAccountIds: {
    content: CONTENT_FAKE,
    tts: TTS_FAKE,
    visual: VISUAL_FAKE,
    render: RENDER_FAKE,
  },
  updatedAt: now,
  events: [{ id: `${id}-e1`, at: now, message: "Tạo việc (fixture)" }],
  script: script(topic),
  vrewUrl: null,
  contentLanguage: "vi",
  createdByUserId: ADMIN_ID,
  promptSpec: "Giọng tự nhiên, cắt 45s, CTA cuối video.",
  ...extra,
});

const kpiAvailable = (): DashboardMetric[] => [
  {
    id: "views",
    value: "128400",
    currency: null,
    availability: "available",
    reasonCode: null,
    missingBaseline: false,
  },
  {
    id: "engagement",
    value: "4.2%",
    currency: null,
    availability: "available",
    reasonCode: null,
    missingBaseline: false,
  },
  {
    id: "followerDelta",
    value: "+210",
    currency: null,
    availability: "available",
    reasonCode: null,
    missingBaseline: true,
  },
  {
    id: "revenue_from_views",
    value: null,
    currency: null,
    availability: "not_granted",
    reasonCode: "TIKTOK_SCOPE_NOT_GRANTED",
    missingBaseline: false,
  },
];

const pulse = (views: number, likes: number, comments: number, series: number[]) => ({
  views,
  likes,
  comments,
  series,
});

const periodsFor = (factor: number): Record<PeriodKey, ReturnType<typeof pulse>> => ({
  "1d": pulse(8200 * factor, 410 * factor, 38 * factor, [6, 8, 7, 9, 11, 10, 12, 14, 13, 15, 16, 18].map((n) => n * factor)),
  "7d": pulse(48200 * factor, 2100 * factor, 190 * factor, [18, 22, 19, 25, 28, 24, 30, 33, 29, 35, 38, 40].map((n) => n * factor)),
  "30d": pulse(128400 * factor, 5400 * factor, 620 * factor, [40, 42, 38, 48, 52, 49, 55, 60, 58, 63, 66, 70].map((n) => n * factor)),
  "90d": pulse(310000 * factor, 12800 * factor, 1540 * factor, [70, 74, 68, 80, 88, 84, 92, 98, 94, 102, 110, 118].map((n) => n * factor)),
});

export const SEED_PASSWORDS: Record<string, string> = {
  "admin@lyonix.local": "lyonix-admin",
  "staff@lyonix.local": "lyonix-staff",
};

export function createSeedState(): StudioState {
  return {
    users: [
      {
        id: ADMIN_ID,
        email: "admin@lyonix.local",
        displayName: "Admin LyOnix",
        role: "admin",
        preferences: {
          uiLocale: "vi",
          theme: "system",
          timezone: "Asia/Ho_Chi_Minh",
        },
        grants: {
          teamIds: [TEAM_ID, TEAM_LABS],
          projectIds: [PROJECT_ID],
          channelIds: [CHANNEL_A, CHANNEL_B],
        },
        version: 1,
      },
      {
        id: STAFF_ID,
        email: "staff@lyonix.local",
        displayName: "Nhân viên Studio",
        role: "staff",
        preferences: {
          uiLocale: "vi",
          theme: "system",
          timezone: "Asia/Ho_Chi_Minh",
        },
        grants: {
          teamIds: [TEAM_ID],
          projectIds: [PROJECT_ID],
          channelIds: [CHANNEL_A],
        },
        version: 1,
      },
    ],
    passwords: { ...SEED_PASSWORDS },
    channels: [
      {
        id: CHANNEL_A,
        name: "LyOnix Shorts",
        handle: "@lyonix.shorts",
        avatarUrl: avatarDataUri("LS"),
        authType: "oauth2",
        connected: true,
        lastSyncAt: now,
        coverageLabel: "19 ngày",
        projectId: PROJECT_ID,
        teamId: TEAM_ID,
      },
      {
        id: CHANNEL_B,
        name: "LyOnix Labs",
        handle: "@lyonix.labs",
        avatarUrl: avatarDataUri("LL"),
        authType: "token",
        connected: false,
        lastSyncAt: null,
        coverageLabel: "—",
        projectId: PROJECT_ID,
        teamId: TEAM_LABS,
      },
    ],
    jobs: [
      job("j-1001", "JOB-1001", "3 mẹo giữ nhịp video 45 giây", CHANNEL_A, "producing", "produce"),
      job("j-1002", "JOB-1002", "Cách đổi account khi hết quota", CHANNEL_A, "blocked_provider", "produce"),
      job("j-1003", "JOB-1003", "Hook mở đầu không clickbait", CHANNEL_A, "awaiting_staff_ack", "review", {
        createdByUserId: STAFF_ID,
      }),
      job("j-1004", "JOB-1004", "Preset 9:16 1080p", CHANNEL_A, "completed", "done", {
        vrewUrl: "https://vrew.example/library/demo",
      }),
      job("j-1005", "JOB-1005", "Kênh Labs — chỉ admin", CHANNEL_B, "needs_attention", "check"),
    ],
    providers: [
      {
        id: CONTENT_FAKE,
        name: "Fake OpenAI",
        provider: "fake_openai",
        role: "content",
        scope: "personal",
        ownerUserId: ADMIN_ID,
        status: "verified",
        model: "fake-script-v1",
        quotaRemaining: 80,
        quotaUnit: "%",
        isFake: true,
        secretMasked: true,
        version: 1,
      },
      {
        id: TTS_FAKE,
        name: "Fake TTS",
        provider: "fake_tts",
        role: "tts",
        scope: "personal",
        ownerUserId: STAFF_ID,
        status: "verified",
        model: "fake-voice",
        quotaRemaining: 12,
        quotaUnit: "%",
        isFake: true,
        secretMasked: true,
        version: 1,
      },
      {
        id: VISUAL_FAKE,
        name: "Fake Visual",
        provider: "fake_visual",
        role: "visual",
        scope: "personal",
        ownerUserId: ADMIN_ID,
        status: "verified",
        model: "fake-still",
        quotaRemaining: 55,
        quotaUnit: "%",
        isFake: true,
        secretMasked: true,
        version: 1,
      },
      {
        id: RENDER_FAKE,
        name: "Fake Vrew",
        provider: "fake_vrew",
        role: "render",
        scope: "personal",
        ownerUserId: ADMIN_ID,
        status: "verified",
        model: "fake-render",
        quotaRemaining: 40,
        quotaUnit: "%",
        isFake: true,
        secretMasked: true,
        version: 1,
      },
      {
        id: RENDER_ORG,
        name: "Org render slot",
        provider: "fake_vrew",
        role: "render",
        scope: "organization",
        ownerUserId: ADMIN_ID,
        status: "verified",
        model: "fake-render",
        quotaRemaining: 90,
        quotaUnit: "%",
        isFake: true,
        secretMasked: true,
        version: 1,
      },
    ],
    assets: [
      {
        id: "asset-1",
        name: "hook-frame.png",
        kind: "image",
        jobId: "j-1001",
        sizeLabel: "420 KB",
        expiresAt: "2026-09-26T10:00:00Z",
        thumbUrl: imageThumbUri("hook-frame"),
        previewUrl: imageThumbUri("hook-frame"),
      },
      {
        id: "asset-2",
        name: "preview-cut.mp4",
        kind: "video",
        jobId: "j-1001",
        sizeLabel: "8.4 MB",
        expiresAt: "2026-09-26T10:00:00Z",
        thumbUrl: imageThumbUri("preview-cut"),
        previewUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
      },
      {
        id: "asset-3",
        name: "voice-over.wav",
        kind: "audio",
        jobId: "j-1003",
        sizeLabel: "1.2 MB",
        expiresAt: "2026-09-26T10:00:00Z",
        thumbUrl: imageThumbUri("audio"),
        previewUrl: "",
      },
    ],
    artifacts: [
      {
        id: "art-1",
        jobId: "j-1004",
        channelId: CHANNEL_A,
        durationLabel: "48s",
        qc: "pass",
        vrewUrl: "https://vrew.example/library/demo",
        renderStatus: "completed",
      },
      {
        id: "art-2",
        jobId: "j-1001",
        channelId: CHANNEL_A,
        durationLabel: "—",
        qc: "pending",
        vrewUrl: null,
        renderStatus: "rendering_vrew",
      },
    ],
    orgUsers: [
      {
        id: ADMIN_ID,
        email: "admin@lyonix.local",
        displayName: "Admin LyOnix",
        role: "admin",
        teamId: TEAM_ID,
        teamIds: [TEAM_ID, TEAM_LABS],
        channelIds: [CHANNEL_A, CHANNEL_B],
        disabled: false,
      },
      {
        id: STAFF_ID,
        email: "staff@lyonix.local",
        displayName: "Nhân viên Studio",
        role: "staff",
        teamId: TEAM_ID,
        teamIds: [TEAM_ID],
        channelIds: [CHANNEL_A],
        disabled: false,
      },
    ],
    teams: [
      {
        id: TEAM_ID,
        name: "Studio",
        projectNames: ["MVP Demo"],
        channelIds: [CHANNEL_A],
        memberIds: [ADMIN_ID, STAFF_ID],
      },
      {
        id: TEAM_LABS,
        name: "Labs",
        projectNames: ["Research"],
        channelIds: [CHANNEL_B],
        memberIds: [ADMIN_ID],
      },
    ],
    metricsByChannel: {
      [CHANNEL_A]: kpiAvailable(),
      [CHANNEL_B]: kpiAvailable(),
    },
    periodStats: {
      [CHANNEL_A]: periodsFor(1),
      [CHANNEL_B]: periodsFor(0.4),
    },
    orgTimezone: "Asia/Ho_Chi_Minh",
  };
}

export const IDS = {
  ADMIN_ID,
  STAFF_ID,
  TEAM_ID,
  TEAM_LABS,
  PROJECT_ID,
  CHANNEL_A,
  CHANNEL_B,
  CONTENT_FAKE,
  TTS_FAKE,
  VISUAL_FAKE,
  RENDER_FAKE,
  RENDER_ORG,
};
