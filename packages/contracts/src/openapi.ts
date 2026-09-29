import type { OpenAPIV3_1 } from "openapi-types";

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "LyOnix Studio API",
    version: "0.1.0",
    description: "Internal REST contract for LyOnix Studio.",
  },
  servers: [{ url: "/api/v1" }],
  paths: {
    "/projects/{projectId}/media-plans": {
      post: {
        operationId: "createProjectMediaPlan",
        summary: "Generate a Studio media plan with the shared Auto planner",
        parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/MediaPlanRequest" } } } },
        responses: {
          "200": { description: "Media plan created", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessMediaPlan" } } } },
          "400": { description: "Invalid request or media planning failed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
        },
      },
    },
    "/health": {
      get: {
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SuccessHealth" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      RequestMeta: {
        type: "object",
        required: ["requestId"],
        properties: { requestId: { type: "string", format: "uuid" } },
      },
      SuccessHealth: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "object",
            required: ["status", "service"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              service: { type: "string", example: "api" },
            },
          },
          meta: { $ref: "#/components/schemas/RequestMeta" },
        },
      },
      ErrorEnvelope: {
        type: "object",
        required: ["error", "meta"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message", "details", "retryable"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              details: { type: "array", items: { type: "object" } },
              retryable: { type: "boolean" },
            },
          },
          meta: { $ref: "#/components/schemas/RequestMeta" },
        },
      },
      MediaPlanRequest: {
        type: "object",
        required: ["scriptDraftVersionId", "providerAccountId"],
        properties: {
          scriptDraftVersionId: { type: "string" },
          providerAccountId: { type: "string", description: "Verified visual (Pexels) provider account." },
          backgroundSegments: {
            oneOf: [
              { type: "object", required: ["mode"], properties: { mode: { const: "auto" } }, additionalProperties: false },
              { type: "object", required: ["mode", "count"], properties: { mode: { const: "fixed" }, count: { type: "integer", minimum: 1, maximum: 6 } }, additionalProperties: false },
            ],
            default: { mode: "auto" },
          },
        },
      },
      SuccessMediaPlan: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "object",
            required: ["policyVersion", "scenes", "segments", "diagnostics"],
            properties: {
              policyVersion: { type: "string" },
              range: { anyOf: [{ type: "null" }, { type: "object", required: ["min", "max"], properties: { min: { type: "integer" }, max: { type: "integer" } } }] },
              scenes: { type: "array", items: { type: "object", required: ["sceneId", "mediaAssetVersionId", "segmentId", "sourceStartMs", "sourceDurationMs"], properties: { sceneId: { type: "string" }, mediaAssetVersionId: { type: ["string", "null"] }, segmentId: { type: ["string", "null"] }, sourceStartMs: { type: ["integer", "null"] }, sourceDurationMs: { type: ["integer", "null"] } } } },
              segments: { type: "array", items: { type: "object", required: ["segmentId", "sceneIds", "mediaAssetVersionId", "subject", "priority"], properties: { segmentId: { type: "string" }, sceneIds: { type: "array", items: { type: "string" } }, mediaAssetVersionId: { type: ["string", "null"] }, subject: { type: ["string", "null"] }, priority: { type: ["integer", "null"] } } } },
              diagnostics: { type: "array", items: { type: "object" } },
            },
          },
          meta: { $ref: "#/components/schemas/RequestMeta" },
        },
      },
    },
  },
} satisfies OpenAPIV3_1.Document;
