# NEXUS:ZERO v5.2

## v5.2 の変更

- 正式タイトルを `NEXUS:ZERO` に変更
- 正式ロゴを参加者画面・スタッフ画面に組み込み
- UIを黒基調 + ネオンシアン/バイオレットの電脳競技デザインへ全面刷新
- サブタイトルを「奪え。守れ。生き残れ。」に統一
- 不要な世界観コピーを削除し、POINT / RANK / HISTORY などシステム情報を中心に整理
- 参加者ダッシュボードを ID / TOTAL POINT / RANK のHUD構成へ変更
- 管理画面を ADMIN CONSOLE デザインへ刷新
- PostgreSQL・認証・ランキング・履歴・ポイント譲渡等のv5.0機能は維持

- SQLite を廃止し PostgreSQL (`DATABASE_URL`) を使用
- Webサービス再起動・再デプロイで参加者/ポイント/履歴が消えない構成
- スタッフのセッションも PostgreSQL に保存
- 新規参加者のパスワードを暗号化して保存
- ADMIN 権限だけが参加者の保存済みパスワードを表示可能
- ADMIN 権限で参加者パスワードを再設定可能
- 既存機能（10pt開始、4桁ID、ポイント譲渡、履歴、ランキング、GAME OVER、5秒削除など）は維持

## 必須の環境変数

Render の Web Service > Environment に設定してください。

- `DATABASE_URL` : Render PostgreSQL の接続URL
- `SESSION_SECRET` : 十分長いランダム文字列
- `PASSWORD_ENCRYPTION_KEY` : パスワード表示用の暗号化キー。十分長いランダム文字列

任意:

- `STARTING_POINTS=10`
- `ADMIN_USERNAME=admin`
- `ADMIN_PASSWORD=change-me-now`（初回DB作成時だけ使用。本番は必ず変更）
- `BASE_URL=https://あなたのサイト.onrender.com`

### 重要

`PASSWORD_ENCRYPTION_KEY` を後から変更すると、それ以前に保存した参加者パスワードを復号できなくなります。
本番運用中は同じ値を維持してください。

## Render での移行手順

1. Render Dashboard で `New` > `Postgres` を作成
2. Web Service と同じ Region にする
3. 作成後、Postgres の Internal Database URL を確認
4. Web Service の Environment で `DATABASE_URL` にそのURLを設定
5. `SESSION_SECRET` と `PASSWORD_ENCRYPTION_KEY` も設定
6. GitHub を v5.2 に更新し Render を再デプロイ
7. 起動ログに `Database: PostgreSQL` が出れば成功
8. `/admin` に入り、新しい参加者を1人作る
9. 参加者でログインし、ポイント変更後に再デプロイしてもデータが残ることを確認

## パスワード表示について

参加者作成時のパスワードは以下の2種類で保存します。

- ログイン確認用: bcrypt ハッシュ（元に戻せない）
- 管理者確認用: AES-256-GCM 暗号化（`PASSWORD_ENCRYPTION_KEY` が必要）

管理者画面で参加者を検索すると、ADMIN にのみ以下が表示されます。

- パスワード表示
- パスワード再設定

旧SQLite版ですでに作成済みだったアカウントについては、元パスワードを復元できません。
PostgreSQL版で新規作成するか、管理者からパスワード再設定してください。

## ローカル起動

PostgreSQLが必要です。

Windows cmd の例:

```bat
set DATABASE_URL=postgresql://user:password@localhost:5432/festival_points
set SESSION_SECRET=your-long-secret
set PASSWORD_ENCRYPTION_KEY=another-long-secret
npm install
npm start
```

参加者: http://localhost:3000/

スタッフ: http://localhost:3000/admin

## 注意

SQLite の `festival.db` を自動移行する機能は含めていません。
テスト用データは PostgreSQL 側で作り直してください。
