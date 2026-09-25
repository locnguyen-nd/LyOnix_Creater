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
    },
  },
} satisfies OpenAPIV3_1.Document;
