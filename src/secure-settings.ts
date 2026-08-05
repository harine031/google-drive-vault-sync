import { App, Modal, Notice, Platform, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type GoogleDriveVaultSyncPlugin from "./plugin-main";
import { createPairingCode, readPairingCode } from "./pairing";

export class GoogleDriveVaultSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GoogleDriveVaultSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Google Drive Vault Sync" });
    containerEl.createEl("p", {
      text: "OAuth秘密値とVault暗号鍵はObsidian SecretStorageへ保存し、同期ファイルやdata.jsonへ含めません。"
    }).addClass("google-drive-vault-sync-warning");

    new Setting(containerEl)
      .setName("Google OAuthクライアントID")
      .setDesc("Google Cloudで作成したデスクトップアプリ用クライアントID")
      .addText((text) => text
        .setPlaceholder("xxxxxxxx.apps.googleusercontent.com")
        .setValue(this.plugin.settings.clientId)
        .onChange(async (value) => {
          this.plugin.settings.clientId = value.trim();
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("Google OAuthクライアントシークレット")
      .setDesc("Obsidian SecretStorage内の秘密を選択または作成します")
      .addComponent((element) => new SecretComponent(this.app, element)
        .setValue(this.plugin.settings.clientSecretId)
        .onChange(async (value) => {
          this.plugin.settings.clientSecretId = value;
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("Google認証")
      .setDesc(Platform.isDesktopApp
        ? "外部ブラウザー、PKCE、loopbackでGoogleへ直接認証します"
        : "iPhoneではWindowsで作成した期限付き暗号化コードを読み込んでください")
      .addButton((button) => button
        .setButtonText("Googleに接続")
        .setCta()
        .setDisabled(!Platform.isDesktopApp)
        .onClick(async () => {
          try {
            await this.plugin.connectGoogleDesktop();
            new Notice("Google Driveへの認証が完了しました");
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 10000);
          }
        }))
      .addButton((button) => button
        .setButtonText("接続解除・権限取消")
        .setWarning()
        .setDisabled(!this.plugin.hasRefreshToken())
        .onClick(() => new DisconnectModal(this.app, this.plugin, () => this.display()).open()));

    new Setting(containerEl)
      .setName("認証トークン")
      .setDesc(this.plugin.hasRefreshToken() ? "SecretStorageに設定済み" : "未設定");

    new Setting(containerEl)
      .setName("Windows・iPhone ペアリング")
      .setDesc("GDVS2コードは16文字以上のパスフレーズで暗号化され、10分で期限切れになります")
      .addButton((button) => button
        .setButtonText("コードを作成")
        .setDisabled(!Platform.isDesktopApp || !this.plugin.hasRefreshToken() || !this.plugin.getClientSecret())
        .onClick(() => new ExportPairingModal(this.app, this.plugin).open()))
      .addButton((button) => button
        .setButtonText("コードを読み込む")
        .onClick(() => new ImportPairingModal(this.app, this.plugin, () => this.display()).open()));

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc(this.plugin.settings.vaultId)
      .addButton((button) => button.setButtonText("コピー").onClick(async () => {
        await navigator.clipboard.writeText(this.plugin.settings.vaultId);
        new Notice("Vault IDをコピーしました");
      }));

    new Setting(containerEl)
      .setName("Driveフォルダー名")
      .setDesc("Google Driveに作成する専用フォルダーの表示名")
      .addText((text) => text
        .setValue(this.plugin.settings.remoteFolderName)
        .onChange(async (value) => {
          this.plugin.settings.remoteFolderName = value.trim() || "Obsidian Vault Sync";
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("安全なObsidianコア設定を同期")
      .setDesc("既定オフ。他プラグイン、テーマ、CSS、data.json、実行コードは常に除外します")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.includeObsidianConfig)
        .onChange(async (value) => {
          this.plugin.settings.includeObsidianConfig = value;
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("起動時にプレビュー")
      .setDesc("自動変更は行わず、確認画面だけを開きます")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("除外パターン")
      .setDesc("追加除外を1行に1つ。100 MiB超のファイルは常に拒否します")
      .addTextArea((area) => area
        .setValue(this.plugin.settings.excludePatterns.join("\n"))
        .onChange(async (value) => {
          this.plugin.settings.excludePatterns = value.split("\n").map((line) => line.trim()).filter(Boolean);
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("接続テスト")
      .setDesc("SecretStorageのtokenを使ってGoogle Drive APIへ接続します")
      .addButton((button) => button.setButtonText("テスト").onClick(async () => {
        try {
          const ok = await this.plugin.testConnection();
          new Notice(ok ? "Google Driveへ接続できました" : "接続できませんでした");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 10000);
        }
      }));

    new Setting(containerEl)
      .setName("Google DriveからこのVaultへ復元")
      .setDesc("初回用。Driveだけにある暗号化ファイルをダウンロードし、ローカルの異なるファイルは上書きしません")
      .addButton((button) => button
        .setButtonText("復元内容をプレビュー")
        .setCta()
        .setDisabled(!this.plugin.hasRefreshToken())
        .onClick(() => void this.plugin.previewRestore()));
  }
}

class ExportPairingModal extends Modal {
  constructor(app: App, private readonly plugin: GoogleDriveVaultSyncPlugin) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("iPhone用GDVS2ペアリングコードを作成");
    this.contentEl.createEl("p", { text: "16文字以上の強いパスフレーズで暗号化します。コードは10分で期限切れになります。" });
    const password = this.contentEl.createEl("input", { type: "password", placeholder: "16文字以上のパスフレーズ" });
    password.style.width = "100%";
    password.style.marginBottom = "12px";
    password.setAttribute("autocomplete", "new-password");
    const output = this.contentEl.createEl("textarea", { placeholder: "ここにGDVS2暗号化コードが表示されます" });
    output.readOnly = true;
    output.rows = 6;
    output.style.width = "100%";
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const generate = buttons.createEl("button", { text: "作成してコピー", cls: "mod-cta" });
    const clear = buttons.createEl("button", { text: "コードとクリップボードを消去" });
    window.setTimeout(() => password.focus(), 0);
    generate.addEventListener("click", () => {
      void (async () => {
        try {
          const code = await createPairingCode(this.plugin.pairingPayload(), password.value);
          password.value = "";
          output.value = code;
          await navigator.clipboard.writeText(code);
          new Notice("10分間有効なGDVS2コードをコピーしました");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 8000);
        }
      })();
    });
    clear.addEventListener("click", () => {
      void clearClipboard();
      output.value = "";
      password.value = "";
      new Notice("ペアリングコードを消去しました");
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ImportPairingModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: GoogleDriveVaultSyncPlugin,
    private readonly onImported: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("GDVS2ペアリングコードを読み込む");
    const code = this.contentEl.createEl("textarea", { placeholder: "GDVS2. で始まる10分以内のコード" });
    code.rows = 6;
    code.style.width = "100%";
    const password = this.contentEl.createEl("input", { type: "password", placeholder: "16文字以上のパスフレーズ" });
    password.style.width = "100%";
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const apply = buttons.createEl("button", { text: "この端末へ安全に設定", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      void (async () => {
        try {
          const payload = await readPairingCode(code.value, password.value);
          await this.plugin.applyPairingPayload(payload);
          code.value = "";
          password.value = "";
          await clearClipboard();
          this.close();
          this.onImported();
          new Notice("この端末を暗号化Vaultへペアリングしました");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 8000);
        }
      })();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DisconnectModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: GoogleDriveVaultSyncPlugin,
    private readonly onDisconnected: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Google Drive接続を解除");
    this.contentEl.createEl("p", { text: "Google側のOAuth権限を取り消し、このVaultのrefresh tokenをSecretStorageから消去します。" });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: "キャンセル" });
    cancel.addEventListener("click", () => this.close());
    const revoke = buttons.createEl("button", { text: "権限を取り消す", cls: "mod-warning" });
    revoke.addEventListener("click", () => {
      void (async () => {
        try {
          await this.plugin.disconnectGoogle();
          this.close();
          this.onDisconnected();
          new Notice("Google Drive接続を解除しました");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 10000);
        }
      })();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

async function clearClipboard(): Promise<void> {
  try {
    await navigator.clipboard.writeText("");
  } catch {
    // Clipboard clearing can be denied by the OS; the UI already clears its own fields.
  }
}
