export const CLIENT_SECRET_ID = "google-drive-vault-sync-client-secret";
export const REFRESH_TOKEN_ID = "google-drive-vault-sync-refresh-token";
export const VAULT_KEY_ID = "google-drive-vault-sync-vault-key";
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

export interface PluginSettings {
  clientId: string;
  clientSecretId: string;
  refreshTokenId: string;
  vaultKeyId: string;
  vaultId: string;
  remoteFolderName: string;
  includeObsidianConfig: boolean;
  excludePatterns: string[];
  syncOnStartup: boolean;
}

export interface LegacyPluginSettings extends Partial<PluginSettings> {
  clientSecret?: string;
  refreshToken?: string;
  dryRunByDefault?: boolean;
}

export interface SyncRecord {
  localHash: string;
  remoteHash: string;
  remoteFileId: string;
  deletedAt?: string;
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
  encrypted: boolean;
  cipherHash?: string;
  iv?: string;
  deletedAt?: string;
  excluded?: boolean;
}

export type SyncActionKind = "migrate" | "upload" | "download" | "mark-delete" | "delete-local" | "conflict" | "noop" | "skip";

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
  consumedPairingIds: string[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  clientId: "",
  clientSecretId: CLIENT_SECRET_ID,
  refreshTokenId: REFRESH_TOKEN_ID,
  vaultKeyId: VAULT_KEY_ID,
  vaultId: crypto.randomUUID(),
  remoteFolderName: "Obsidian Vault Sync",
  includeObsidianConfig: false,
  excludePatterns: [".trash/**", ".git/**", ".DS_Store"],
  syncOnStartup: false
};

export const DEFAULT_SYNC_STATE: SyncStateData = {
  records: {},
  lastSyncAt: null
};
