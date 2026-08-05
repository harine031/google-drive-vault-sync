import { Modal, Notice, Plugin } from "obsidian";
import { GoogleAuth } from "./auth";
import { randomBase64Url } from "./crypto-utils";
import { GoogleDriveClient } from "./drive-client";
import type { PairingPayload } from "./pairing";
import { GoogleDriveVaultSyncSettingTab } from "./secure-settings";
import { SyncEngine } from "./secure-sync-engine";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SYNC_STATE,
  type LegacyPluginSettings,
  type PersistedPluginData,
  type PluginSettings,
  type SyncAction,
  type SyncStateData
} from "./types";

export default class GoogleDriveVaultSyncPlugin extends Plugin {
  settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  private syncState: SyncStateData = structuredClone(DEFAULT_SYNC_STATE);
  private consumedPairingIds: string[] = [];
  private auth!: GoogleAuth;
  private drive!: GoogleDriveClient;
  private syncEngine!: SyncEngine;
  private running = false;

  async onload(): Promise<void> {
    const migrated = await this.loadPluginData();
    this.ensureVaultKey();
    this.auth = new GoogleAuth(
      () => this.settings.clientId,
      () => this.getClientSecret(),
      () => this.getRefreshToken(),
      async (token) => this.setRefreshToken(token)
    );
    this.drive = new GoogleDriveClient(
      () => this.auth.getValidAccessToken(),
      () => this.settings.vaultId,
      () => this.settings.remoteFolderName,
      () => this.getVaultKey()
    );
    this.syncEngine = new SyncEngine(this.app, this.settings, this.syncState, this.drive, () => this.persistData());
    if (migrated) await this.persistData();

    this.addSettingTab(new GoogleDriveVaultSyncSettingTab(this.app, this));
    this.addRibbonIcon("cloud", "Google Drive Vault Sync", () => void this.previewSync());
    this.addCommand({
      id: "preview-google-drive-sync",
      name: "同期内容をプレビュー",
      callback: () => void this.previewSync()
    });
    this.addCommand({
      id: "run-google-drive-sync",
      name: "同期内容を確認して実行",
      callback: () => void this.previewSync()
    });

    if (this.settings.syncOnStartup) this.app.workspace.onLayoutReady(() => void this.previewSync());
  }

  async persistData(): Promise<void> {
    const data: PersistedPluginData = {
      settings: this.settings,
      syncState: this.syncState,
      consumedPairingIds: this.consumedPairingIds
    };
    await this.saveData(data);
  }

  getClientSecret(): string {
    return this.app.secretStorage.getSecret(this.settings.clientSecretId) ?? "";
  }

  getRefreshToken(): string {
    return this.app.secretStorage.getSecret(this.settings.refreshTokenId) ?? "";
  }

  getVaultKey(): string {
    return this.app.secretStorage.getSecret(this.settings.vaultKeyId) ?? "";
  }

  hasRefreshToken(): boolean {
    return Boolean(this.getRefreshToken());
  }

  async connectGoogleDesktop(): Promise<void> {
    await this.auth.connectDesktop();
  }

  async testConnection(): Promise<boolean> {
    return this.drive.testConnection();
  }

  async disconnectGoogle(): Promise<void> {
    await this.auth.revokeAndDisconnect();
  }

  pairingPayload(): Omit<PairingPayload, "version" | "pairingId" | "issuedAt" | "expiresAt"> {
    return {
      clientId: this.settings.clientId,
      clientSecret: this.getClientSecret(),
      refreshToken: this.getRefreshToken(),
      vaultId: this.settings.vaultId,
      vaultKey: this.getVaultKey()
    };
  }

  async applyPairingPayload(payload: PairingPayload): Promise<void> {
    if (this.consumedPairingIds.includes(payload.pairingId)) {
      throw new Error("このペアリングコードはこの端末ですでに使用されています");
    }
    this.consumedPairingIds.push(payload.pairingId);
    this.consumedPairingIds = this.consumedPairingIds.slice(-32);
    this.settings.clientId = payload.clientId;
    this.app.secretStorage.setSecret(this.settings.clientSecretId, payload.clientSecret);
    this.app.secretStorage.setSecret(this.settings.refreshTokenId, payload.refreshToken);
    this.app.secretStorage.setSecret(this.settings.vaultKeyId, payload.vaultKey);
    this.settings.vaultId = payload.vaultId;
    this.auth.disconnect();
    await this.persistData();
  }

