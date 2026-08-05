import { describe, expect, it } from "vitest";
import { randomBase64Url, sha256Hex } from "../src/crypto-utils";
import { decryptVaultFile, encryptVaultFile } from "../src/file-crypto";

describe("vault file encryption", () => {
  it("round-trips and verifies ciphertext and plaintext hashes", async () => {
    const key = randomBase64Url(32);
    const plaintext = new TextEncoder().encode("secret note").buffer;
    const plainHash = await sha256Hex(plaintext);
    const encrypted = await encryptVaultFile(plaintext, key, "vault", "Notes/secret.md");
    const decrypted = await decryptVaultFile(
      encrypted.bytes,
      key,
      "vault",
      "Notes/secret.md",
      encrypted.iv,
      encrypted.cipherHash,
      plainHash
    );
    expect(new TextDecoder().decode(decrypted)).toBe("secret note");
  });

  it("rejects tampering and path substitution", async () => {
    const key = randomBase64Url(32);
    const plaintext = new TextEncoder().encode("secret note").buffer;
    const plainHash = await sha256Hex(plaintext);
    const encrypted = await encryptVaultFile(plaintext, key, "vault", "Notes/secret.md");
    const tampered = new Uint8Array(encrypted.bytes.slice(0));
    tampered[0] ^= 1;
    await expect(decryptVaultFile(
      tampered.buffer,
      key,
      "vault",
      "Notes/secret.md",
      encrypted.iv,
      encrypted.cipherHash,
      plainHash
    )).rejects.toThrow("SHA-256");
    await expect(decryptVaultFile(
      encrypted.bytes,
      key,
      "vault",
      "Notes/other.md",
      encrypted.iv,
      encrypted.cipherHash,
      plainHash
    )).rejects.toThrow("認証");
  });
});
