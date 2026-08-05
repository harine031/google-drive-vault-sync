export interface PluginSettings {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  vaultId: string;
  remoteFolderName: string;
  includeObsidianConfig: boolean;
  excludePatterns: string[];
  dryRunByDefault: boolean;
  syncOnStartup: boolean;
}

export interface SyncRecord {
  localHash: string;
  remoteHash: string;
  remoteFileId: string;
  lastConflictPair?: string;
}

export interface SyncStateData {
  records: Record<string, SyncRecord>;
  lastSyncAt: string | null;
}

export interface LocalFileInfo {
  path: string;
  hash: string;
  size: number;
  mimeType: string;
}

export interface RemoteFileInfo {
  id: string;
  path: string;
  hash: string;
  size: number;
  mimeType: string;
  modifiedTime: string;
}

export type SyncActionKind = "upload" | "download" | "conflict" | "noop" | "skip";

export interface SyncAction {
  kind: SyncActionKind;
  path: string;
  reason: string;
  local?: LocalFileInfo;
  remote?: RemoteFileInfo;
}

export interface PersistedPluginData {
  settings: PluginSettings;
  syncState: SyncStateData;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  vaultId: crypto.randomUUID(),
  remoteFolderName: "Obsidian Vault Sync",
  includeObsidianConfig: true,
  excludePatterns: [
    ".trash/**",
    ".git/**",
    ".DS_Store",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache/**",
    ".obsidian/plugins/google-drive-vault-sync/**"
  ],
  dryRunByDefault: true,
  syncOnStartup: false
};

export const DEFAULT_SYNC_STATE: SyncStateData = {
  records: {},
  lastSyncAt: null
};