  private async setRefreshToken(token: string): Promise<void> {
    this.app.secretStorage.setSecret(this.settings.refreshTokenId, token);
  }

  private ensureVaultKey(): void {
    if (!this.getVaultKey()) this.app.secretStorage.setSecret(this.settings.vaultKeyId, randomBase64Url(32));
  }

  private async previewSync(): Promise<void> {
    await this.withRunLock(async () => {
      const plan = await this.syncEngine.preview();
      new SyncPreviewModal(this, plan).open();
    });
  }

  async applySyncPlan(plan: SyncAction[]): Promise<void> {
    await this.withRunLock(async () => {
      const result = await this.syncEngine.apply(plan);
      new Notice(`Google Drive暗号化同期完了: ${result.applied}件を反映しました`, 8000);
    });
  }

  private async withRunLock(operation: () => Promise<void>): Promise<void> {
    if (this.running) {
      new Notice("Google Drive同期はすでに実行中です");
      return;
    }
    this.running = true;
    try {
      await operation();
    } catch (error) {
      console.error("Google Drive Vault Sync failed", error instanceof Error ? error.message : "Unknown error");
      new Notice(error instanceof Error ? error.message : String(error), 12000);
    } finally {
      this.running = false;
    }
  }

  private async loadPluginData(): Promise<boolean> {
    const data = (await this.loadData()) as {
      settings?: LegacyPluginSettings;
      syncState?: SyncStateData;
      consumedPairingIds?: string[];
    } | null;
    const raw = data?.settings ?? {};
    const { clientSecret, refreshToken, dryRunByDefault: _legacyDryRun, ...safeSettings } = raw;
    this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), safeSettings);
    this.syncState = Object.assign(structuredClone(DEFAULT_SYNC_STATE), data?.syncState ?? {});
    this.syncState.records = data?.syncState?.records ?? {};
    this.consumedPairingIds = (data?.consumedPairingIds ?? []).filter((id) => /^[A-Za-z0-9_-]{22}$/.test(id)).slice(-32);
    let migrated = false;
    if (clientSecret && !this.getClientSecret()) {
      this.app.secretStorage.setSecret(this.settings.clientSecretId, clientSecret);
      migrated = true;
    }
    if (refreshToken && !this.getRefreshToken()) {
      this.app.secretStorage.setSecret(this.settings.refreshTokenId, refreshToken);
      migrated = true;
    }
    return migrated || clientSecret !== undefined || refreshToken !== undefined || _legacyDryRun !== undefined;
  }
}

class SyncPreviewModal extends Modal {
  constructor(private readonly plugin: GoogleDriveVaultSyncPlugin, private readonly plan: SyncAction[]) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Google Drive 暗号化同期プレビュー");
    const counts = new Map<string, number>();
    for (const action of this.plan) counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
    this.contentEl.createEl("p", {
      text: `アップロード ${counts.get("upload") ?? 0} / ダウンロード ${counts.get("download") ?? 0} / 競合 ${counts.get("conflict") ?? 0} / 保留 ${counts.get("skip") ?? 0}`
    });
    const details = this.contentEl.createEl("div", { cls: "google-drive-vault-sync-summary" });
    details.setText(this.plan
      .filter((action) => action.kind !== "noop")
      .map((action) => `[${action.kind}] ${action.path} — ${action.reason}`)
      .join("\n") || "変更はありません");
    this.contentEl.createEl("p", { text: "実行直前にローカルとDriveのhashを再確認し、変更があれば中止します。" });

    const buttonRow = this.contentEl.createDiv({ cls: "modal-button-container" });
    const closeButton = buttonRow.createEl("button", { text: "閉じる" });
    closeButton.addEventListener("click", () => this.close());
    const actionable = this.plan.some((action) => ["upload", "download", "conflict"].includes(action.kind));
    const syncButton = buttonRow.createEl("button", { text: "確認した内容を同期", cls: "mod-cta" });
    syncButton.disabled = !actionable;
    syncButton.addEventListener("click", () => {
      this.close();
      void this.plugin.applySyncPlan(this.plan);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
