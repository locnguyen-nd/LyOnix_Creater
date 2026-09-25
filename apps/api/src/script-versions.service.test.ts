import { beforeEach, describe, expect, it } from "vitest";
import { ScriptVersionsService } from "./script-versions.service.js";
import type { ScriptDraftV2Response } from "@lyonix/contracts";

const projectId = "project-1";
const sourceVersionId = "source-1";

const draft: ScriptDraftV2Response = {
  schemaVersion: "script-draft.v2",
  language: "vi",
  title: "Messi",
  hook: "Ai la GOAT?",
  body: "Full narration",
  cta: "Theo doi de biet them",
  caption: "#messi",
  scenes: [
    { sceneId: "s01", narration: "Xin chao", screenText: "Xin chao", visualQuery: "soccer stadium", durationHintMs: 5000 },
    { sceneId: "s02", narration: "Messi la GOAT", screenText: "GOAT", visualQuery: "messi trophy", durationHintMs: 6000 },
  ],
};

const providerPin = { accountId: "account-1", provider: "openai", modelId: "gpt-5", configVersion: 1, promptTemplateVersion: "script-prompt.v2" };

describe("ScriptVersionsService", () => {
  let prisma: any;
  let grants: any;
  let service: ScriptVersionsService;
  let scriptRows: any[];
  let sceneRows: any[];
  let audioRows: any[];
  let subtitleRows: any[];

  beforeEach(() => {
    scriptRows = [];
    sceneRows = [];
    audioRows = [];
    subtitleRows = [];
    let nextId = 1;

    prisma = {
      sourceVersion: { findUnique: async ({ where }: any) => (where.id === sourceVersionId ? { id: sourceVersionId, projectId } : null) },
      scriptDraftVersion: {
        findFirst: async ({ where, orderBy }: any) => {
          let rows = scriptRows.filter((r) => r.sourceVersionId === where.sourceVersionId);
          if (where.status) rows = rows.filter((r) => r.status === where.status);
          if (where.id?.not) rows = rows.filter((r) => r.id !== where.id.not);
          rows.sort((a, b) => (orderBy?.version === "desc" ? b.version - a.version : a.version - b.version));
          const found = rows[0] ?? null;
          return found ? { ...found, scenes: sceneRows.filter((s) => s.scriptDraftVersionId === found.id) } : null;
        },
        findMany: async ({ where, orderBy }: any) => {
          let rows = scriptRows.filter((r) => r.sourceVersionId === where.sourceVersionId);
          rows.sort((a, b) => (orderBy?.version === "desc" ? b.version - a.version : a.version - b.version));
          return rows.map((r) => ({ ...r, scenes: sceneRows.filter((s) => s.scriptDraftVersionId === r.id) }));
        },
        findUnique: async ({ where }: any) => {
          const row = scriptRows.find((r) => r.id === where.id);
          return row ? { ...row, scenes: sceneRows.filter((s) => s.scriptDraftVersionId === row.id) } : null;
        },
        create: async ({ data }: any) => {
          const id = `script-${nextId++}`;
          const { scenes, ...rest } = data;
          const row = { id, createdAt: new Date(), approvedAt: null, ...rest };
          scriptRows.push(row);
          const createdScenes = (scenes?.create ?? []).map((s: any) => {
            const sceneId = `scene-${nextId++}`;
            const sceneRow = { id: sceneId, scriptDraftVersionId: id, createdAt: new Date(), ...s };
            sceneRows.push(sceneRow);
            return sceneRow;
          });
          return { ...row, scenes: createdScenes };
        },
        update: async ({ where, data }: any) => {
          const row = scriptRows.find((r) => r.id === where.id);
          Object.assign(row, data);
          return { ...row, scenes: sceneRows.filter((s) => s.scriptDraftVersionId === row.id) };
        },
        updateMany: async ({ where, data }: any) => {
          const row = scriptRows.find((r) => r.id === where.id && r.status === where.status);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      },
      audioVersion: {
        findMany: async ({ where }: any) => audioRows.filter((a) => where.sceneDraftVersionId.in.includes(a.sceneDraftVersionId) && a.status === where.status),
        updateMany: async ({ where, data }: any) => {
          let count = 0;
          for (const row of audioRows) {
            if (where.id.in.includes(row.id)) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return { count };
        },
      },
      subtitleVersion: {
        updateMany: async ({ where, data }: any) => {
          let count = 0;
          for (const row of subtitleRows) {
            if (where.audioVersionId.in.includes(row.audioVersionId) && row.status === where.status) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return { count };
        },
      },
      $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(prisma),
    };
    grants = { forUser: async () => ({ projectIds: [projectId] }) };
    service = new ScriptVersionsService(prisma, grants);
  });

  describe("create", () => {
    it("persists a new draft ScriptDraftVersion with scenes in order", async () => {
      const outcome = await service.create(sourceVersionId, "user-1", "staff", { draft, providerPin });
      expect(outcome).toMatchObject({ ok: true, data: { version: 1, status: "draft", title: "Messi" } });
      if (outcome.ok) {
        expect(outcome.data.scenes).toHaveLength(2);
        expect(outcome.data.scenes[0]!.sceneId).toBe("s01");
        expect(outcome.data.supersedesId).toBeNull();
      }
    });

    it("increments version and chains supersedesId on a second create for the same source", async () => {
      const first = await service.create(sourceVersionId, "user-1", "staff", { draft, providerPin });
      const second = await service.create(sourceVersionId, "user-1", "staff", { draft, providerPin });
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.data.version).toBe(2);
        expect(second.data.supersedesId).toBe(first.data.id);
      }
    });

    it("rejects a draft with duplicate sceneId", async () => {
      const bad: ScriptDraftV2Response = { ...draft, scenes: [draft.scenes[0]!, draft.scenes[0]!] };
      const outcome = await service.create(sourceVersionId, "user-1", "staff", { draft: bad, providerPin });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("returns NOT_FOUND for a source outside the caller's project grants", async () => {
      grants.forUser = async () => ({ projectIds: [] });
      const outcome = await service.create(sourceVersionId, "user-1", "staff", { draft, providerPin });
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });

  describe("approve + invalidation cascade", () => {
    it("approves a draft version and sets approvedAt", async () => {
      const created = await service.create(sourceVersionId, "user-1", "staff", { draft, providerPin });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const approved = await service.approve(created.data.id, "user-1", "staff");
      expect(approved).toMatchObject({ ok: true, data: { status: "approved" } });
      if (approved.ok) expect(approved.data.approvedAt).not.toBeNull();
    });

    it("refuses to re-approve an already approved version", async () => {
      const created = await service.create(sourceVersionId, "user-1", "staff", { draft, providerPin });
      if (!created.ok) return;
      await service.approve(created.data.id, "user-1", "staff");
      const outcome = await service.approve(created.data.id, "user-1", "staff");
      expect(outcome).toMatchObject({ ok: false, code: "INVALID_STATE" });
    });

    it("marks current AudioVersion/SubtitleVersion stale when a new script version supersedes an approved one", async () => {
      const v1 = await service.create(sourceVersionId, "user-1", "staff", { draft, providerPin });
      if (!v1.ok) return;
      await service.approve(v1.data.id, "user-1", "staff");
      const sceneId = v1.data.scenes[0]!.id;
      audioRows.push({ id: "audio-1", sceneDraftVersionId: sceneId, status: "current" });
      subtitleRows.push({ id: "subtitle-1", audioVersionId: "audio-1", status: "current" });

      const v2 = await service.create(sourceVersionId, "user-1", "staff", { draft, providerPin });
      if (!v2.ok) return;
      await service.approve(v2.data.id, "user-1", "staff");

      expect(audioRows[0]).toMatchObject({ status: "stale", staleReason: "script_revised" });
      expect(subtitleRows[0]).toMatchObject({ status: "stale", staleReason: "script_revised" });
    });

    it("does not touch audio/subtitle when approving the very first version (nothing to supersede)", async () => {
      const v1 = await service.create(sourceVersionId, "user-1", "staff", { draft, providerPin });
      if (!v1.ok) return;
      const sceneId = v1.data.scenes[0]!.id;
      audioRows.push({ id: "audio-1", sceneDraftVersionId: sceneId, status: "current" });
      await service.approve(v1.data.id, "user-1", "staff");
      expect(audioRows[0]).toMatchObject({ status: "current" });
    });
  });
});
