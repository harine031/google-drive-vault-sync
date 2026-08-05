import { App, normalizePath } from "obsidian";
import { sha256Hex } from "./crypto-utils";
import { GoogleDriveClient } from "./drive-client";
import {
  assertNoPathCollisions,
  isPathExcluded,
  isSafeVaultPath,
  mimeTypeForPath,
  shouldTraverseFolder
} from "./path-policy";
import { buildSyncPlan } from "./sync-plan";
import type {
  LocalFileInfo,
  PluginSettings,
  RemoteFileInfo,
  SyncAction,
  SyncStateData
} from "./types";
import { MAX_FILE_SIZE_BYTES } from "./types";

export interface SyncResult {
  plan: SyncAction[];
  applied: number;
}

export class SyncEngine {
  constructor(
    private readonly app: App,
    private readonly settings: PluginSettings,
    private readonly state: SyncStateData,
    private readonly drive: GoogleDriveClient,
    private readonly persist: () => Promise<void>
  ) {}

  async preview(): Promise<SyncAction[]> {
    const [local, remoteFiles] = await Promise.all([this.scanLocalFiles(), this.drive.listVaultFiles()]);
    const remote = this.applyRemotePolicy(remoteFiles);
    return buildSyncPlan(local, remote, this.state);
  }

  async apply(plan: SyncAction[]): Promise<SyncResult> {
    await this.assertRemotePlanUnchanged(plan);
    let applied = 0;
    for (const action of plan) {
      if (action.kind === "migrate" && action.remote) {
        await this.assertRemoteActionUnchanged(action);
        const bytes = await this.drive.downloadLegacyVerified(action.remote);
        const uploaded = await this.drive.uploadEncrypted(
          action.path,
          bytes,
          action.remote.mimeType,
          action.remote.hash,
          action.remote.id
        );
        if (action.local?.hash === action.remote.hash && !action.remote.excluded) {
          this.state.records[action.path] = {
            localHash: action.local.hash,
            remoteHash: uploaded.hash,
            remoteFileId: uploaded.id
          };
        } else {
          delete this.state.records[action.path];
        }
        applied += 1;
      } else if (action.kind === "upload" && action.local) {
        await this.assertRemoteActionUnchanged(action);
        const bytes = await this.readLocalVerified(action.local);
        const uploaded = await this.drive.uploadEncrypted(
          action.path,
          bytes,
          action.local.mimeType,
          action.local.hash,
          action.remote?.id
        );
        this.state.records[action.path] = {
          localHash: action.local.hash,
          remoteHash: uploaded.hash,
          remoteFileId: uploaded.id
        };
        applied += 1;
      } else if (action.kind === "download" && action.remote) {
        await this.assertRemoteActionUnchanged(action);
        await this.assertLocalUnchanged(action.local, action.path);
        const bytes = await this.drive.downloadVerified(action.remote);
        await this.writeLocal(action.path, bytes);
        this.state.records[action.path] = {
          localHash: action.remote.hash,
          remoteHash: action.remote.hash,
          remoteFileId: action.remote.id
        };
        applied += 1;
      } else if (action.kind === "conflict" && action.local && action.remote) {
        await this.assertRemoteActionUnchanged(action);
        await this.assertLocalUnchanged(action.local, action.path);
        const bytes = await this.drive.downloadVerified(action.remote);
        const conflict = await this.uniqueConflictPath(action.path);
        await this.writeLocal(conflict, bytes);
        this.state.records[action.path] = {
          localHash: action.local.hash,
          remoteHash: action.remote.hash,
          remoteFileId: action.remote.id,
          lastConflictPair: `${action.local.hash}:${action.remote.hash}`
        };
        applied += 1;
      } else if (action.kind === "noop" && action.local && action.remote && action.local.hash === action.remote.hash) {
        this.state.records[action.path] = {
          localHash: action.local.hash,
          remoteHash: action.remote.hash,
          remoteFileId: action.remote.id
        };
      }
      await this.persist();
    }
    this.state.lastSyncAt = new Date().toISOString();
    await this.persist();
    return { plan, applied };
  }

  private applyRemotePolicy(files: RemoteFileInfo[]): RemoteFileInfo[] {
    return files.map((file) => ({
      ...file,
      excluded: isPathExcluded(
        file.path,
        this.settings.includeObsidianConfig,
        this.settings.excludePatterns,
        this.app.vault.configDir
      )
    }));
  }

