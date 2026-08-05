import { requestUrl } from "obsidian";
import { isSafeVaultPath } from "./path-policy";
import type { RemoteFileInfo } from "./types";

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

export class GoogleDriveClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly vaultId: () => string,
    private readonly folderName: () => string
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
      ensureSuccess(response.status, "Driveファイル一覧の取得");
      const data = response.json as DriveListResponse;
      for (const file of data.files ?? []) {
        const path = file.appProperties?.path;
        const hash = file.appProperties?.sha256;
        if (!path || !hash || !isSafeVaultPath(path)) continue;
        files.push({
          id: file.id,
          path,
          hash,
          size: Number(file.size ?? 0),
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime ?? ""
        });
      }
      pageToken = data.nextPageToken ?? "";
    } while (pageToken);
    return deduplicateByNewest(files);
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    const response = await this.request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, "GET");
    ensureSuccess(response.status, "ファイルのダウンロード");
    return response.arrayBuffer;
  }

  async upload(
    path: string,
    bytes: ArrayBuffer,
    mimeType: string,
    sha256: string,
    existingFileId?: string
  ): Promise<RemoteFileInfo> {
    const folderId = await this.ensureVaultFolder();
    const metadata: Record<string, unknown> = {
      name: basename(path),
      mimeType,
      appProperties: {
        vaultId: this.vaultId(),
        kind: "vaultFile",
        path,
        sha256
      }
    };
    if (!existingFileId) metadata.parents = [folderId];
    const boundary = `obsidian-sync-${crypto.randomUUID()}`;
    const body = multipartBody(boundary, metadata, mimeType, bytes);
    const url = existingFileId
      ? `${UPLOAD_API}/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,appProperties`
      : `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,appProperties`;
    const response = await this.request(url, existingFileId ? "PATCH" : "POST", body, {
      "Content-Type": `multipart/related; boundary=${boundary}`
    });
    ensureSuccess(response.status, "ファイルのアップロード");
    const file = response.json as DriveFileResource;
    return {
      id: file.id,
      path,
      hash: sha256,
      size: Number(file.size ?? bytes.byteLength),
      mimeType,
      modifiedTime: file.modifiedTime ?? new Date().toISOString()
    };
  }

  private async ensureVaultFolder(): Promise<string> {
    const query = `trashed = false and mimeType = '${FOLDER_MIME}' and appProperties has { key='vaultId' and value='${escapeQuery(this.vaultId())}' } and appProperties has { key='kind' and value='vaultRoot' }`;
    const params = new URLSearchParams({
      q: query,
      spaces: "drive",
      pageSize: "1",
      fields: "files(id)"
    });
    const search = await this.request(`${API}/files?${params.toString()}`, "GET");
    ensureSuccess(search.status, "同期フォルダーの検索");
    const existing = (search.json as DriveListResponse).files?.[0];
    if (existing) return existing.id;

    const create = await this.request(
      `${API}/files?fields=id`,
      "POST",
      JSON.stringify({
        name: this.folderName(),
        mimeType: FOLDER_MIME,
        appProperties: { vaultId: this.vaultId(), kind: "vaultRoot" }
      }),
      { "Content-Type": "application/json" }
    );
    ensureSuccess(create.status, "同期フォルダーの作成");
    return (create.json as DriveFileResource).id;
  }

  private async request(
    url: string,
    method: string,
    body?: string | ArrayBuffer,
    headers: Record<string, string> = {}
  ) {
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

function ensureSuccess(status: number, operation: string): void {
  if (status < 200 || status >= 300) throw new Error(`${operation}に失敗しました (${status})`);
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function multipartBody(
  boundary: string,
  metadata: Record<string, unknown>,
  mimeType: string,
  content: ArrayBuffer
): ArrayBuffer {
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

function deduplicateByNewest(files: RemoteFileInfo[]): RemoteFileInfo[] {
  const byPath = new Map<string, RemoteFileInfo>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing || file.modifiedTime > existing.modifiedTime) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}
