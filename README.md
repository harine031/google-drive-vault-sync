# Google Drive Vault Sync

WindowsとiPhoneのObsidian VaultをGoogle Drive経由で同期する、安全性優先のコミュニティプラグインです。

## 現在の段階

`0.1.1` はWindows・iPhone向けMVPです。

- Google公式OAuthエンドポイントへ直接接続（PKCE＋loopback）
- `drive.file` スコープのみ使用
- Markdown、画像、PDFなどのバイナリファイルに対応
- `.obsidian` を含められる
- 端末固有ファイルと本プラグイン自身のデータは除外
- 同期プレビュー
- 双方向の新規・更新同期
- 両側変更時は競合コピーを作成
- 削除は検出のみで、自動反映しない
- AES-GCM暗号化ペアリングコードでWindowsの認証をiPhoneへ一度だけ移行

iPhoneではアプリ終了中のバックグラウンド同期は行えません。起動中に手動同期を実行します。

## 開発

```powershell
npm install
npm test
npm run build
npm run deploy:test -- -VaultPath "C:\path\to\test-vault"
```

`deploy:test` は指定したテストVaultだけへビルド成果物を配置します。本番Vaultを指定しないでください。

## BRATでベータ版を導入

このプラグインは現在ベータ版です。専用のテストVaultだけで使用してください。

1. Obsidianのコミュニティプラグインから「BRAT」をインストールして有効化する。
2. コマンドパレットで「BRAT: Add a beta plugin for testing」を実行する。
3. リポジトリとして `harine031/google-drive-vault-sync` を入力する。
4. インストール後、コミュニティプラグイン一覧で「Google Drive Vault Sync」を有効化する。

配布ファイルはGitHub Releaseの `main.js`、`manifest.json`、`styles.css` です。

## Google Cloud設定（個人MVP）

1. Google CloudプロジェクトでGoogle Drive APIを有効化する。
2. OAuth同意画面を設定する。
3. OAuthクライアントを「デスクトップアプリ」として作成する。
4. クライアントIDとクライアントシークレットをプラグイン設定へ入力する。
5. 「Googleに接続」を実行する。
6. Windowsの設定画面で暗号化ペアリングコードを作成し、iPhone側の同プラグインで読み込む。

クライアントシークレットとトークンはObsidianのプラグインデータへ端末ローカル保存されるため、そのフォルダーを共有・公開しないでください。
ペアリングコードとパスフレーズは同じメッセージや同じクラウドファイルで送らないでください。

## 重要な制限

- 本番Vaultではまだ使用しないでください。
- 削除同期は未実装です。
- iPhoneではBRATを使ってベータ版を導入します。一般公開後はコミュニティプラグインから導入できる予定です。
- 同期中にObsidianを終了しないでください。
