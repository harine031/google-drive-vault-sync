import { App, normalizePath } from "obsidian";
import { isPathExcluded, mimeTypeForPath, shouldTraverseFolder } from "./path-policy";
import { buildSyncPlan } from "./sync-plan";
import type {
  LocalFileInfo,
  PluginSettings,
  SyncAction,
  SyncStateData
} from "./types";
import { GoogleDriveClient } from "./google-drive-client";

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
    const [local, remote] = await Promise.all([this.scanLocalFiles(), this.drive.listVaultFiles()]);
    return buildSyncPlan(local, remote, this.state);
  }

  async sync(dryRun: boolean): Promise<SyncResult> {
    const plan = await this.preview();
    if (dryRun) return { plan, applied: 0 };
    let applied = 0;
    for (const action of plan) {
      if (action.kind === "upload" && action.local) {
        const bytes = await this.app.vault.adapter.readBinary(action.path);
        const uploaded = await this.drive.upload(
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
        const bytes = await this.drive.download(action.remote.id);
        await this.writeLocal(action.path, bytes);
        this.state.records[action.path] = {
          localHash: action.remote.hash,
          remoteHash: action.remote.hash,
          remoteFileId: action.remote.id
        };
        applied += 1;
      } else if (action.kind === "conflict" && action.local && action.remote) {
        const bytes = await this.drive.download(action.remote.id);
        await this.writeLocal(conflictPath(action.path), bytes);
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

  private async scanLocalFiles(): Promise<LocalFileInfo[]> {
    const paths = await this.walk("");
    const results: LocalFileInfo[] = [];
    for (const path of paths) {
      if (isPathExcluded(path, this.settings.includeObsidianConfig, this.settings.excludePatterns)) continue;
      const bytes = await this.app.vault.adapter.readBinary(path);
      results.push({
        path,
        hash: await sha256(bytes),
        size: bytes.byteLength,
        mimeType: mimeTypeForPath(path)
      });
    }
    return results;
  }

  private async walk(folder: string): Promise<string[]> {
    const listing = await this.app.vault.adapter.list(folder);
    const files = [...listing.files].map(normalizePath);
    for (const child of listing.folders) {
      const normalized = normalizePath(child);
      if (!shouldTraverseFolder(normalized, this.settings.includeObsidianConfig, this.settings.excludePatterns)) continue;
      files.push(...(await this.walk(normalized)));
    }
    return files;
  }

  private async writeLocal(path: string, bytes: ArrayBuffer): Promise<void> {
    await ensureParentFolders(this.app, path);
    await this.app.vault.adapter.writeBinary(normalizePath(path), bytes);
  }
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function conflictPath(path: string): string {
  const marker = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${directory}${name}.conflict-${marker}`;
  return `${directory}${name.slice(0, dot)}.conflict-${marker}${name.slice(dot)}`;
}
