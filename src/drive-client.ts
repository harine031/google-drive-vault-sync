import { requestUrl, type RequestUrlResponse } from "obsidian";
import { createDeletionAuth, DELETION_FORMAT, verifyDeletionAuth } from "./deletion-tombstone";
import { decryptVaultFile, encryptVaultFile, FILE_ENCRYPTION_FORMAT, verifyLegacyVaultFile } from "./file-crypto";
import { assertNoPathCollisions, isSafeVaultPath } from "./path-policy";
import { MAX_FILE_SIZE_BYTES, type RemoteFileInfo } from "./types";

interface DriveFileResource {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  appProperties?: Record<string, string>;
}

interface DriveListResponse {
  files: DriveFileResource[];
  nextPageToken?: string;
}

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DRIVE_PROPERTY_MAX_BYTES = 124;
const PATH_PART_COUNT_KEY = "pathParts";
const MAX_PATH_PARTS = 10;

export class GoogleDriveClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly vaultId: () => string,
    private readonly folderName: () => string,
    private readonly getVaultKey: () => string
  ) {}

  async testConnection(): Promise<boolean> {
    const response = await this.request(`${API}/files?pageSize=1&fields=files(id)`, "GET");
    return response.status >= 200 && response.status < 300;
  }

  async listVaultFiles(): Promise<RemoteFileInfo[]> {
    const files: RemoteFileInfo[] = [];
    let pageToken = "";
    do {
      const query = `trashed = false and appProperties has { key='vaultId' and value='${escapeQuery(this.vaultId())}' } and appProperties has { key='kind' and value='vaultFile' }`;
      const params = new URLSearchParams({
        q: query,
        spaces: "drive",
        pageSize: "1000",
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,appProperties)"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.request(`${API}/files?${params.toString()}`, "GET");
      ensureSuccess(response, "Driveファイル一覧の取得");
      const data = response.json as DriveListResponse;
      for (const file of data.files ?? []) {
        files.push(await parseRemoteFile(file, this.vaultId(), this.getVaultKey()));
      }
      pageToken = data.nextPageToken ?? "";
    } while (pageToken);
    assertNoPathCollisions(files.map((file) => file.path));
    return files;
  }

  async downloadVerified(remote: RemoteFileInfo): Promise<ArrayBuffer> {
    if (!remote.encrypted || !remote.cipherHash || !remote.iv) {
      throw new Error(`${remote.path}: 平文の旧形式です。Windows側で暗号化移行してください`);
    }
    assertAllowedSize(remote.size, 16);
    const response = await this.request(`${API}/files/${encodeURIComponent(remote.id)}?alt=media`, "GET");
    ensureSuccess(response, "ファイルのダウンロード");
    assertAllowedSize(response.arrayBuffer.byteLength, 16);
    return decryptVaultFile(
      response.arrayBuffer,
      this.getVaultKey(),
      this.vaultId(),
      remote.path,
      remote.iv,
      remote.cipherHash,
      remote.hash
    );
  }

  async downloadLegacyVerified(remote: RemoteFileInfo): Promise<ArrayBuffer> {
    if (remote.encrypted) throw new Error(`${remote.path}: 暗号化済みファイルは旧形式移行できません`);
    assertAllowedSize(remote.size);
    const response = await this.request(`${API}/files/${encodeURIComponent(remote.id)}?alt=media`, "GET");
    ensureSuccess(response, "旧形式ファイルの安全な取得");
    const bytes = response.arrayBuffer;
    assertAllowedSize(bytes.byteLength);
    await verifyLegacyVaultFile(bytes, remote.size, remote.hash, remote.path);
    return bytes;
  }

  async uploadEncrypted(
    path: string,
    bytes: ArrayBuffer,
    mimeType: string,
    sha256: string,
    existingFileId?: string
  ): Promise<RemoteFileInfo> {
    assertAllowedSize(bytes.byteLength);
    if (!isSafeVaultPath(path)) throw new Error(`${path}: アップロード対象のパスが安全ではありません`);
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`${path}: SHA-256形式が正しくありません`);
    const encrypted = await encryptVaultFile(bytes, this.getVaultKey(), this.vaultId(), path);
    const folderId = await this.ensureVaultFolder();
    const metadata: Record<string, unknown> = {
      name: basename(path),
      mimeType: "application/octet-stream",
      appProperties: {
        vaultId: this.vaultId(),
        kind: "vaultFile",
        ...encodeDrivePathProperties(path),
        sha256,
        cipherSha256: encrypted.cipherHash,
        encryption: FILE_ENCRYPTION_FORMAT,
        iv: encrypted.iv,
        originalMimeType: mimeType,
        deletedAt: null,
        deletion: null,
        deletionAuth: null
      }
    };
    if (!existingFileId) metadata.parents = [folderId];
    const boundary = `obsidian-sync-${crypto.randomUUID()}`;
    const body = multipartBody(boundary, metadata, "application/octet-stream", encrypted.bytes);
    const url = existingFileId
      ? `${UPLOAD_API}/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,appProperties`
      : `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,appProperties`;
    const response = await this.request(url, existingFileId ? "PATCH" : "POST", body, {
      "Content-Type": `multipart/related; boundary=${boundary}`
    });
    ensureSuccess(response, "ファイルの暗号化アップロード");
    const file = response.json as DriveFileResource;
    return {
      id: file.id,
      path,
      hash: sha256,
      size: Number(file.size ?? encrypted.bytes.byteLength),
      mimeType,
      modifiedTime: file.modifiedTime ?? new Date().toISOString(),
      encrypted: true,
      cipherHash: encrypted.cipherHash,
      iv: encrypted.iv
    };
  }

  async markDeleted(remote: RemoteFileInfo): Promise<RemoteFileInfo> {
    if (!remote.encrypted) throw new Error(`${remote.path}: 平文の旧形式は削除同期できません`);
    if (!remote.cipherHash || !remote.iv) throw new Error(`${remote.path}: Drive暗号メタデータが不完全です`);
    if (remote.deletedAt) throw new Error(`${remote.path}: Drive削除履歴は登録済みです`);
    const deletedAt = new Date().toISOString();
    const deletionAuth = await createDeletionAuth(this.getVaultKey(), {
      vaultId: this.vaultId(),
      fileId: remote.id,
      path: remote.path,
      hash: remote.hash,
      cipherHash: remote.cipherHash,
      iv: remote.iv,
      size: remote.size,
      deletedAt
    });
    const response = await this.request(
      `${API}/files/${encodeURIComponent(remote.id)}?fields=id,name,mimeType,modifiedTime,size,appProperties`,
      "PATCH",
      JSON.stringify({
        appProperties: {
          deletedAt,
          deletion: DELETION_FORMAT,
          deletionAuth
        }
      }),
      { "Content-Type": "application/json" }
    );
    ensureSuccess(response, "Drive削除履歴の登録");
    return parseRemoteFile(response.json as DriveFileResource, this.vaultId(), this.getVaultKey());
  }

  private async ensureVaultFolder(): Promise<string> {
    const desiredName = validateFolderName(this.folderName());
    const query = `trashed = false and mimeType = '${FOLDER_MIME}' and appProperties has { key='vaultId' and value='${escapeQuery(this.vaultId())}' } and appProperties has { key='kind' and value='vaultRoot' }`;
    const params = new URLSearchParams({ q: query, spaces: "drive", pageSize: "1", fields: "files(id,name)" });
    const search = await this.request(`${API}/files?${params.toString()}`, "GET");
    ensureSuccess(search, "同期フォルダーの検索");
    const existing = (search.json as DriveListResponse).files?.[0];
    if (existing) {
      if (existing.name !== desiredName) {
        const rename = await this.request(
          `${API}/files/${encodeURIComponent(existing.id)}?fields=id,name`,
          "PATCH",
          JSON.stringify({ name: desiredName }),
          { "Content-Type": "application/json" }
        );
        ensureSuccess(rename, "同期フォルダー名の更新");
      }
      return existing.id;
    }
    const create = await this.request(
      `${API}/files?fields=id`,
      "POST",
      JSON.stringify({
        name: desiredName,
        mimeType: FOLDER_MIME,
        appProperties: { vaultId: this.vaultId(), kind: "vaultRoot" }
      }),
      { "Content-Type": "application/json" }
    );
    ensureSuccess(create, "同期フォルダーの作成");
    return (create.json as DriveFileResource).id;
  }

  private async request(url: string, method: string, body?: string | ArrayBuffer, headers: Record<string, string> = {}) {
    const token = await this.getAccessToken();
    return requestUrl({
      url,
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
      throw: false
    });
  }
}

