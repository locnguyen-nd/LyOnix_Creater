import { beforeEach, describe, expect, it } from "vitest";
import { DYNAMIC_STYLE_OPTION_KEYS } from "@lyonix/providers";
import { TimelineVersionsService, toTimelineVersionResponse } from "./timeline-versions.service.js";

const projectId = "project-1";

describe("TimelineVersionsService", () => {
  let prisma: any;
  let grants: any;
  let service: TimelineVersionsService;
  let projectRows: any[];
  let timelineRows: any[];
  let mediaRows: any[];
  let templateRows: any[];
  let sceneDraftRows: any[];
  let scriptDraftRows: any[];
  let nextId: number;

  beforeEach(() => {
    nextId = 1;
    projectRows = [{ id: projectId }];
    timelineRows = [];
    scriptDraftRows = [{ id: "script-1", projectId, status: "approved" }];
    sceneDraftRows = ["s1", "s2", "s3"].map((sceneId, orderIndex) => ({ id: `sdv-${sceneId}`, scriptDraftVersionId: "script-1", sceneId, orderIndex, narration: `N ${sceneId}`, screenText: "", visualQuery: "", durationHintMs: 5000 }));
    mediaRows = [
      { id: "media-1", projectId, kind: "video", durationMs: 30_000, deletedAt: null },
      { id: "media-2", projectId, kind: "image", durationMs: null, deletedAt: null },
      { id: "media-3", projectId, kind: "video", durationMs: null, deletedAt: null },
    ];
    templateRows = [{ id: "template-1", modifications: [{ key: "Video-1.source", kind: "video", label: "Video-1.source", required: true }, { key: "Text-1.fill_color", kind: "color", label: "Text-1.fill_color", required: false }] }];

    prisma = {
      project: { findUnique: async ({ where }: any) => projectRows.find((r) => r.id === where.id) ?? null },
      mediaAssetVersion: {
        findMany: async ({ where }: any) => mediaRows.filter((r) => where.id.in.includes(r.id) && r.projectId === where.projectId && r.deletedAt === null),
      },
      audioVersion: { findMany: async () => [] },
      subtitleVersion: { findMany: async () => [] },
      sceneDraftVersion: {
        findMany: async () => [],
        findFirst: async ({ where }: any) => sceneDraftRows.find((r) => r.scriptDraftVersionId === where.scriptDraftVersionId && r.sceneId === where.sceneId) ?? null,
        create: async ({ data }: any) => { const row = { id: `sdv-${sceneDraftRows.length + 1}`, ...data }; sceneDraftRows.push(row); return row; },
        update: async ({ where, data }: any) => Object.assign(sceneDraftRows.find((r) => r.id === where.id), data),
      },
      scriptDraftVersion: {
        findFirst: async ({ where }: any) => {
          const draft = scriptDraftRows.find((d) => d.status === where.status && d.projectId === where.sourceVersion.projectId);
          return draft ? { id: draft.id, scenes: sceneDraftRows.filter((r) => r.scriptDraftVersionId === draft.id) } : null;
        },
      },
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

    it("VE2E-26: accepts a valid dynamicStyle.* Studio override key even though it is not a real template modification key", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        templateSnapshotId: "template-1",
        scenes: [{ sceneId: "s1" }],
        optionValues: { [DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily]: "Noto Sans" },
      });
      expect(outcome).toMatchObject({ ok: true, data: { optionValues: { [DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily]: "Noto Sans" } } });
    });

    it("VE2E-26: rejects a dynamicStyle.* value that fails its own field validation (not just any string)", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        templateSnapshotId: "template-1",
        scenes: [{ sceneId: "s1" }],
        optionValues: { [DYNAMIC_STYLE_OPTION_KEYS.captionFillColor]: "not-a-hex-color" },
      });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("VE2E-93 (17): saves the whole-video caption style keys and a scene override, and reloads them unchanged", async () => {
      const optionValues = { "dynamicStyle.captionFontId": "noto-sans-jp", "dynamicStyle.captionFontSizePx": "80", "dynamicStyle.captionPosition": "middle", "dynamicStyle.captionMaxLines": "1" };
      const saved = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        templateSnapshotId: "template-1",
        scenes: [{ sceneId: "s1", captionStyleOverride: { fillColor: "#FF0000", strokeEnabled: false } }, { sceneId: "s2" }],
        optionValues,
      });
      expect(saved).toMatchObject({ ok: true, data: { optionValues } });
      if (!saved.ok) return;
      // only a scene that has an override stores one (other scenes keep their exact JSON)
      expect(timelineRows[0].scenes[0].captionStyleOverride).toEqual({ fillColor: "#FF0000", strokeEnabled: false });
      expect(timelineRows[0].scenes[1]).not.toHaveProperty("captionStyleOverride");
      const reloaded = await service.get(saved.data.id, "user-1", "staff");
      expect(reloaded).toMatchObject({ ok: true, data: { optionValues, scenes: [{ sceneId: "s1", captionStyleOverride: { fillColor: "#FF0000", strokeEnabled: false } }, { sceneId: "s2", captionStyleOverride: null }] } });
    });

    it("VE2E-93: rejects an override with unknown fields or out-of-range values, and new caption keys with invalid values", async () => {
      for (const captionStyleOverride of [{ background: "#000000" }, { maxLines: 3 }, { fontSizePx: 400 }] as unknown[]) {
        const outcome = await service.save(projectId, "user-1", "staff", { supersedesId: null, templateSnapshotId: "template-1", scenes: [{ sceneId: "s1", captionStyleOverride } as never] });
        expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      }
      const badKey = await service.save(projectId, "user-1", "staff", { supersedesId: null, templateSnapshotId: "template-1", scenes: [{ sceneId: "s1" }], optionValues: { "dynamicStyle.captionMaxLines": "3" } });
      expect(badKey).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("VE2E-93 (16): an old timeline (VE2E-26 font/colour, unknown legacy font, no scene override) re-saves without losing anything", async () => {
      const optionValues = { [DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily]: "Inter Bold", [DYNAMIC_STYLE_OPTION_KEYS.captionFillColor]: "#facc15", [DYNAMIC_STYLE_OPTION_KEYS.imageAnimation]: "none" };
      const outcome = await service.save(projectId, "user-1", "staff", { supersedesId: null, templateSnapshotId: "template-1", scenes: [{ sceneId: "s1" }], optionValues });
      expect(outcome).toMatchObject({ ok: true, data: { optionValues, scenes: [{ sceneId: "s1", captionStyleOverride: null }] } });
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

  describe("VE2E-42 segments + source ranges", () => {
    it("reads a legacy row (no segments/ranges/workflowRunId) back with null/[] defaults", () => {
      const legacy = toTimelineVersionResponse({
        id: "t-legacy", projectId, version: 1, status: "approved", templateSnapshotId: "template-1",
        scenes: [{ sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "media-1", audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null }],
        optionValues: {}, supersedesId: null, createdAt: new Date(), approvedAt: new Date(),
      });
      expect(legacy.segments).toEqual([]);
      expect(legacy.workflowRunId).toBeNull();
      expect(legacy.scenes[0]).toMatchObject({ excluded: false, segmentId: null, sourceStartMs: null, sourceDurationMs: null });
    });

    it("VE2E-93 (20): reads a stored scene override defensively - invalid fields are dropped, nothing throws", () => {
      const row = toTimelineVersionResponse({
        id: "t-bad", projectId, version: 1, status: "draft", templateSnapshotId: "template-1",
        scenes: [
          { sceneId: "s1", orderIndex: 0, captionStyleOverride: { fillColor: "#ABC", maxLines: 7, evil: "<script>" } },
          { sceneId: "s2", orderIndex: 1, captionStyleOverride: "garbage" },
        ],
        optionValues: {}, supersedesId: null, createdAt: new Date(), approvedAt: null,
      });
      expect(row.scenes.map((scene) => scene.captionStyleOverride)).toEqual([{ fillColor: "#AABBCC" }, null]);
    });

    it("saves a timeline without segments exactly as before (segments [] and null ranges)", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-1" }] });
      expect(outcome).toMatchObject({ ok: true, data: { segments: [], workflowRunId: null, scenes: [{ sceneId: "s1", segmentId: null, sourceStartMs: null, sourceDurationMs: null }] } });
      expect(timelineRows[0].segments).toEqual([]);
    });

    it("persists consecutive segments and per-scene video ranges", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        scenes: [
          { sceneId: "s1", mediaAssetVersionId: "media-1", segmentId: "g1", sourceStartMs: 0, sourceDurationMs: 4000 },
          { sceneId: "s2", mediaAssetVersionId: "media-1", segmentId: "g1", sourceStartMs: 4000, sourceDurationMs: 5000 },
          { sceneId: "s3", mediaAssetVersionId: "media-3", sourceStartMs: 1000, sourceDurationMs: 600_000 },
        ],
        segments: [{ segmentId: "g1", sceneIds: ["s1", "s2"], mediaAssetVersionId: "media-1", subject: "  Tokyo street  ", priority: 1 }],
      });
      expect(outcome).toMatchObject({
        ok: true,
        data: {
          segments: [{ segmentId: "g1", sceneIds: ["s1", "s2"], mediaAssetVersionId: "media-1", subject: "Tokyo street", priority: 1 }],
          scenes: [
            { sceneId: "s1", segmentId: "g1", sourceStartMs: 0, sourceDurationMs: 4000 },
            { sceneId: "s2", segmentId: "g1", sourceStartMs: 4000, sourceDurationMs: 5000 },
            // unknown source duration (older import) -> range accepted, not bounded
            { sceneId: "s3", segmentId: null, sourceStartMs: 1000, sourceDurationMs: 600_000 },
          ],
        },
      });
    });

    it("rejects a range on an image, past the known source duration, or half-set", async () => {
      const onImage = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-2", sourceStartMs: 0, sourceDurationMs: 1000 }] });
      expect(onImage).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      const tooLong = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-1", sourceStartMs: 29_000, sourceDurationMs: 2000 }] });
      expect(tooLong).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      const halfSet = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-1", sourceStartMs: 0 }] });
      expect(halfSet).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(timelineRows).toHaveLength(0);
    });

    it("rejects non-consecutive segments, a non-array segments value, and a segment media from another project", async () => {
      const nonConsecutive = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        scenes: [{ sceneId: "s1", segmentId: "g1" }, { sceneId: "s2" }, { sceneId: "s3", segmentId: "g1" }],
        segments: [{ segmentId: "g1", sceneIds: ["s1", "s3"] }],
      });
      expect(nonConsecutive).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      const notArray = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1" }], segments: "g1" as never });
      expect(notArray).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      const foreignMedia = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        scenes: [{ sceneId: "s1", segmentId: "g1" }],
        segments: [{ segmentId: "g1", sceneIds: ["s1"], mediaAssetVersionId: "media-elsewhere" }],
      });
      expect(foreignMedia).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });

  describe("VE2E-44 default video ranges at approve", () => {
    beforeEach(() => {
      mediaRows.push({ id: "media-short", projectId, kind: "video", durationMs: 4200, deletedAt: null });
      prisma.audioVersion.findMany = async ({ where }: any) => (where.id?.in ?? []).map((id: string) => ({ id, mediaAssetVersionId: "audio-media", durationMs: 4000, sceneDraftVersion: { scriptDraftVersion: { sourceVersion: { projectId } } } }));
    });
    const stored = () => timelineRows[0].scenes as any[];

    it("persists [0, voice duration] for a video scene without a range; leaves image, short asset and existing ranges alone", async () => {
      const saved = await service.save(projectId, "user-1", "staff", {
        supersedesId: null, templateSnapshotId: "template-1",
        scenes: [
          { sceneId: "long", mediaAssetVersionId: "media-1", audioVersionId: "a1" },
          { sceneId: "img", mediaAssetVersionId: "media-2", audioVersionId: "a1" },
          { sceneId: "short", mediaAssetVersionId: "media-short", audioVersionId: "a1" },
          { sceneId: "ranged", mediaAssetVersionId: "media-1", audioVersionId: "a1", sourceStartMs: 7000, sourceDurationMs: 2000 },
        ],
      });
      if (!saved.ok) throw new Error(JSON.stringify(saved));
      const approved = await service.approve(saved.data.id, "user-1", "staff");
      expect(approved.ok).toBe(true);
      const byId = Object.fromEntries(stored().map((s) => [s.sceneId, s]));
      expect(byId.long).toMatchObject({ sourceStartMs: 0, sourceDurationMs: 4000 });
      expect(byId.img.sourceStartMs ?? null).toBeNull();
      expect(byId.short.sourceStartMs ?? null).toBeNull();
      expect(byId.ranged).toMatchObject({ sourceStartMs: 7000, sourceDurationMs: 2000 });
    });

    it("also persists on the Auto approved-write path", async () => {
      const outcome = await service.persistApprovedForWorkflowRun("run-1", projectId, "user-1", "staff", {
        templateSnapshotId: "template-1", optionValues: {}, scenes: [{ sceneId: "long", mediaAssetVersionId: "media-1", audioVersionId: "a1" }],
      });
      expect(outcome).toMatchObject({ ok: true, data: { scenes: [{ sceneId: "long", sourceStartMs: 0, sourceDurationMs: 4000 }] } });
    });
  });

  describe("persistApprovedForWorkflowRun (VE2E-42 Auto path)", () => {
    const input = { templateSnapshotId: "template-1", scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-1", screenTextOverride: "Narration 1" }], optionValues: {} };

    it("writes an already-approved version tagged with the run, superseding the latest", async () => {
      const studio = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: [{ sceneId: "s1" }] });
      if (!studio.ok) throw new Error("expected ok");
      const outcome = await service.persistApprovedForWorkflowRun("run-1", projectId, "user-1", "staff", input);
      expect(outcome).toMatchObject({ ok: true, data: { version: 2, status: "approved", workflowRunId: "run-1", supersedesId: studio.data.id, templateSnapshotId: "template-1" } });
      expect(timelineRows[1]).toMatchObject({ approvedByUserId: "user-1", createdByUserId: "user-1", workflowRunId: "run-1" });
      expect(timelineRows[1].approvedAt).toBeInstanceOf(Date);
      const latest = await service.latest(projectId, "user-1", "staff");
      expect(latest).toMatchObject({ ok: true, data: { id: timelineRows[1].id, scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-1", screenTextOverride: "Narration 1" }] } });
    });

    it("is idempotent on retry of the same run with identical content, but versions a changed binding", async () => {
      const first = await service.persistApprovedForWorkflowRun("run-1", projectId, "user-1", "staff", input);
      const again = await service.persistApprovedForWorkflowRun("run-1", projectId, "user-1", "staff", input);
      if (!first.ok || !again.ok) throw new Error("expected ok");
      expect(again.data.id).toBe(first.data.id);
      expect(timelineRows).toHaveLength(1);
      const changed = await service.persistApprovedForWorkflowRun("run-1", projectId, "user-1", "staff", { ...input, scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-3" }] });
      expect(changed).toMatchObject({ ok: true, data: { version: 2, supersedesId: first.data.id } });
      const otherRun = await service.persistApprovedForWorkflowRun("run-2", projectId, "user-1", "staff", { ...input, scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-3" }] });
      expect(otherRun).toMatchObject({ ok: true, data: { version: 3, workflowRunId: "run-2" } });
    });

    it("validates through the same rules as a Studio save (unknown media rejected, nothing written)", async () => {
      const outcome = await service.persistApprovedForWorkflowRun("run-1", projectId, "user-1", "staff", { ...input, scenes: [{ sceneId: "s1", mediaAssetVersionId: "media-elsewhere" }] });
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(timelineRows).toHaveLength(0);
    });

    it("maps a concurrent version-number collision to VERSION_CONFLICT", async () => {
      prisma.timelineVersion.create = async () => {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      };
      const outcome = await service.persistApprovedForWorkflowRun("run-1", projectId, "user-1", "staff", input);
      expect(outcome).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    });
  });

  describe("VE2E-58 timeline edit model (added / split / removed scenes)", () => {
    const added = (sceneId: string, extra: Record<string, unknown> = {}) => ({ sceneId, narration: "Xin chào. Tạm biệt.", screenText: "Hi", durationHintMs: 4000, origin: "added" as const, ...extra });
    const scenes = (...ids: string[]) => ids.map((sceneId) => ({ sceneId }));

    it("persists added scenes + removed script scenes, mirrors added scenes as SceneDraftVersion rows, and reads them back", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        scenes: scenes("s1", "usr-1", "s3"),
        addedScenes: [added("usr-1")],
        removedSceneIds: ["s2"],
      });
      expect(outcome).toMatchObject({ ok: true, data: { addedScenes: [{ sceneId: "usr-1", origin: "added", splitFromSceneId: null, narration: "Xin chào. Tạm biệt." }], removedSceneIds: ["s2"] } });
      expect(sceneDraftRows.find((r) => r.sceneId === "usr-1")).toMatchObject({ scriptDraftVersionId: "script-1", narration: "Xin chào. Tạm biệt.", screenText: "Hi", orderIndex: 3 });
      expect(sceneDraftRows.filter((r) => !r.sceneId.startsWith("usr-")).map((r) => r.narration)).toEqual(["N s1", "N s2", "N s3"]);
      const latest = await service.latest(projectId, "user-1", "staff");
      expect(latest).toMatchObject({ ok: true, data: { removedSceneIds: ["s2"], addedScenes: [{ sceneId: "usr-1" }] } });
    });

    it("re-saving updates the mirrored row text instead of creating a duplicate", async () => {
      const first = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: scenes("s1", "usr-1"), addedScenes: [added("usr-1")] });
      if (!first.ok) throw new Error("expected ok");
      await service.save(projectId, "user-1", "staff", { supersedesId: first.data.id, scenes: scenes("s1", "usr-1"), addedScenes: [added("usr-1", { narration: "Câu mới." })] });
      expect(sceneDraftRows.filter((r) => r.sceneId === "usr-1")).toHaveLength(1);
      expect(sceneDraftRows.find((r) => r.sceneId === "usr-1")!.narration).toBe("Câu mới.");
    });

    it("a split pair keeps splitFromSceneId and the original script scene is recoverable", async () => {
      const outcome = await service.save(projectId, "user-1", "staff", {
        supersedesId: null,
        scenes: scenes("s1", "usr-1", "usr-2", "s3"),
        addedScenes: [added("usr-1", { origin: "split", splitFromSceneId: "s2" }), added("usr-2", { origin: "split", splitFromSceneId: "s2" })],
        removedSceneIds: ["s2"],
      });
      expect(outcome).toMatchObject({ ok: true, data: { addedScenes: [{ splitFromSceneId: "s2" }, { splitFromSceneId: "s2" }], removedSceneIds: ["s2"] } });
    });

    it("rejects invalid edits with VALIDATION_FAILED and writes nothing", async () => {
      const save = (extra: Record<string, unknown>) => service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: scenes("s1", "usr-1"), ...extra } as any);
      const bad: Record<string, unknown>[] = [
        { addedScenes: [added("usr-1", { narration: "   " })] },
        { addedScenes: [added("usr-1"), added("usr-1")] },
        { addedScenes: [added("s1")] },
        { addedScenes: [added("usr-1")], removedSceneIds: ["unknown"] },
        { addedScenes: [added("usr-1")], removedSceneIds: ["s1"] },
        { addedScenes: [added("usr-1", { durationHintMs: 1 })] },
        { addedScenes: [added("usr-1", { origin: "split", splitFromSceneId: "ghost" })] },
        { addedScenes: "nope" },
        { addedScenes: [added("usr-1")], removedSceneIds: "nope" },
      ];
      for (const extra of bad) expect(await save(extra), JSON.stringify(extra)).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      // a timeline id that is neither a script scene nor an added scene
      expect(await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: scenes("s1", "ghost"), removedSceneIds: ["s2"] })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      // an added scene definition that is not on the timeline
      expect(await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: scenes("s1"), addedScenes: [added("usr-1")] })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(timelineRows).toHaveLength(0);
      expect(sceneDraftRows.some((r) => r.sceneId.startsWith("usr-"))).toBe(false);
    });

    it("refuses edits when the project has no approved script", async () => {
      scriptDraftRows = [];
      expect(await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: scenes("s1", "usr-1"), addedScenes: [added("usr-1")] })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("a legacy save (no edits) is unchanged: arbitrary ids still accepted, empty arrays returned, no script lookup", async () => {
      prisma.scriptDraftVersion.findFirst = async () => { throw new Error("must not look up the script"); };
      const outcome = await service.save(projectId, "user-1", "staff", { supersedesId: null, scenes: scenes("anything") });
      expect(outcome).toMatchObject({ ok: true, data: { addedScenes: [], removedSceneIds: [] } });
    });

    it("approve keeps the edit model", async () => {
      const saved = await service.save(projectId, "user-1", "staff", { supersedesId: null, templateSnapshotId: "template-1", scenes: scenes("s1", "usr-1"), addedScenes: [added("usr-1")], removedSceneIds: ["s2", "s3"] });
      if (!saved.ok) throw new Error("expected ok");
      const approved = await service.approve(saved.data.id, "user-1", "staff");
      expect(approved).toMatchObject({ ok: true, data: { status: "approved", addedScenes: [{ sceneId: "usr-1" }], removedSceneIds: ["s2", "s3"] } });
    });

    it("the Auto runner path validates + persists edits through the same rules", async () => {
      const input = { templateSnapshotId: "template-1", scenes: scenes("s1", "usr-1"), addedScenes: [added("usr-1")], removedSceneIds: ["s2", "s3"] };
      const outcome = await service.persistApprovedForWorkflowRun("run-1", projectId, "user-1", "staff", input);
      expect(outcome).toMatchObject({ ok: true, data: { addedScenes: [{ sceneId: "usr-1" }], removedSceneIds: ["s2", "s3"] } });
      const again = await service.persistApprovedForWorkflowRun("run-1", projectId, "user-1", "staff", input);
      expect(timelineRows).toHaveLength(1);
      expect(again.ok && outcome.ok && again.data.id === outcome.data.id).toBe(true);
    });
  });
});
