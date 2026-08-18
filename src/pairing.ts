import { base64Url, fromBase64Url, randomBase64Url } from "./crypto-utils";
import { validateVaultKey } from "./file-crypto";

export interface PairingPayload {
  version: 2;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  vaultId: string;
  vaultKey: string;
  remoteFolderName: string;
  pairingId: string;
  issuedAt: number;
  expiresAt: number;
}

const ITERATIONS = 600_000;
const PREFIX = "GDVS2";
const VALIDITY_MS = 10 * 60 * 1000;
const MAX_CODE_LENGTH = 64 * 1024;

export async function createPairingCode(
  payload: Omit<PairingPayload, "version" | "pairingId" | "issuedAt" | "expiresAt">,
  passphrase: string,
  now = Date.now()
): Promise<string> {
  validatePassphrase(passphrase);
  validatePayload(payload);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify({
    version: 2,
    ...payload,
    pairingId: randomBase64Url(16),
    issuedAt: now,
    expiresAt: now + VALIDITY_MS
  }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return [PREFIX, base64Url(salt), base64Url(iv), base64Url(new Uint8Array(encrypted))].join(".");
}

export async function readPairingCode(code: string, passphrase: string, now = Date.now()): Promise<PairingPayload> {
  validatePassphrase(passphrase);
  if (code.length > MAX_CODE_LENGTH) throw new Error("ペアリングコードが大きすぎます");
  const parts = code.trim().split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("GDVS2ペアリングコードを使用してください");
  }
  try {
    const salt = fromBase64Url(parts[1], 16);
    const iv = fromBase64Url(parts[2], 12);
    const encrypted = fromBase64Url(parts[3], 48 * 1024);
    if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error("ペアリングコードの形式が正しくありません");
    const key = await deriveKey(passphrase, salt, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      key,
      encrypted.buffer as ArrayBuffer
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as PairingPayload;
    if (payload.version !== 2) throw new Error("ペアリングデータのバージョンが正しくありません");
    validatePayload(payload);
    if (typeof payload.pairingId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(payload.pairingId)) {
      throw new Error("ペアリングIDが正しくありません");
    }
    if (!Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt)) {
      throw new Error("ペアリングコードの期限情報が正しくありません");
    }
    if (payload.issuedAt > now + 60_000) throw new Error("ペアリングコードの発行時刻が正しくありません");
    if (payload.expiresAt < now || payload.expiresAt - payload.issuedAt > VALIDITY_MS) {
      throw new Error("ペアリングコードの有効期限が切れています");
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && (
      error.message.includes("有効期限") ||
      error.message.includes("発行時刻") ||
      error.message.includes("バージョン") ||
      error.message.includes("ペアリングID") ||
      error.message.includes("Vault暗号鍵")
    )) throw error;
    throw new Error("ペアリングコードまたはパスフレーズが正しくありません");
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 16) throw new Error("パスフレーズは16文字以上にしてください");
  if (passphrase.length > 256) throw new Error("パスフレーズは256文字以下にしてください");
}

function validatePayload(payload: Partial<PairingPayload>): void {
  for (const value of [payload.clientId, payload.clientSecret, payload.refreshToken, payload.vaultId, payload.vaultKey, payload.remoteFolderName]) {
    if (typeof value !== "string" || !value || value.length > 8192) throw new Error("ペアリングデータが不完全です");
  }
  if ((payload.remoteFolderName as string).length > 255 || /[\u0000-\u001F]/.test(payload.remoteFolderName as string)) {
    throw new Error("同期フォルダー名が正しくありません");
  }
  validateVaultKey(payload.vaultKey as string);
}