export function validateFolderName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 255 || /[\u0000-\u001F]/.test(name)) {
    throw new Error("Driveフォルダー名は1〜255文字で指定してください");
  }
  return name;
}

async function parseRemoteFile(file: DriveFileResource, vaultId: string, vaultKey: string): Promise<RemoteFileInfo> {
  const properties = file.appProperties ?? {};
  const path = decodeDrivePathProperties(properties);
  const hash = properties.sha256;
  if (!path || !isSafeVaultPath(path)) throw new Error(`${path || file.name}: Drive上のパスが安全ではありません`);
  if (!hash || !SHA256_PATTERN.test(hash)) throw new Error(`${path}: Drive上のSHA-256が正しくありません`);
  const size = Number(file.size ?? 0);
  if (!Number.isFinite(size) || size < 0) throw new Error(`${path}: Drive上のファイルサイズが正しくありません`);
  const encrypted = properties.encryption === FILE_ENCRYPTION_FORMAT;
  if (properties.encryption && !encrypted) throw new Error(`${path}: 未対応の暗号化形式です`);
  if (encrypted && (!properties.cipherSha256 || !SHA256_PATTERN.test(properties.cipherSha256) || !properties.iv)) {
    throw new Error(`${path}: Drive暗号メタデータが不完全です`);
  }
  const deletionValues = [properties.deletedAt, properties.deletion, properties.deletionAuth].filter(Boolean);
  let deletedAt: string | undefined;
  if (deletionValues.length > 0) {
    deletedAt = properties.deletedAt;
    if (!deletedAt || properties.deletion !== DELETION_FORMAT || !properties.deletionAuth || !isIsoTimestamp(deletedAt)) {
      throw new Error(`${path}: Drive削除履歴が不完全です`);
    }
    const authenticated = await verifyDeletionAuth(vaultKey, {
      vaultId,
      fileId: file.id,
      path,
      hash,
      cipherHash: properties.cipherSha256 as string,
      iv: properties.iv as string,
      size,
      deletedAt
    }, properties.deletionAuth);
    if (!authenticated) throw new Error(`${path}: Drive削除履歴の認証に失敗しました`);
  }
  assertAllowedSize(size, encrypted ? 16 : 0);
  return {
    id: file.id,
    path,
    hash,
    size,
    mimeType: properties.originalMimeType ?? file.mimeType,
    modifiedTime: file.modifiedTime ?? "",
    encrypted,
    cipherHash: properties.cipherSha256,
    iv: properties.iv,
    deletedAt
  };
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function assertAllowedSize(size: number, encryptionOverhead = 0): void {
  if (size > MAX_FILE_SIZE_BYTES + encryptionOverhead) {
    throw new Error(`100 MiBを超えるファイルは安全のため同期できません (${size} bytes)`);
  }
}

function ensureSuccess(response: RequestUrlResponse, operation: string): void {
  if (response.status >= 200 && response.status < 300) return;
  const reason = driveErrorReason(response);
  throw new Error(`${operation}に失敗しました (${response.status}${reason ? `: ${reason}` : ""})`);
}

export function encodeDrivePathProperties(path: string): Record<string, string | null> {
  if (drivePropertyBytes("path", path) <= DRIVE_PROPERTY_MAX_BYTES) return { path };
  const chunks: string[] = [];
  let chunk = "";
  for (const character of path) {
    const key = `path${chunks.length}`;
    if (drivePropertyBytes(key, character) > DRIVE_PROPERTY_MAX_BYTES) {
      throw new Error(`${path}: Driveパスの1文字がカスタムプロパティ上限を超えています`);
    }
    if (chunk && drivePropertyBytes(key, chunk + character) > DRIVE_PROPERTY_MAX_BYTES) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk += character;
    }
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length < 2 || chunks.length > MAX_PATH_PARTS) {
    throw new Error(`${path}: Driveパスを安全な個数へ分割できません`);
  }
  const result: Record<string, string | null> = { path: null, [PATH_PART_COUNT_KEY]: String(chunks.length) };
  chunks.forEach((value, index) => {
    result[`path${index}`] = value;
  });
  return result;
}

