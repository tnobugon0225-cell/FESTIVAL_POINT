NEXUS:ZERO v5.10

- 12人のアバター素材を個別に再トリミングして位置ズレを修正
- 3x4の選択グリッドで各アイコンの見え方が揃うよう調整
- v5.9の対戦マッチング / ログイン演出 / PostgreSQL 機能は維持

NEXUS:ZERO v5.10

- スマホのアバター選択グリッドのズレを修正
- 3列×4段を固定1:1で整列
- アバターボタンが通常buttonのhover/余白/高さを継承しないよう分離
- SELECTED表示をアイコン内に固定
- v5.8の対戦マッチング機能は維持

# NEXUS:ZERO v5.8

## 主な変更
- ポイント入力欄の 1pt / 10pt の初期入力値を削除
- 参加者同士の直接ポイント譲渡を廃止
- 対戦相手ID・審判ID・賭けポイントを指定する対戦申請を追加
- 対戦相手と審判の両方が承認するとマッチング完了
- 賭け上限は対戦者2名の所持ポイントの低い方
- 審判だけが勝者を確定可能
- 勝者へ賭けポイントを加算、敗者から同額を減算
- MATCHING / MATCHING COMPLETE / BATTLE IN PROGRESS / VICTORY / DEFEAT 演出を追加
- 12種類のアバター・PostgreSQL・ランキング・履歴・ログイン演出を維持

NEXUS:ZERO v5.7

- 12種類の本番用アバターを追加
- ログイン時に12種から選択可能
- 選択したアバターをホーム / ランキング / 管理者検索結果に反映
- v5.6のログイン演出・PostgreSQL・ランキング・履歴などは維持

# NEXUS:ZERO v5.6

PostgreSQL版の学祭用ポイント競技サイトです。

## v5.6 の主な変更
- ロゴ表示領域を調整し、スマホで下側が切れにくいように修正
- 参加者ログイン時に6種類の1:1アバターから選択可能
- 選択したアバターをプロフィールとランキングに表示
- ホームのランキングは上位5名のみプレビュー
- `TOP 100` / `RANKING` から専用ランキング画面 `/ranking` に移動し、最大100位まで表示
- ポイント譲渡の「相手ID・ポイント・理由」をスマホでも横一列に配置
- 参加者画面は12秒ごと、ランキング専用画面も12秒ごとに更新

## Render 環境変数
- `DATABASE_URL`
- `SESSION_SECRET`
- `PASSWORD_ENCRYPTION_KEY`

任意:
- `ADMIN_USERNAME` (初期値 `admin`)
- `ADMIN_PASSWORD` (初期値 `change-me-now`)
- `STARTING_POINTS` (初期値 `10`)
- `BASE_URL`

## 起動
```bash
npm install
npm start
```

## URL
- 参加者: `/`
- ランキング TOP100: `/ranking`
- スタッフ: `/admin`

## 注意
既存PostgreSQLの `users` テーブルには起動時に `avatar_key` 列が自動追加されます。
参加者はログインのたびにアバターを選択でき、その選択が保存されます。

## v5.6 changes
- Dedicated wide NEXUS:ZERO header image (`public/nexus-zero-header.webp`)
- Smaller centered hero logo with no vertical clipping
- Point transfer inputs remain in a single row on mobile
- Extra bottom spacing so sticky navigation does not cover content
- Existing avatar selection and separate TOP 100 ranking page retained


## v5.6 UI updates
- ヘッダー画像内にサブタイトルを統合
- HOMEランキングはTOP5＋自分が6位以下なら自分の順位を追加表示
- HISTORYを専用ページ化
- TOP100ランキングは専用ページのまま維持


## v5.6 update
- 参加者ログイン成功時にフルスクリーンの NEXUS ACCESS 演出を追加
- ACCESSING → VERIFYING → AUTHENTICATING → SYNCHRONIZING → LINK ESTABLISHED の順で遷移
- 認証失敗時は ACCESS DENIED / CONNECTION FAILED を表示してログイン画面へ戻る
- 既存の参加者機能、PostgreSQL、ランキング、履歴、アバター選択は維持
