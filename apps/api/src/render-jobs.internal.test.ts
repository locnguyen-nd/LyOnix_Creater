import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderJobsService } from "./render-jobs.service.js";

/** VE2E-110: how RenderJobsService hands internal-engine work to InternalRenderService (provider paths are covered by render-jobs.service.test.ts). */
const projectId = "project-1";

describe("RenderJobsService - internal engine hooks", () => {
  let prisma: any;
  let internal: { enqueue: ReturnType<typeof vi.fn>; processJob: ReturnType<typeof vi.fn>; recoverStale: ReturnType<typeof vi.fn> };
  let service: RenderJobsService;
  let rows: Map<string, any>;
  let mediaDir: string;
  let previousRoot: string | undefined;

  beforeEach(async () => {
    rows = new Map();
    mediaDir = await mkdtemp(join(tmpdir(), "lyonix-rj-"));
    previousRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = mediaDir;
    prisma = {
      project: { findUnique: async () => ({ id: projectId }) },
      timelineVersion: { findUnique: async () => ({ id: "tl-1", projectId, status: "approved", templateSnapshotId: "snap-1", scenes: [] }) },
      providerAccount: { findFirst: vi.fn(async ({ where }: any) => (where.id === "acct-lyonix" ? { provider: "lyonix" } : where.id === "acct-cm" ? { provider: "creatomate" } : null)) },
      renderJob: {
        findFirst: vi.fn(async ({ where }: any) => [...rows.values()].find((r) => r.status === where.status) ?? null),
        findUnique: vi.fn(async ({ where }: any) => rows.get(where.id) ?? null),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const row = rows.get(where.id);
          if (!row || (where.status && row.status !== where.status)) return { count: 0 };
          rows.set(where.id, { ...row, ...data });
          return { count: 1 };
        }),
      },
      user: { findUnique: async () => ({ role: "staff" }) },
    };
    const grants = { forUser: async () => ({ teamIds: [], projectIds: [projectId], channelIds: [] }) };
    internal = { enqueue: vi.fn(async () => ({ ok: true, data: { id: "job-int" } })), processJob: vi.fn(async () => undefined), recoverStale: vi.fn(async () => false) };
    service = new RenderJobsService(prisma, grants as never, { usableAccount: vi.fn() } as never, {} as never, undefined, internal as never);
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = previousRoot;
    await rm(mediaDir, { recursive: true, force: true });
  });

  it("an enqueue for the system account goes to the internal engine (no provider account lookup, no PUBLIC_BASE_URL needed)", async () => {
    const outcome = await service.enqueueTimelineRender(projectId, "tl-1", "user-1", "staff", { providerAccountId: "acct-lyonix" }, "template", "run-1");
    expect(outcome).toEqual({ ok: true, data: { id: "job-int" } });
    expect(internal.enqueue).toHaveBeenCalledWith({ projectId, timelineVersionId: "tl-1", userId: "user-1", role: "staff", input: { providerAccountId: "acct-lyonix" }, workflowRunId: "run-1" });
  });

  it("only admins may force an engine, and a provider template cannot be forced onto the internal engine", async () => {
    expect(await service.enqueueTimelineRender(projectId, "tl-1", "u", "staff", { providerAccountId: "acct-lyonix", forceEngine: "creatomate" }, "template")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(internal.enqueue).not.toHaveBeenCalled();
    expect(await service.enqueueTimelineRender(projectId, "tl-1", "u", "admin", { providerAccountId: "acct-cm", forceEngine: "lyonix" }, "template")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
  });

  it("without InternalRenderService wired, an internal enqueue fails clearly instead of falling through to a provider", async () => {
    const bare = new RenderJobsService(prisma, { forUser: async () => ({ teamIds: [], projectIds: [projectId], channelIds: [] }) } as never, { usableAccount: vi.fn() } as never, {} as never);
    expect(await bare.enqueueTimelineRender(projectId, "tl-1", "u", "staff", { providerAccountId: "acct-lyonix" }, "template")).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("the preparation tick first recovers stale internal renders, then routes a claimed internal job to InternalRenderService", async () => {
    internal.recoverStale.mockResolvedValueOnce(true);
    expect(await service.processNextPreparation()).toBe(true);
    expect(internal.processJob).not.toHaveBeenCalled();

    rows.set("job-1", { id: "job-1", engine: "lyonix", status: "preparing_clips", preparationLeaseUntil: null, modificationsPayload: { mode: "lyonix", timelineVersionId: "tl-1" }, createdByUserId: "u", projectId });
    expect(await service.processNextPreparation()).toBe(true);
    expect(internal.processJob).toHaveBeenCalledTimes(1);
    expect(internal.processJob.mock.calls[0]![0]).toMatchObject({ id: "job-1", engine: "lyonix" });
    expect(rows.get("job-1")!.preparationLeaseUntil).toBeInstanceOf(Date); // claimed with a lease before handing over
  });

  describe("resolveInternalOutput", () => {
    const done = (over: Record<string, unknown> = {}) => ({ id: "job-1", projectId, engine: "lyonix", status: "completed", outputRelativePath: "working/renders/abc/video.mp4", thumbnailRelativePath: "working/renders/abc/thumb.jpg", ...over });
    const writeFiles = async () => {
      await mkdir(join(mediaDir, "working/renders/abc"), { recursive: true });
      await writeFile(join(mediaDir, "working/renders/abc/video.mp4"), Buffer.alloc(2048));
      await writeFile(join(mediaDir, "working/renders/abc/thumb.jpg"), Buffer.alloc(64));
    };

    it("returns the stored video and cover of a completed internal render", async () => {
      await writeFiles();
      rows.set("job-1", done());
      const video = await service.resolveInternalOutput("job-1", "u", "staff", "video");
      expect(video).toMatchObject({ ok: true, data: { mimeType: "video/mp4", bytes: 2048, fileName: "lyonix-job-1.mp4", absolutePath: join(mediaDir, "working/renders/abc/video.mp4") } });
      expect(await service.resolveInternalOutput("job-1", "u", "staff", "thumbnail")).toMatchObject({ ok: true, data: { mimeType: "image/jpeg", bytes: 64 } });
    });

    it("404s for provider jobs, unfinished jobs, expired/swept files and any path outside working/renders", async () => {
      rows.set("job-1", done({ engine: "creatomate" }));
      expect(await service.resolveInternalOutput("job-1", "u", "staff", "video")).toMatchObject({ ok: false, status: 404 });
      rows.set("job-1", done({ status: "rendering" }));
      expect(await service.resolveInternalOutput("job-1", "u", "staff", "video")).toMatchObject({ ok: false, status: 404 });
      rows.set("job-1", done()); // files were never written / already swept
      const expired = await service.resolveInternalOutput("job-1", "u", "staff", "video");
      expect(expired).toMatchObject({ ok: false, status: 404 });
      if (!expired.ok) expect(expired.message).toContain("hết hạn");
      for (const bad of ["../secret.mp4", "projects/p/original.mp4", "/etc/passwd", "working/renders/../../x.mp4"]) {
        rows.set("job-1", done({ outputRelativePath: bad }));
        expect(await service.resolveInternalOutput("job-1", "u", "staff", "video"), bad).toMatchObject({ ok: false, status: 404 });
      }
      expect(await service.resolveInternalOutput("missing", "u", "staff", "video")).toMatchObject({ ok: false, status: 404 });
    });

    it("requires project access", async () => {
      await writeFiles();
      rows.set("job-1", done());
      const other = new RenderJobsService({ ...prisma, project: { findUnique: async () => ({ id: projectId }) } }, { forUser: async () => ({ teamIds: [], projectIds: ["someone-elses"], channelIds: [] }) } as never, {} as never, {} as never);
      expect(await other.resolveInternalOutput("job-1", "u", "staff", "video")).toMatchObject({ ok: false, status: 404 });
    });
  });
});
