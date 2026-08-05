# Google Drive Vault Sync

WindowsとiPhoneのObsidian VaultをGoogle Drive経由で同期する、安全性優先のコミュニティプラグインです。

## 現在の段階

`0.2.0` はWindows・iPhone向けセキュリティ強化ベータ版です。Obsidian `1.11.4` 以上が必要です。

- Google公式OAuthエンドポイントへ直接接続（PKCE＋loopback）
- `drive.file` スコープのみ使用
- ファイル本文を端末ごとのVault鍵でAES-256-GCM暗号化してからDriveへ保存
- OAuth秘密値・refresh token・Vault鍵をObsidian SecretStorageへ保存
- Markdown、画像、PDFなど100 MiB以下のバイナリファイルに対応
- `.obsidian` は既定で除外。明示的に有効化しても安全なコア設定だけを対象にする
- 同期プレビューで確定した計画だけを実行し、実行直前にローカル・Drive双方を再検証
- 双方向の新規・更新同期
- 両側変更時は競合コピーを作成
- 削除は検出のみで、自動反映しない
- 600,000回PBKDF2とAES-GCMによる10分期限のGDVS2ペアリングコード（同一端末での再利用も拒否）

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

クライアントシークレット、refresh token、Vault鍵はObsidian SecretStorageへ保存され、`data.json` や同期対象には含まれません。旧版の平文秘密値は初回起動時にSecretStorageへ移行し、`data.json` から削除します。

ペアリングコードとパスフレーズは別経路で渡し、10分以内にiPhoneで読み込んでください。使用後はコードとパスフレーズを両端末・クリップボード・メッセージ履歴から削除してください。

## 0.1.xからの安全な移行

1. Windows側を先に0.2.0へ更新し、Obsidianを再起動する。
2. Windowsで同期プレビューを開く。ローカルと一致する旧平文ファイルは「暗号化移行」として表示される。
3. 内容を確認して同期を実行し、Drive上のファイル本文を暗号化形式へ置き換える。
4. Windowsで新しいGDVS2コードを作成し、iPhone側へ読み込む。旧GDVS1コードは使用できない。
5. iPhoneでプレビューを確認してから同期する。

旧平文のDriveファイルがローカルと一致しない場合、プラグインは自動ダウンロードせず停止します。先にWindows側で内容を確認・復元してください。移行と再ペアリングが終わるまでiPhoneでは同期を実行しないでください。

## セキュリティ上の境界

- Drive上のファイル本文は暗号化されますが、専用フォルダー名、ファイル名、相対パス、サイズ、更新時刻などのメタデータはGoogle Driveから見えます。
- 同期前に必ずプレビューを確認します。100 MiB超、危険なパス、大小文字・Unicode正規化で衝突するパスは拒否します。
- 「安全なObsidianコア設定」を有効化しても、他プラグイン、テーマ、CSS、`data.json`、実行コードは同期しません。
- 端末を紛失した場合や認証をやり直す場合は「Google接続を解除」からGoogle側の権限を取り消してください。

## 重要な制限

- 本番Vaultではまだ使用しないでください。
- 削除同期は未実装です。
- iPhoneではBRATを使ってベータ版を導入します。一般公開後はコミュニティプラグインから導入できる予定です。
- 同期中にObsidianを終了しないでください。
- 本文のエンドツーエンド暗号化は0.2.0以降で作成・移行したDriveファイルに限ります。
