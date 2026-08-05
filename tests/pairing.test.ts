import { describe, expect, it } from "vitest";
import { createPairingCode, readPairingCode } from "../src/pairing";

describe("device pairing", () => {
  it("round-trips encrypted OAuth data", async () => {
    const payload = {
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "client-secret-value",
      refreshToken: "refresh-token-value",
      vaultId: "vault-id"
    };
    const code = await createPairingCode(payload, "correct horse battery staple");
    expect(code.startsWith("GDVS1.")).toBe(true);
    await expect(readPairingCode(code, "correct horse battery staple")).resolves.toEqual({ version: 1, ...payload });
  });

  it("rejects the wrong passphrase", async () => {
    const code = await createPairingCode({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "token",
      vaultId: "vault"
    }, "a sufficiently long password");
    await expect(readPairingCode(code, "another long password")).rejects.toThrow();
  });

  it("requires a reasonably long passphrase", async () => {
    await expect(createPairingCode({ clientId: "c", clientSecret: "s", refreshToken: "r", vaultId: "v" }, "short")).rejects.toThrow("12文字以上");
  });
});
