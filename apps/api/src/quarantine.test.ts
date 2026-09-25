import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteQuarantineFileToProjectAsset, readQuarantineFile, sanitizeExtension, writeQuarantineFile } from "./quarantine.js";

let dir: string;
let previousMediaRoot: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lyonix-media-"));
  previousMediaRoot = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = dir;
});

afterEach(async () => {
  if (previousMediaRoot === undefined) delete process.env.MEDIA_ROOT;
  else process.env.MEDIA_ROOT = previousMediaRoot;
  await rm(dir, { recursive: true, force: true });
});

describe("sanitizeExtension", () => {
  it("keeps a short lowercase extension", () => {
    expect(sanitizeExtension("Photo.PNG")).toBe(".png");
  });
  it("returns empty for no extension or an unreasonably long one", () => {
    expect(sanitizeExtension("noext")).toBe("");
    expect(sanitizeExtension("file.toolongextension")).toBe("");
  });
});

describe("quarantine write/read/promote", () => {
  it("writes then promotes a file to a checksum-derived project path", async () => {
    const buffer = Buffer.from("hello world");
    const quarantined = await writeQuarantineFile(buffer);
    expect(quarantined.bytes).toBe(buffer.byteLength);
    expect(await readQuarantineFile(quarantined.quarantineToken)).toEqual(buffer);

    const promoted = await promoteQuarantineFileToProjectAsset({
      quarantineToken: quarantined.quarantineToken,
      projectId: "11111111-1111-1111-1111-111111111111",
      checksumSha256: quarantined.sha256,
      originalFileName: "hello.txt",
    });
    expect(promoted.relativePath).toBe(`projects/11111111-1111-1111-1111-111111111111/assets/${quarantined.sha256}.txt`);
    const onDisk = await readFile(join(dir, promoted.relativePath));
    expect(onDisk).toEqual(buffer);
  });

  it("deduplicates when the same checksum is promoted twice (second call drops the quarantine copy)", async () => {
    const buffer = Buffer.from("duplicate content");
    const first = await writeQuarantineFile(buffer);
    const second = await writeQuarantineFile(buffer);
    const projectId = "22222222-2222-2222-2222-222222222222";
    const a = await promoteQuarantineFileToProjectAsset({ quarantineToken: first.quarantineToken, projectId, checksumSha256: first.sha256, originalFileName: "a.bin" });
    const b = await promoteQuarantineFileToProjectAsset({ quarantineToken: second.quarantineToken, projectId, checksumSha256: second.sha256, originalFileName: "a.bin" });
    expect(a.relativePath).toBe(b.relativePath);
    // the second quarantine file must be gone (moved-or-dropped), never left dangling
    await expect(stat(join(dir, "_quarantine", second.quarantineToken))).rejects.toThrow();
  });

  it("rejects a malformed quarantine token to prevent path traversal via the token itself", async () => {
    await expect(promoteQuarantineFileToProjectAsset({
      quarantineToken: "../../etc/passwd",
      projectId: "p1",
      checksumSha256: "a".repeat(64),
      originalFileName: "x.txt",
    })).rejects.toThrow("invalid_quarantine_token");
  });

  it("rejects a malformed checksum", async () => {
    const buffer = Buffer.from("x");
    const quarantined = await writeQuarantineFile(buffer);
    await expect(promoteQuarantineFileToProjectAsset({
      quarantineToken: quarantined.quarantineToken,
      projectId: "p1",
      checksumSha256: "not-a-checksum",
      originalFileName: "x.txt",
    })).rejects.toThrow("invalid_checksum");
  });
});