export function decodeDrivePathProperties(properties: Record<string, string>): string | undefined {
  const direct = properties.path;
  const countValue = properties[PATH_PART_COUNT_KEY];
  if (direct && countValue) throw new Error("Drive上のパス情報が重複しています");
  if (direct) {
    if (drivePropertyBytes("path", direct) > DRIVE_PROPERTY_MAX_BYTES) {
      throw new Error("Drive上のパス情報がカスタムプロパティ上限を超えています");
    }
    return direct;
  }
  if (!countValue) return undefined;
  if (!/^[1-9][0-9]?$/.test(countValue)) throw new Error("Drive上の分割パス件数が正しくありません");
  const count = Number(countValue);
  if (count < 2 || count > MAX_PATH_PARTS) throw new Error("Drive上の分割パス件数が範囲外です");
  const unexpected = Object.keys(properties).find((key) => {
    const match = /^path([0-9]+)$/.exec(key);
    return match ? Number(match[1]) >= count : false;
  });
  if (unexpected) throw new Error("Drive上の分割パスに余分な要素があります");
  let path = "";
  for (let index = 0; index < count; index += 1) {
    const key = `path${index}`;
    const value = properties[key];
    if (!value || drivePropertyBytes(key, value) > DRIVE_PROPERTY_MAX_BYTES) {
      throw new Error("Drive上の分割パスが不完全です");
    }
    path += value;
  }
  return path;
}

function drivePropertyBytes(key: string, value: string): number {
  return new TextEncoder().encode(key + value).byteLength;
}

function driveErrorReason(response: RequestUrlResponse): string {
  type DriveErrorBody = { error?: { status?: unknown; errors?: Array<{ reason?: unknown }> } };
  let body: DriveErrorBody;
  try {
    body = response.json as DriveErrorBody;
  } catch {
    return "";
  }
  const candidates = [body?.error?.errors?.[0]?.reason, body?.error?.status];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate)) return candidate;
  }
  return "";
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function multipartBody(boundary: string, metadata: Record<string, unknown>, mimeType: string, content: ArrayBuffer): ArrayBuffer {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const suffix = encoder.encode(`\r\n--${boundary}--`);
  const result = new Uint8Array(prefix.byteLength + content.byteLength + suffix.byteLength);
  result.set(prefix, 0);
  result.set(new Uint8Array(content), prefix.byteLength);
  result.set(suffix, prefix.byteLength + content.byteLength);
  return result.buffer;
}
