# NEXUS:ZERO v5.5

PostgreSQL版の学祭用ポイント競技サイトです。

## v5.5 の主な変更
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

## v5.5 changes
- Dedicated wide NEXUS:ZERO header image (`public/nexus-zero-header.webp`)
- Smaller centered hero logo with no vertical clipping
- Point transfer inputs remain in a single row on mobile
- Extra bottom spacing so sticky navigation does not cover content
- Existing avatar selection and separate TOP 100 ranking page retained


## v5.5 UI updates
- ヘッダー画像内にサブタイトルを統合
- HOMEランキングはTOP5＋自分が6位以下なら自分の順位を追加表示
- HISTORYを専用ページ化
- TOP100ランキングは専用ページのまま維持
