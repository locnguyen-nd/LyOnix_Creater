import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";

describe("secret-crypto", () => {
  it("round-trips a credential and does not echo plaintext in the envelope", () => {
    const previous = process.env.PERSISTENCE_ENCRYPTION_KEY;
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const envelope = encryptSecret("sk-live-example");
      expect(envelope.startsWith("v1.")).toBe(true);
      expect(envelope.includes("sk-live-example")).toBe(false);
      expect(decryptSecret(envelope)).toBe("sk-live-example");
    } finally {
      process.env.PERSISTENCE_ENCRYPTION_KEY = previous;
    }
  });
});
