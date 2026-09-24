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
});
