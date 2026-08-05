import { Modal, Notice, Plugin } from "obsidian";
import { GoogleAuth } from "./auth";
import { GoogleDriveClient } from "./google-drive-client";
import { GoogleDriveVaultSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync-engine";
import {
  DEFAULT_SETTINGS,
  DEFAULT_SYNC_STATE,
  type PersistedPluginData,
  type PluginSettings,
  type SyncAction,
  type SyncStateData
} from "./types";

export default class GoogleDriveVaultSyncPlugin extends Plugin {
  settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  private syncState: SyncStateData = structuredClone(DEFAULT_SYNC_STATE);
  private auth!: GoogleAuth;
  private drive!: GoogleDriveClient;
  private syncEngine!: SyncEngine;
  private running = false;

  async onload(): Promise<void> {
    await this.loadPluginData();
    this.auth = new GoogleAuth(
      () => this.settings.clientId,
      () => this.settings.clientSecret,
      () => this.settings.refreshToken,
      async (token) => {
        this.settings.refreshToken = token;
        await this.persistData();
      }
    );
    this.drive = new GoogleDriveClient(
      () => this.auth.getValidAccessToken(),
      () => this.settings.vaultId,
      () => this.settings.remoteFolderName
    );
    this.syncEngine = new SyncEngine(
      this.app,
      this.settings,
      this.syncState,
      this.drive,
      () => this.persistData()
    );

    this.addSettingTab(new GoogleDriveVaultSyncSettingTab(this.app, this));
    this.addRibbonIcon("cloud", "Google Drive Vault Sync", () => void this.previewSync());
    this.addCommand({
      id: "preview-google-drive-sync",
      name: "同期内容をプレビュー",
      callback: () => void this.previewSync()
    });
    this.addCommand({
      id: "run-google-drive-sync",
      name: "今すぐ双方向同期",
      callback: () => void this.runSync(false)
    });

    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => void this.runSync(this.settings.dryRunByDefault));
    }
  }

  async persistData(): Promise<void> {
    const data: PersistedPluginData = { settings: this.settings, syncState: this.syncState };
    await this.saveData(data);
  }

  async connectGoogleDesktop(): Promise<void> {
    await this.auth.connectDesktop();
  }

  async testConnection(): Promise<boolean> {
    return this.drive.testConnection();
  }

  private async previewSync(): Promise<void> {
    await this.withRunLock(async () => {
      const plan = await this.syncEngine.preview();
      new SyncPreviewModal(this, plan).open();
    });
  }

  async runSync(dryRun: boolean): Promise<void> {
    await this.withRunLock(async () => {
      const result = await this.syncEngine.sync(dryRun);
      if (dryRun) {
        new SyncPreviewModal(this, result.plan).open();
      } else {
        new Notice(`Google Drive同期完了: ${result.applied}件を反映しました`, 8000);
      }
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
      new Notice(error instanceof Error ? error.message : String(error), 10000);
    } finally {
      this.running = false;
    }
  }

  private async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as Partial<PersistedPluginData> | null;
    this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), data?.settings ?? {});
    this.syncState = Object.assign(structuredClone(DEFAULT_SYNC_STATE), data?.syncState ?? {});
    this.syncState.records = data?.syncState?.records ?? {};
  }
}

class SyncPreviewModal extends Modal {
  constructor(private readonly plugin: GoogleDriveVaultSyncPlugin, private readonly plan: SyncAction[]) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Google Drive 同期プレビュー");
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

    const buttonRow = this.contentEl.createDiv({ cls: "modal-button-container" });
    const closeButton = buttonRow.createEl("button", { text: "閉じる" });
    closeButton.addEventListener("click", () => this.close());
    const unsafe = this.plan.some((action) => action.kind === "conflict" || action.kind === "skip");
    const syncButton = buttonRow.createEl("button", { text: unsafe ? "安全な項目だけ同期" : "同期を実行" });
    syncButton.addClass("mod-cta");
    syncButton.addEventListener("click", () => {
      this.close();
      void this.plugin.runSync(false);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
