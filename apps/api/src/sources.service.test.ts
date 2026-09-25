import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourcesService } from "./sources.service.js";
import * as sourceExtract from "./source-extract.js";

const projectId = "project-1";
const sourceRow = (overrides: Record<string, unknown> = {}) => ({
  id: "source-1",
  projectId,
  type: "article_url",
  version: 1,
  originRef: "https://example.com/a",
  rawText: null,
  extractedText: null,
  checksumSha256: null,
  fetchStatus: "pending",
  fetchError: null,
  createdByUserId: "user-1",
  createdAt: new Date(),
  approvedAt: null,
  ...overrides,
});

describe("SourcesService.extractArticle", () => {
  let store: any;
  let prisma: any;
  let grants: any;
  let service: SourcesService;

  beforeEach(() => {
    store = sourceRow();
    prisma = {
      project: { findUnique: async ({ where }: any) => (where.id === projectId ? { id: projectId } : null) },
      sourceVersion: {
        findUnique: async () => store,
        update: async ({ data }: any) => { Object.assign(store, data); return store; },
      },
    };
    grants = { forUser: async () => ({ projectIds: [projectId] }) };
    service = new SourcesService(prisma, grants);
    vi.restoreAllMocks();
  });

  it("persists extractedText and marks the source extracted on success", async () => {
    vi.spyOn(sourceExtract, "extractArticleText").mockResolvedValue({ ok: true, extractedText: "Article body text", finalUrl: store.originRef });
    const result = await service.extractArticle("source-1", "user-1", "staff");
    expect(result).toMatchObject({ fetchStatus: "extracted" });
    expect(store.extractedText).toBe("Article body text");
    expect(store.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent when the source is already extracted", async () => {
    store = sourceRow({ fetchStatus: "extracted", extractedText: "already there" });
    const spy = vi.spyOn(sourceExtract, "extractArticleText");
    const result = await service.extractArticle("source-1", "user-1", "staff");
    expect(spy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fetchStatus: "extracted" });
  });

  it("marks the source blocked when SSRF guard rejects the URL", async () => {
    vi.spyOn(sourceExtract, "extractArticleText").mockResolvedValue({ ok: false, reason: "ssrf_blocked" });
    const result = await service.extractArticle("source-1", "user-1", "staff");
    expect(result).toMatchObject({ extractFailed: "ssrf_blocked" });
    expect(store.fetchStatus).toBe("blocked");
  });

  it("rejects a non article_url source type", async () => {
    store = sourceRow({ type: "topic" });
    expect(await service.extractArticle("source-1", "user-1", "staff")).toBe("invalid_type");
  });

  it("hides an inaccessible project's source as not-found (forbidden)", async () => {
    grants = { forUser: async () => ({ projectIds: [] }) };
    service = new SourcesService(prisma, grants);
    expect(await service.extractArticle("source-1", "user-1", "staff")).toBe("forbidden");
  });
});