  private async scanLocalFiles(): Promise<LocalFileInfo[]> {
    const paths = await this.walk("");
    const included = paths.filter((path) => !isPathExcluded(
      path,
      this.settings.includeObsidianConfig,
      this.settings.excludePatterns,
      this.app.vault.configDir
    ));
    assertNoPathCollisions(included);
    const results: LocalFileInfo[] = [];
    for (const path of included) {
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat || stat.type !== "file") continue;
      assertAllowedSize(stat.size, path);
      const bytes = await this.app.vault.adapter.readBinary(path);
      assertAllowedSize(bytes.byteLength, path);
      results.push({ path, hash: await sha256Hex(bytes), size: bytes.byteLength, mimeType: mimeTypeForPath(path) });
    }
    return results;
  }

  private async walk(folder: string): Promise<string[]> {
    const listing = await this.app.vault.adapter.list(folder);
    const files = [...listing.files].map(normalizePath);
    for (const child of listing.folders) {
      const normalized = normalizePath(child);
      if (!shouldTraverseFolder(
        normalized,
        this.settings.includeObsidianConfig,
        this.settings.excludePatterns,
        this.app.vault.configDir
      )) continue;
      files.push(...(await this.walk(normalized)));
    }
    return files;
  }

  private async readLocalVerified(expected: LocalFileInfo): Promise<ArrayBuffer> {
    if (!(await this.app.vault.adapter.exists(expected.path))) {
      throw new Error(`${expected.path}: プレビュー後にローカルファイルが削除されました`);
    }
    const stat = await this.app.vault.adapter.stat(expected.path);
    if (!stat || stat.type !== "file") throw new Error(`${expected.path}: ローカルファイルを確認できません`);
    assertAllowedSize(stat.size, expected.path);
    const bytes = await this.app.vault.adapter.readBinary(expected.path);
    assertAllowedSize(bytes.byteLength, expected.path);
    if (await sha256Hex(bytes) !== expected.hash) {
      throw new Error(`${expected.path}: プレビュー後にローカル内容が変わりました。再プレビューしてください`);
    }
    return bytes;
  }

  private async assertLocalUnchanged(expected: LocalFileInfo | undefined, path: string): Promise<void> {
    const exists = await this.app.vault.adapter.exists(path);
    if (!expected) {
      if (exists) throw new Error(`${path}: プレビュー後にローカルファイルが作成されました`);
      return;
    }
    await this.readLocalVerified(expected);
  }

  private async assertRemotePlanUnchanged(plan: SyncAction[]): Promise<void> {
    const current = await this.drive.listVaultFiles();
    const planned = plan.filter((action) => action.remote).map((action) => action.remote as RemoteFileInfo);
    if (current.length !== planned.length) throw new Error("プレビュー後にDriveのファイル一覧が変わりました。再プレビューしてください");
    const currentByPath = new Map(current.map((file) => [file.path, file]));
    for (const expected of planned) assertRemoteMatches(expected, currentByPath.get(expected.path));
  }

  private async assertRemoteActionUnchanged(action: SyncAction): Promise<void> {
    const current = await this.drive.listVaultFiles();
    const found = current.find((file) => file.path === action.path);
    if (!action.remote) {
      if (found) throw new Error(`${action.path}: プレビュー後にDriveファイルが作成されました`);
      return;
    }
    assertRemoteMatches(action.remote, found);
  }

  private async writeLocal(path: string, bytes: ArrayBuffer): Promise<void> {
    if (!isSafeVaultPath(path)) throw new Error(`${path}: 書き込み先パスが安全ではありません`);
    assertAllowedSize(bytes.byteLength, path);
    await ensureParentFolders(this.app, path);
    await this.app.vault.adapter.writeBinary(normalizePath(path), bytes);
  }

  private async uniqueConflictPath(path: string): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const marker = new Date().toISOString().replace(/[-:.]/g, "");
      const suffix = crypto.randomUUID().slice(0, 8);
      const candidate = conflictPath(path, `${marker}-${suffix}`);
      if (!(await this.app.vault.adapter.exists(candidate))) return candidate;
    }
    throw new Error(`${path}: 一意な競合コピー名を作成できません`);
  }
}

function assertRemoteMatches(expected: RemoteFileInfo, current: RemoteFileInfo | undefined): void {
  if (!current ||
      current.id !== expected.id ||
      current.hash !== expected.hash ||
      current.modifiedTime !== expected.modifiedTime ||
      current.encrypted !== expected.encrypted ||
      current.cipherHash !== expected.cipherHash ||
      current.iv !== expected.iv) {
    throw new Error(`${expected.path}: プレビュー後にDrive内容が変わりました。再プレビューしてください`);
  }
}

function assertAllowedSize(size: number, path: string): void {
  if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`${path}: 100 MiBを超えるファイルは安全のため同期できません`);
  }
}

async function ensureParentFolders(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) await app.vault.adapter.mkdir(current);
  }
}

function conflictPath(path: string, marker: string): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${directory}${name}.conflict-${marker}`;
  return `${directory}${name.slice(0, dot)}.conflict-${marker}${name.slice(dot)}`;
}
