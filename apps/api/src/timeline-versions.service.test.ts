import { beforeEach, describe, expect, it } from "vitest";
import { TimelineVersionsService } from "./timeline-versions.service.js";

const projectId = "project-1";

describe("TimelineVersionsService", () => {
  let prisma: any;
  let grants: any;
  let service: TimelineVersionsService;
  let projectRows: any[];
  let timelineRows: any[];
  let mediaRows: any[];
  let templateRows: any[];
  let nextId: number;

  beforeEach(() => {
    nextId = 1;
    projectRows = [{ id: projectId }];
    timelineRows = [];
    mediaRows = [{ id: "media-1", projectId, kind: "video", deletedAt: null }];
    templateRows = [{ id: "template-1", modifications: [{ key: "Video-1.source", kind: "video", label: "Video-1.source", required: true }, { key: "Text-1.fill_color", kind: "color", label: "Text-1.fill_color", required: false }] }];

    prisma = {
      project: { findUnique: async ({ where }: any) => projectRows.find((r) => r.id === where.id) ?? null },
      mediaAssetVersion: {
        findMany: async ({ where }: any) => mediaRows.filter((r) => where.id.in.includes(r.id) && r.projectId === where.projectId && r.deletedAt === null),
      },
      audioVersion: { findMany: async () => [] },
      subtitleVersion: { findMany: async () => [] },
      sceneDraftVersion: { findMany: async () => [] },
      templateSnapshot: { findUnique: async ({ where }: any) => templateRows.find((r) => r.id === where.id) ?? null },
      timelineVersion: {
        findMany: async ({ where, orderBy }: any) => {
          const rows = timelineRows.filter((r) => r.projectId === where.projectId);
          rows.sort((a, b) => (orderBy?.version === "desc" ? b.version - a.version : a.version - b.version));
          return rows;
        },
        findFirst: async ({ where, orderBy }: any) => {
          let rows = timelineRows.filter((r) => r.projectId === where.projectId);
          if (where.status) rows = rows.filter((r) => r.status === where.status);
          rows.sort((a, b) => (orderBy?.version === "desc" ? b.version - a.version : a.version - b.version));
          return rows[0] ?? null;
        },
        findUnique: async ({ where }: any) => timelineRows.find((r) => r.id === where.id) ?? null,
        create: async ({ data }: any) => {
          const row = { id: `timeline-${nextId++}`, createdAt: new Date(), approvedAt: null, approvedByUserId: null, ...data };
          timelineRows.push(row);
          return row;
        },
        updateMany: async ({ where, data }: any) => {
          const row = timelineRows.find((r) => r.id === where.id && r.status === where.status);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      },
    };
    grants = { forUser: async () => ({ projectIds: [projectId] }) };
    service = new TimelineVersionsService(prisma, grants);
  });

  describe("save", () => {
    it("creates the first draft version with supersedesId null", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-1" }] });
      expect(outcome).toMatchObject({ ok: true, data: { version: 1, status: "draft", supersedesId: null } });
    });

    it("rejects a save whose supersedesId does not match the project's actual latest version", async () => {
      await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1" }] });
      const outcome = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1" }] });
      expect(outcome).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    });

    it("chains version/supersedesId when the client supplies the real latest id", async () => {
      const first = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1" }] });
      if (!first.ok) throw new Error("expected ok");
      const second = await service.save(projectId, "user-1", "staff", { supersedesId: first.data.id, scenes: [{ sceneId: "s1" }] });
      expect(second).toMatchObject({ ok: true, data: { version: 2, supersedesId: first.data.id } });
    });

    it("rejects a scene bound to a media asset from another project", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1", mediaAssetVersionId: "not-in-project" }] });
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("rejects duplicate sceneId within one timeline", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1" }, { sceneId: "s1" }] });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("rejects an optionValues key that is not a real modification key on the pinned template", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        templateSnapshotId: "template-1",
        scenes: [{ sceneId: "s1" }],
        optionValues: { "Not-A-Real.key": "x" },
      });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("accepts a whitelisted optionValues key", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        templateSnapshotId: "template-1",
        scenes: [{ sceneId: "s1" }],
        optionValues: { "Text-1.fill_color": "#ffffff" },
      });
      expect(outcome).toMatchObject({ ok: true, data: { optionValues: { "Text-1.fill_color": "#ffffff" } } });
    });

    it("returns NOT_FOUND for a project outside the caller's grants", async () => {
      grants.forUser = async () => ({ projectIds: [] });
      const outcome = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1" }] });
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });

  describe("approve", () => {
    it("approves the current latest draft version", async () => {
      const saved = await service.save(projectId, "user-1", "staff", { supersedesId: null, templateSnapshotId: "template-1", scenes: [{ sceneId: "s1" }] });
      if (!saved.ok) throw new Error("expected ok");
      const approved = await service.approve(saved.data.id, "user-1", "staff");
      expect(approved).toMatchObject({ ok: true, data: { status: "approved" } });
    });

    it("refuses to approve a version without a pinned template", async () => {
      const saved = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1" }] });
      if (!saved.ok) throw new Error("expected ok");
      const approved = await service.approve(saved.data.id, "user-1", "staff");
      expect(approved).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("refuses to approve a version that has since been superseded", async () => {
      const v1 = await service.save(projectId, "user-1", "staff", { supersedesId: null, templateSnapshotId: "template-1", scenes: [{ sceneId: "s1" }] });
      if (!v1.ok) throw new Error("expected ok");
      await service.save(projectId, "user-1", "staff", { supersedesId: v1.data.id, templateSnapshotId: "template-1", scenes: [{ sceneId: "s1" }] });
      const approved = await service.approve(v1.data.id, "user-1", "staff");
      expect(approved).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    });

    it("refuses to re-approve an already approved version", async () => {
      const saved = await service.save(projectId, "user-1", "staff", { supersedesId: null, templateSnapshotId: "template-1", scenes: [{ sceneId: "s1" }] });
      if (!saved.ok) throw new Error("expected ok");
      await service.approve(saved.data.id, "user-1", "staff");
      const outcome = await service.approve(saved.data.id, "user-1", "staff");
      expect(outcome).toMatchObject({ ok: false, code: "INVALID_STATE" });
    });
  });

  describe("preview", () => {
    it("reports ready:false and the missing required key when the template's required slot is unfilled", async () => {
      const saved = await service.save(projectId, "user-1", "staff", { supersedesId: null, templateSnapshotId: "template-1", scenes: [{ sceneId: "s1" }] });
      if (!saved.ok) throw new Error("expected ok");
      const preview = await service.preview(saved.data.id, "user-1", "staff");
      expect(preview).toMatchObject({ ok: true, data: { ready: false, missingRequiredModificationKeys: ["Video-1.source"] } });
    });

    it("reports ready:true once the scene's bound media fills the required slot", async () => {
      const saved = await service.save(projectId, "user-1", "staff", { supersedesId: null, templateSnapshotId: "template-1", scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-1" }] });
      if (!saved.ok) throw new Error("expected ok");
      const preview = await service.preview(saved.data.id, "user-1", "staff");
      expect(preview).toMatchObject({ ok: true, data: { ready: true } });
    });

    it("reports ready:false without a pinned template", async () => {
      const saved = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1" }] });
      if (!saved.ok) throw new Error("expected ok");
      const preview = await service.preview(saved.data.id, "user-1", "staff");
      expect(preview).toMatchObject({ ok: true, data: { ready: false } });
    });
  });
});
