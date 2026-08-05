import { base64Url, fromBase64Url, sha256Hex } from "./crypto-utils";

export const FILE_ENCRYPTION_FORMAT = "aes-gcm-256-v1";

export interface EncryptedVaultFile {
  bytes: ArrayBuffer;
  iv: string;
  cipherHash: string;
}

export async function encryptVaultFile(
  plaintext: ArrayBuffer,
  encodedKey: string,
  vaultId: string,
  path: string
): Promise<EncryptedVaultFile> {
  const key = await importVaultKey(encodedKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = associatedData(vaultId, path);
  const bytes = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv.buffer as ArrayBuffer,
      additionalData: aad.buffer as ArrayBuffer
    },
    key,
    plaintext
  );
  return { bytes, iv: base64Url(iv), cipherHash: await sha256Hex(bytes) };
}

export async function decryptVaultFile(
  ciphertext: ArrayBuffer,
  encodedKey: string,
  vaultId: string,
  path: string,
  encodedIv: string,
  expectedCipherHash: string,
  expectedPlainHash: string
): Promise<ArrayBuffer> {
  if (await sha256Hex(ciphertext) !== expectedCipherHash) {
    throw new Error(`${path}: Drive暗号データのSHA-256が一致しません`);
  }
  const iv = fromBase64Url(encodedIv, 12);
  if (iv.byteLength !== 12) throw new Error(`${path}: 暗号化IVが正しくありません`);
  const key = await importVaultKey(encodedKey, ["decrypt"]);
  const aad = associatedData(vaultId, path);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv.buffer as ArrayBuffer,
        additionalData: aad.buffer as ArrayBuffer
      },
      key,
      ciphertext
    );
  } catch {
    throw new Error(`${path}: Drive暗号データの認証に失敗しました`);
  }
  if (await sha256Hex(plaintext) !== expectedPlainHash) {
    throw new Error(`${path}: 復号後データのSHA-256が一致しません`);
  }
  return plaintext;
}

export function validateVaultKey(encodedKey: string): void {
  if (fromBase64Url(encodedKey, 32).byteLength !== 32) throw new Error("Vault暗号鍵が正しくありません");
}

async function importVaultKey(encodedKey: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const keyBytes = fromBase64Url(encodedKey, 32);
  if (keyBytes.byteLength !== 32) throw new Error("Vault暗号鍵が正しくありません");
  return crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, { name: "AES-GCM" }, false, usages);
}

function associatedData(vaultId: string, path: string): Uint8Array {
  return new TextEncoder().encode(`GDVS-FILE-V1\u0000${vaultId}\u0000${path}`);
}
