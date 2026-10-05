/**
 * VE2E-37 test-only helpers (imported only by *.test.ts): an in-memory media-worker stand-in on
 * `InMemoryMediaJobBroker` that answers `clip.prepare` jobs like apps/media-worker would, and a
 * tiny MediaAssetVersion store for Prisma mocks. No RabbitMQ, no FFmpeg, no provider call.
 */
import { CLIP_PREPARE_PROFILE_VERSION, CLIP_PREPARE_RESULT_TYPE, MEDIA_JOB_SCHEMA_VERSION, MediaJobClient, type ClipPrepareJob, type ClipPrepareResult } from "@lyonix/media-jobs";
import { InMemoryMediaJobBroker } from "@lyonix/media-jobs/testing";

export type StubWorkerBehavior = (job: ClipPrepareJob) => ClipPrepareResult | "silent";

export const okClipResult = (job: ClipPrepareJob, overrides: { bytes?: number; mode?: "copy" | "reencode"; hasAudio?: boolean } = {}): ClipPrepareResult => {
  const image = job.source.kind === "image";
  return {
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: CLIP_PREPARE_RESULT_TYPE,
  ok: true,
  jobKey: job.jobKey,
  reused: false,
  mode: image || job.cropPlan ? "reencode" : overrides.mode ?? "copy",
  reencodeReasons: job.cropPlan ? ["crop_plan"] : [],
  cut: { startMs: job.startMs, durationMs: job.durationMs },
  drift: { startMs: 0, durationMs: 0 },
  toleranceMs: 1000,
  source: { relativePath: job.source.relativePath, mediaAssetVersionId: job.source.mediaAssetVersionId ?? null, durationMs: 30_000, width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac" },
  output: {
    relativePath: `working/media-jobs/${job.jobKey.replace(/[^a-z0-9]/gi, "")}/${image ? "clip.jpg" : "clip.mp4"}`,
    mimeType: image ? "image/jpeg" : "video/mp4",
    sha256: "a".repeat(64),
    bytes: overrides.bytes ?? 2_000_000,
    durationMs: image ? 0 : job.durationMs,
    width: 1080,
    height: 1920,
    videoCodec: "h264",
    hasAudio: overrides.hasAudio ?? !job.stripAudio,
    retentionClass: "working",
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  },
  ...(job.cropPlan
    ? { reframe: { applied: "crop" as const, planVersion: job.cropPlan.version, mode: job.cropPlan.mode, zoomPermille: job.cropPlan.zoomPermille, cropPlanSha256: "b".repeat(64), primarySubjectId: job.cropPlan.primarySubjectId, overlayUnavoidable: job.cropPlan.overlayUnavoidable, residualOverlayPct: job.cropPlan.residualOverlayPct, subjectCoveragePct: job.cropPlan.subjectCoveragePct, cropProfileVersion: "crop-apply.v1" as const } }
    : {}),
  tool: { profileVersion: CLIP_PREPARE_PROFILE_VERSION, ffmpegVersion: "ffmpeg version test" },
  completedAt: new Date().toISOString(),
  };
};

export const failedClipResult = (job: ClipPrepareJob, code: "FFMPEG_FAILED" | "RANGE_OUT_OF_BOUNDS", retryable: boolean): ClipPrepareResult => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: CLIP_PREPARE_RESULT_TYPE,
  ok: false,
  jobKey: job.jobKey,
  error: { code, message: `${code} (stub)`, retryable, attempts: retryable ? 2 : 1 },
  completedAt: new Date().toISOString(),
});

/** Starts a stub media-worker consumer and returns a real `MediaJobClient` wired to it through the in-memory broker. */
export async function startStubMediaWorker(behavior: StubWorkerBehavior = (job) => okClipResult(job)) {
  const broker = new InMemoryMediaJobBroker();
  const jobs: ClipPrepareJob[] = [];
  const worker = broker.createChannel();
  await worker.assertQueue("lyonix.media");
  await worker.consume("lyonix.media", (message) => {
    if (!message) return;
    const job = JSON.parse(message.content.toString("utf8")) as ClipPrepareJob;
    jobs.push(job);
    const result = behavior(job);
    if (result !== "silent" && message.properties.replyTo) {
      worker.sendToQueue(message.properties.replyTo, Buffer.from(JSON.stringify(result)), { correlationId: message.properties.correlationId! });
    }
    worker.ack(message);
  });
  const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "lyonix.media", defaultTimeoutMs: 2_000 });
  return { client, jobs, broker };
}

export type StoredAsset = {
  id: string;
  projectId: string;
  kind: "video" | "image" | "audio" | "document";
  origin: string;
  bytes: number;
  durationMs?: number | null;
  relativePath: string;
  originalFileName: string;
  checksumSha256?: string | null;
  mimeType?: string;
  license?: string | null;
  provenance?: unknown;
  deletedAt?: Date | null;
  parentMediaAssetVersionId?: string | null;
  transform?: unknown;
  expiresAt?: Date | null;
  createdAt?: Date;
};

/** Minimal `prisma.mediaAssetVersion` covering the queries render + ClipDerivativesService make. */
export function mediaAssetStore(initial: StoredAsset[]) {
  const rows = new Map<string, StoredAsset>(initial.map((row) => [row.id, { deletedAt: null, createdAt: new Date(0), ...row }]));
  let seq = 0;
  const matches = (row: StoredAsset, where: Record<string, any>) =>
    (where.id === undefined || (typeof where.id === "string" ? row.id === where.id : where.id.in.includes(row.id))) &&
    (where.projectId === undefined || row.projectId === where.projectId) &&
    (where.deletedAt === undefined || (row.deletedAt ?? null) === where.deletedAt) &&
    (where.parentMediaAssetVersionId === undefined || (row.parentMediaAssetVersionId ?? null) === where.parentMediaAssetVersionId);
  return {
    rows,
    findFirst: async ({ where }: any) => [...rows.values()].find((row) => matches(row, where)) ?? null,
    findMany: async ({ where }: any) =>
      [...rows.values()].filter((row) => matches(row, where)).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)),
    create: async ({ data }: any) => {
      const row = { id: `deriv-${++seq}`, deletedAt: null, createdAt: new Date(Date.now() + seq), ...data } as StoredAsset;
      rows.set(row.id, row);
      return row;
    },
  };
}
