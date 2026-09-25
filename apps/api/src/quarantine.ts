import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSafeRelativePath } from "@lyonix/domain";
import { mediaRoot } from "./handoff-workspace.js";

/**
 * Minimal local quarantine primitive reused by any future upload/import flow
 * (V03-01 chunked upload, VE2E-04 Pexels import). A file is always written to
 * `_quarantine/<uuid>` first, then promoted into a content-addressed,
 * server-derived path under the project's asset tree — the client never
 * supplies or controls a filesystem path.
 */

export type QuarantinedFile = { quarantineToken: string; sha256: string; bytes: number };

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM_RE = /^[0-9a-f]{64}$/i;

const quarantineDir = () => join(mediaRoot(), "_quarantine");
const assetRelativePath = (projectId: string, checksumSha256: string, extension: string) =>
  `projects/${projectId}/assets/${checksumSha256}${extension}`;

export const sanitizeExtension = (fileName: string): string => {
  const match = /\.[a-z0-9]{1,10}$/i.exec(fileName);
  return match ? match[0].toLowerCase() : "";
};

export async function writeQuarantineFile(buffer: Buffer): Promise<QuarantinedFile> {
  const dir = quarantineDir();
  await mkdir(dir, { recursive: true });
  const token = randomUUID();
  await writeFile(join(dir, token), buffer);
  return { quarantineToken: token, sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.byteLength };
}

export async function readQuarantineFile(token: string): Promise<Buffer> {
  if (!TOKEN_RE.test(token)) throw new Error("invalid_quarantine_token");
  return readFile(join(quarantineDir(), token));
}

/** Move a quarantined file into project storage at a checksum-derived path. Never trusts a client path. */
export async function promoteQuarantineFileToProjectAsset(input: {
  quarantineToken: string;
  projectId: string;
  checksumSha256: string;
  originalFileName: string;
}): Promise<{ relativePath: string }> {
  if (!TOKEN_RE.test(input.quarantineToken)) throw new Error("invalid_quarantine_token");
  if (!CHECKSUM_RE.test(input.checksumSha256)) throw new Error("invalid_checksum");
  const extension = sanitizeExtension(input.originalFileName);
  const relativePath = assetRelativePath(input.projectId, input.checksumSha256.toLowerCase(), extension);
  if (!isSafeRelativePath(relativePath)) throw new Error("unsafe_relative_path");
  const dest = join(mediaRoot(), relativePath);
  const src = join(quarantineDir(), input.quarantineToken);
  await mkdir(dirname(dest), { recursive: true });
  const alreadyStored = await stat(dest).then(() => true).catch(() => false);
  if (alreadyStored) {
    await rm(src, { force: true }); // duplicate checksum: reuse the already-stored bytes, drop the quarantine copy
  } else {
    await rename(src, dest);
  }
  return { relativePath };
}
