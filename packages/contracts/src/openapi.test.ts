import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi.js";

describe("OpenAPI baseline", () => {
  it("publishes the API version, health response and envelope schemas", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(openApiDocument.servers).toEqual([{ url: "/api/v1" }]);
    expect(openApiDocument.paths["/health"].get.responses["200"].content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/SuccessHealth" });
    expect(openApiDocument.components.schemas.SuccessHealth.required).toEqual(["data", "meta"]);
    expect(openApiDocument.components.schemas.ErrorEnvelope.required).toEqual(["error", "meta"]);
  });

  it("documents the Studio media-plan endpoint, request and response", () => {
    const operation = openApiDocument.paths["/projects/{projectId}/media-plans"].post;
    expect(operation.operationId).toBe("createProjectMediaPlan");
    expect(operation.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/MediaPlanRequest" });
    expect(openApiDocument.components.schemas.MediaPlanRequest.required).toEqual(["scriptDraftVersionId", "providerAccountId"]);
    expect(openApiDocument.components.schemas.SuccessMediaPlan.required).toEqual(["data", "meta"]);
  });

  it("VE2E-62: documents queue summary, cancel-queued and queue state fields", () => {
    expect(openApiDocument.paths["/queue-summary"].get.operationId).toBe("getQueueSummary");
    expect(openApiDocument.components.schemas.QueueSummary.required).toEqual(["kind", "active", "limit", "queued"]);
    expect(openApiDocument.components.schemas.QueueSummary.properties.kind.enum).toEqual(["workflow", "render", "media"]);
    expect(openApiDocument.paths["/video-productions/{id}/cancel"].post.operationId).toBe("cancelQueuedVideoProduction");
    expect(openApiDocument.paths["/video-productions/{id}/cancel"].post.responses["409"]).toBeDefined();
    expect(openApiDocument.components.schemas.QueueState.required).toEqual(["queuePosition", "queuedAt", "startedAt"]);
    expect(openApiDocument.components.schemas.SuccessVideoProduction.properties.data.required).toContain("queue");
    expect(Object.keys(openApiDocument.components.schemas.SuccessRenderJob.properties.data.properties)).toEqual(expect.arrayContaining(["queuePosition", "queuedAt", "startedAt", "queueKind"]));
  });
});
