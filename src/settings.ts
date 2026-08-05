import { App, Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type GoogleDriveVaultSyncPlugin from "./main";
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
      text: "OAuthトークンと同期状態はこの端末だけに保存され、Google Driveへ同期されません。"
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
      .setDesc("Google CloudのデスクトップOAuthクライアントに表示される値。端末ローカルだけに保存します")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(this.plugin.settings.clientSecret ? "設定済み" : "未設定")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.persistData();
          });
      });

    new Setting(containerEl)
      .setName("Google認証")
      .setDesc(Platform.isDesktopApp
        ? "外部ブラウザーを使い、Googleと直接OAuth認証します"
        : "iPhoneではWindowsで作成した暗号化ペアリングコードを読み込んでください")
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
        }));

    new Setting(containerEl)
      .setName("リフレッシュトークン")
      .setDesc("端末ローカル保存。通常はWindowsのGoogle認証で自動設定されます")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(this.plugin.settings.refreshToken ? "設定済み" : "未設定")
          .setValue(this.plugin.settings.refreshToken)
          .onChange(async (value) => {
            this.plugin.settings.refreshToken = value.trim();
            await this.plugin.persistData();
          });
      });

    new Setting(containerEl)
      .setName("Windows・iPhone ペアリング")
      .setDesc("Google認証情報とVault IDを、パスフレーズで暗号化した一回限りのコードとして移行します")
      .addButton((button) => button
        .setButtonText("コードを作成")
        .setDisabled(!Platform.isDesktopApp || !this.plugin.settings.refreshToken || !this.plugin.settings.clientSecret)
        .onClick(() => new ExportPairingModal(this.app, this.plugin).open()))
      .addButton((button) => button
        .setButtonText("コードを読み込む")
        .onClick(() => new ImportPairingModal(this.app, this.plugin, () => this.display()).open()));

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("WindowsとiPhoneで同じ値を使用します。秘密情報ではありません")
      .addText((text) => text
        .setValue(this.plugin.settings.vaultId)
        .onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim();
          await this.plugin.persistData();
        }))
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
      .setName(".obsidianを同期")
      .setDesc("他プラグインや通常設定を含めます。端末固有ファイルと本プラグイン自身は除外されます")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.includeObsidianConfig)
        .onChange(async (value) => {
          this.plugin.settings.includeObsidianConfig = value;
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("同期前にプレビュー")
      .setDesc("既定では実際に変更せず、予定だけ表示します")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.dryRunByDefault)
        .onChange(async (value) => {
          this.plugin.settings.dryRunByDefault = value;
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("起動時に同期")
      .setDesc("初期版では無効を推奨します")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.syncOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("除外パターン")
      .setDesc("1行に1つ。* と ** を使用できます")
      .addTextArea((area) => area
        .setValue(this.plugin.settings.excludePatterns.join("\n"))
        .onChange(async (value) => {
          this.plugin.settings.excludePatterns = value.split("\n").map((line) => line.trim()).filter(Boolean);
          await this.plugin.persistData();
        }));

    new Setting(containerEl)
      .setName("接続テスト")
      .setDesc("トークンを使ってGoogle Drive APIへ接続します")
      .addButton((button) => button.setButtonText("テスト").onClick(async () => {
        try {
          const ok = await this.plugin.testConnection();
          new Notice(ok ? "Google Driveへ接続できました" : "接続できませんでした");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 10000);
        }
      }));
  }
}

class ExportPairingModal extends Modal {
  constructor(app: App, private readonly plugin: GoogleDriveVaultSyncPlugin) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("iPhone用ペアリングコードを作成");
    this.contentEl.createEl("p", {
      text: "12文字以上のパスフレーズで暗号化します。コードとパスフレーズは別々の経路でiPhoneへ渡してください。"
    });
    const password = this.contentEl.createEl("input", { type: "password", placeholder: "12文字以上のパスフレーズ" });
    password.style.width = "100%";
    password.style.marginBottom = "12px";
    password.setAttribute("autocomplete", "new-password");
    const output = this.contentEl.createEl("textarea", { placeholder: "ここに暗号化コードが表示されます" });
    output.readOnly = true;
    output.rows = 6;
    output.style.width = "100%";
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const generate = buttons.createEl("button", { text: "作成してコピー", cls: "mod-cta" });
    window.setTimeout(() => password.focus(), 0);
    generate.addEventListener("click", () => {
      void (async () => {
        try {
          const code = await createPairingCode({
            clientId: this.plugin.settings.clientId,
            clientSecret: this.plugin.settings.clientSecret,
            refreshToken: this.plugin.settings.refreshToken,
            vaultId: this.plugin.settings.vaultId
          }, password.value);
          output.value = code;
          await navigator.clipboard.writeText(code);
          new Notice("暗号化ペアリングコードをコピーしました");
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

class ImportPairingModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: GoogleDriveVaultSyncPlugin,
    private readonly onImported: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("ペアリングコードを読み込む");
    const code = this.contentEl.createEl("textarea", { placeholder: "GDVS1. で始まるコード" });
    code.rows = 6;
    code.style.width = "100%";
    const password = this.contentEl.createEl("input", { type: "password", placeholder: "パスフレーズ" });
    password.style.width = "100%";
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const apply = buttons.createEl("button", { text: "この端末へ設定", cls: "mod-cta" });
    apply.addEventListener("click", () => {
      void (async () => {
        try {
          const payload = await readPairingCode(code.value, password.value);
          this.plugin.settings.clientId = payload.clientId;
          this.plugin.settings.clientSecret = payload.clientSecret;
          this.plugin.settings.refreshToken = payload.refreshToken;
          this.plugin.settings.vaultId = payload.vaultId;
          await this.plugin.persistData();
          code.value = "";
          password.value = "";
          this.close();
          this.onImported();
          new Notice("この端末をVaultへペアリングしました");
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
