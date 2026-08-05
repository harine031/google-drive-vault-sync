export interface PairingPayload {
  version: 1;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  vaultId: string;
}

const ITERATIONS = 250_000;
const PREFIX = "GDVS1";

export async function createPairingCode(
  payload: Omit<PairingPayload, "version">,
  passphrase: string
): Promise<string> {
  validatePassphrase(passphrase);
  if (!payload.clientId || !payload.clientSecret || !payload.refreshToken || !payload.vaultId) {
    throw new Error("Google認証とVault IDの設定が必要です");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 1, ...payload }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return [PREFIX, base64Url(salt), base64Url(iv), base64Url(new Uint8Array(encrypted))].join(".");
}

export async function readPairingCode(code: string, passphrase: string): Promise<PairingPayload> {
  validatePassphrase(passphrase);
  const parts = code.trim().split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("ペアリングコードの形式が正しくありません");
  try {
    const salt = fromBase64Url(parts[1]);
    const iv = fromBase64Url(parts[2]);
    const encrypted = fromBase64Url(parts[3]);
    const key = await deriveKey(passphrase, salt, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      key,
      encrypted.buffer as ArrayBuffer
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as PairingPayload;
    if (payload.version !== 1 || !payload.clientId || !payload.clientSecret || !payload.refreshToken || !payload.vaultId) {
      throw new Error("ペアリングデータが不完全です");
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message === "ペアリングデータが不完全です") throw error;
    throw new Error("ペアリングコードまたはパスフレーズが正しくありません");
  }
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  usages: KeyUsage[]
): Promise<CryptoKey> {
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
  if (passphrase.length < 12) throw new Error("パスフレーズは12文字以上にしてください");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
