import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const hashPassword = (v: string, s = randomBytes(16).toString("hex")) => `${s}:${scryptSync(v, s, 64).toString("hex")}`;

export const passwordMatches = (v: string, encoded: string) => {
  const [s, expected] = encoded.split(":");
  if (!s || !expected) return false;
  const actual = scryptSync(v, s, 64).toString("hex");
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
};
