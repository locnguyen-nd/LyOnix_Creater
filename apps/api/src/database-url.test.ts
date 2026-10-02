import { describe, expect, it } from "vitest";
import { resolveDatabasePool } from "./database-url.js";

const URL_BASE = "postgresql://u:p@localhost:5432/db?schema=public";

describe("resolveDatabasePool", () => {
  it("does nothing when DATABASE_POOL_SIZE is unset", () => {
    expect(resolveDatabasePool({ DATABASE_URL: URL_BASE })).toEqual({ url: null, poolSize: null, warning: null });
  });

  it("appends connection_limit and keeps the other query params", () => {
    const result = resolveDatabasePool({ DATABASE_URL: URL_BASE, DATABASE_POOL_SIZE: "40" });
    expect(result.poolSize).toBe(40);
    const url = new URL(result.url!);
    expect(url.searchParams.get("connection_limit")).toBe("40");
    expect(url.searchParams.get("schema")).toBe("public");
  });

  it("lets an explicit connection_limit in the URL win", () => {
    expect(resolveDatabasePool({ DATABASE_URL: `${URL_BASE}&connection_limit=7`, DATABASE_POOL_SIZE: "40" })).toEqual({ url: null, poolSize: null, warning: null });
  });

  it("warns and falls back on invalid input", () => {
    expect(resolveDatabasePool({ DATABASE_URL: URL_BASE, DATABASE_POOL_SIZE: "0" }).warning).toMatch(/not an integer/);
    expect(resolveDatabasePool({ DATABASE_URL: URL_BASE, DATABASE_POOL_SIZE: "abc" }).url).toBeNull();
    expect(resolveDatabasePool({ DATABASE_POOL_SIZE: "10" }).warning).toMatch(/DATABASE_URL is not set/);
    expect(resolveDatabasePool({ DATABASE_URL: "not a url", DATABASE_POOL_SIZE: "10" }).warning).toMatch(/not a valid URL/);
  });
});
