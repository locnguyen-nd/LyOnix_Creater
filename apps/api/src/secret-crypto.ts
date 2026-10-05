import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const key = () => {
  const raw = process.env.PERSISTENCE_ENCRYPTION_KEY;
  if (!raw) throw new Error("PERSISTENCE_ENCRYPTION_KEY is required to persist a credential");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) throw new Error("PERSISTENCE_ENCRYPTION_KEY must decode to 32 bytes");
  return decoded;
};

/** Versioned AES-256-GCM envelope. Never return this value from an API. */
export const encryptSecret = (plainText: string) => {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
};

export const decryptSecret = (envelope: string) => {
  const [version, iv, tag, data] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Invalid encrypted credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
};
