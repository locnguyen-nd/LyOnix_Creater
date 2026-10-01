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
    "/queue-summary": {
      get: {
        operationId: "getQueueSummary",
        summary: "Concurrency + queue summary per kind (workflow, render, media): active, limit, queued",
        responses: {
          "200": { description: "Queue summary", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessQueueSummary" } } } },
        },
      },
    },
    "/video-productions/{id}/cancel": {
      post: {
        operationId: "cancelQueuedVideoProduction",
        summary: "Cancel an Auto run that is still waiting in the queue (status draft); a run already started cannot be cancelled",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Run removed from the queue (status cancelled)", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessCancelled" } } } },
          "404": { description: "Run not found", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
          "409": { description: "Run is no longer queued (INVALID_STATE)", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } } } },
        },
      },
    },
    "/video-productions/{id}": {
      get: {
        operationId: "getVideoProduction",
        summary: "Auto run detail incl. queue state (queue.queuePosition, queue.queuedAt, queue.startedAt)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Run", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessVideoProduction" } } } },
        },
      },
    },
    "/render-jobs/{id}": {
      get: {
        operationId: "getRenderJob",
        summary: "Render job incl. queue state (queueKind, queuePosition, queuedAt, startedAt)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Render job", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessRenderJob" } } } },
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
      QueueState: {
        type: "object",
        required: ["queuePosition", "queuedAt", "startedAt"],
        properties: {
          queuePosition: { type: ["integer", "null"], minimum: 1, description: "1-based among queued items of the same kind; null when not waiting" },
          queuedAt: { type: ["string", "null"], format: "date-time" },
          startedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      QueueSummary: {
        type: "object",
        required: ["kind", "active", "limit", "queued"],
        properties: {
          kind: { type: "string", enum: ["workflow", "render", "media"] },
          active: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1 },
          queued: { type: "integer", minimum: 0 },
        },
      },
      SuccessQueueSummary: {
        type: "object",
        required: ["data", "meta"],
        properties: { data: { type: "array", items: { $ref: "#/components/schemas/QueueSummary" } }, meta: { $ref: "#/components/schemas/RequestMeta" } },
      },
      SuccessCancelled: {
        type: "object",
        required: ["data", "meta"],
        properties: { data: { type: "object", required: ["cancelled"], properties: { cancelled: { const: true } } }, meta: { $ref: "#/components/schemas/RequestMeta" } },
      },
      SuccessVideoProduction: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { type: "object", required: ["id", "status", "queue"], properties: { id: { type: "string" }, status: { type: "string" }, queue: { $ref: "#/components/schemas/QueueState" } } },
          meta: { $ref: "#/components/schemas/RequestMeta" },
        },
      },
      SuccessRenderJob: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "object",
            required: ["id", "status"],
            properties: {
              id: { type: "string" },
              status: { type: "string" },
              queueKind: { type: ["string", "null"], enum: ["render", "media", null] },
              queuePosition: { type: ["integer", "null"], minimum: 1 },
              queuedAt: { type: ["string", "null"], format: "date-time" },
              startedAt: { type: ["string", "null"], format: "date-time" },
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
