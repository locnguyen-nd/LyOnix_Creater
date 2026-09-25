import { describe, expect, it } from "vitest";
import { hashPassword, passwordMatches } from "./password.js";

describe("password hash", () => {
  it("matches the original secret and rejects a different one", () => {
    const encoded = hashPassword("lyonix-staff");
    expect(passwordMatches("lyonix-staff", encoded)).toBe(true);
    expect(passwordMatches("lyonix-admin", encoded)).toBe(false);
  });
});
