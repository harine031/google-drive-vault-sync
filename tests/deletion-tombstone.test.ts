import { describe, expect, it } from "vitest";
import { createDeletionAuth, verifyDeletionAuth } from "../src/deletion-tombstone";
import { base64Url } from "../src/crypto-utils";

const vaultKey = base64Url(new Uint8Array(32).fill(9));
const input = {
  vaultId: "vault-id",
  fileId: "drive-file-id",
  path: "Notes/deleted.md",
  hash: "a".repeat(64),
  cipherHash: "b".repeat(64),
  iv: "AAAAAAAAAAAAAAAA",
  size: 128,
  deletedAt: "2026-08-19T00:00:00.000Z"
};

describe("authenticated deletion tombstones", () => {
  it("verifies an untampered tombstone", async () => {
    const authentication = await createDeletionAuth(vaultKey, input);
    await expect(verifyDeletionAuth(vaultKey, input, authentication)).resolves.toBe(true);
  });

  it("rejects changes to protected deletion metadata", async () => {
    const authentication = await createDeletionAuth(vaultKey, input);
    await expect(verifyDeletionAuth(vaultKey, { ...input, path: "Notes/other.md" }, authentication)).resolves.toBe(false);
    await expect(verifyDeletionAuth(vaultKey, { ...input, cipherHash: "c".repeat(64) }, authentication)).resolves.toBe(false);
    await expect(verifyDeletionAuth(vaultKey, { ...input, deletedAt: "2026-08-20T00:00:00.000Z" }, authentication)).resolves.toBe(false);
  });
});
