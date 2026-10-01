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

  it("documents the additive VE2E-58 timeline edit schemas", () => {
    const added = openApiDocument.components.schemas.TimelineAddedScene;
    expect(added.required).toEqual(["sceneId", "narration", "screenText", "durationHintMs", "origin"]);
    expect(added.properties.origin.enum).toEqual(["added", "split"]);
    expect(Object.keys(openApiDocument.components.schemas.TimelineEditExtensions.properties)).toEqual(["addedScenes", "removedSceneIds"]);
  });
});
