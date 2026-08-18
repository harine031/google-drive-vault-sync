import { describe, expect, it } from "vitest";
import { base64Url } from "../src/crypto-utils";
import { createPairingCode, readPairingCode } from "../src/pairing";

const vaultKey = base64Url(new Uint8Array(32).fill(7));
const payload = {
  clientId: "client.apps.googleusercontent.com",
  clientSecret: "client-secret-value",
  refreshToken: "refresh-token-value",
  vaultId: "vault-id",
  vaultKey,
  remoteFolderName: "Obsidian Vault Sync - MySyncVault"
};

describe("device pairing v2", () => {
  it("round-trips encrypted OAuth data with an expiry", async () => {
    const now = Date.UTC(2026, 7, 5, 0, 0, 0);
    const code = await createPairingCode(payload, "correct horse battery staple", now);
    expect(code.startsWith("GDVS2.")).toBe(true);
    await expect(readPairingCode(code, "correct horse battery staple", now + 60_000)).resolves.toEqual({
      version: 2,
      ...payload,
      pairingId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      issuedAt: now,
      expiresAt: now + 10 * 60 * 1000
    });
  });

  it("rejects the wrong or short passphrase", async () => {
    const code = await createPairingCode(payload, "a sufficiently long password");
    await expect(readPairingCode(code, "another long password")).rejects.toThrow();
    await expect(createPairingCode(payload, "short password")).rejects.toThrow("16文字以上");
  });

  it("rejects expired and legacy codes", async () => {
    const now = Date.UTC(2026, 7, 5, 0, 0, 0);
    const code = await createPairingCode(payload, "correct horse battery staple", now);
    await expect(readPairingCode(code, "correct horse battery staple", now + 11 * 60 * 1000)).rejects.toThrow("有効期限");
    await expect(readPairingCode("GDVS1.a.b.c", "correct horse battery staple", now)).rejects.toThrow("GDVS2");
  });
});
