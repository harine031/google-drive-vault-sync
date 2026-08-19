import { base64Url, fromBase64Url } from "./crypto-utils";
import { validateVaultKey } from "./file-crypto";

export const DELETION_FORMAT = "HMAC-SHA256-V1";

export interface DeletionAuthInput {
  vaultId: string;
  fileId: string;
  path: string;
  hash: string;
  cipherHash: string;
  iv: string;
  size: number;
  deletedAt: string;
}

export async function createDeletionAuth(vaultKey: string, input: DeletionAuthInput): Promise<string> {
  const key = await deriveAuthenticationKey(vaultKey, input.vaultId, ["sign"]);
  const data = encodedInput(input);
  const signature = await crypto.subtle.sign("HMAC", key, data.buffer as ArrayBuffer);
  return base64Url(new Uint8Array(signature));
}

export async function verifyDeletionAuth(
  vaultKey: string,
  input: DeletionAuthInput,
  authentication: string
): Promise<boolean> {
  try {
    const signature = fromBase64Url(authentication, 32);
    if (signature.byteLength !== 32) return false;
    const key = await deriveAuthenticationKey(vaultKey, input.vaultId, ["verify"]);
    const data = encodedInput(input);
    return crypto.subtle.verify("HMAC", key, signature.buffer as ArrayBuffer, data.buffer as ArrayBuffer);
  } catch {
    return false;
  }
}

function encodedInput(input: DeletionAuthInput): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    "GDVS-DELETE-V1",
    input.vaultId,
    input.fileId,
    input.path,
    input.hash,
    input.cipherHash,
    input.iv,
    input.size,
    input.deletedAt
  ]));
}

async function deriveAuthenticationKey(vaultKey: string, vaultId: string, usages: KeyUsage[]): Promise<CryptoKey> {
  validateVaultKey(vaultKey);
  const bytes = fromBase64Url(vaultKey, 32);
  const baseKey = await crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);
  const encoder = new TextEncoder();
  const salt = encoder.encode("Google Drive Vault Sync deletion authentication key v1");
  const info = encoder.encode(vaultId);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt.buffer as ArrayBuffer,
      info: info.buffer as ArrayBuffer
    },
    baseKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    usages
  );
}
