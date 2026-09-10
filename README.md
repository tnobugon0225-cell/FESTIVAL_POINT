NEXUS:ZERO v5.22

- CONNECTローディング専用SE（Cyber08-1）を削除
- HOME / RANKING / HISTORY / RULE のモジュール切り替え演出を約3秒に変更
- 右上の RANKING / RULE からの移動にも切り替え演出を適用
- RULEもログイン後は同一ページ内モジュール表示に対応し、BGMを継続しやすく調整

NEXUS:ZERO v5.21

- HOME / RANKING / HISTORY 間の切替演出を約5秒に延長
- HOMEからRANKING/HISTORYへ移動する際は同一ページ内モジュール表示にして、深層同調BGMが途切れないよう改善
- アバター選択専用SE Cyber21-2 を追加
- 通常ボタンSEとアバター選択SEが二重再生されないよう分離

NEXUS:ZERO v5.20

- TOP100ランキングから4桁ID表示を削除
- RANKING / HISTORYでも「深層同調」を再生
- LOGIN画面ではBGMを再生しない
- HOME ⇄ RANKING/HISTORY の画面移動にNEXUSモジュール切替カットインを追加
- Cyber10-1をUIボタンSEとして追加
- CONNECT後のアクセス演出中のみCyber08-1を再生

NEXUS:ZERO v5.19

- HOME右上に RULE ボタンを追加
- /rule に専用ルール説明画面を追加
- 対戦申請・対戦内容・審判・対戦ポイント・GAME OVER・報酬を説明
- RULE画面でもHOME用BGM「深層同調」を再生

NEXUS:ZERO v5.18

- ログイン画面に簡潔なゲーム導入文を追加
- アバター選択欄に「能力差なし」の案内を追加
- v5.18のBGM・対戦機能は維持

NEXUS:ZERO v5.17

- BGMを追加（ログイン/HOME・マッチング・戦闘・勝敗結果）
- 各BGMは終了後に自動ループ
- ページ状態に応じてBGMを自動切替
- スマホの自動再生制限に対応するBGM ON/OFFコントロールを追加

NEXUS:ZERO v5.17

- 全アバター表示を約3px下方向へ統一補正
- 端に隙間が出ないよう約1.8%だけ拡大
- HOMEのMY QRを削除し、クイックメニューをHISTORY / RANKINGの2項目に整理
- QR用フロント処理・API・qrcode依存パッケージも削除
- v5.15の対戦・勝敗演出・10秒カウントダウン等は維持

NEXUS:ZERO v5.15

- 結果画面のHOME復帰カウントダウンが10へ戻るちらつきを修正
- 勝者アイコンにVICTOR発光HUDを追加
- 敗者アイコンにDEFEATED警告HUDと斜め警告ラインを追加
- v5.14の対戦機能・BATTLE POINTS表記・RIVAL表記を維持

# NEXUS:ZERO v5.14

- HOME / 承認画面 / 対戦画面 / 勝敗画面のアバター点滅を抑制
- 自動更新時に同じHTML・画像を毎回作り直さない方式へ変更
- WAGER表記を BATTLE POINTS / 対戦ポイント に変更
- 承認待ちの OPPONENT 表記を RIVAL に変更
- v5.13の対戦結果10秒表示・自動HOME復帰・アバター表示は維持

NEXUS:ZERO v5.13

- 対戦終了後、VICTORY / DEFEAT / RESULT画面を10秒表示してHOMEへ自動遷移
- 対戦申請の全画面通知に申請者・対戦相手・審判のアバターを表示
- /match のPLAYER A / PLAYER B / REFEREEに選択アバターを表示
- HOME復帰後に終了済みマッチへ再転送されないよう調整

# NEXUS:ZERO v5.12

## UI update
- 対戦申請を受けた対戦相手・審判に全画面 BATTLE REQUEST 通知
- 通知画面から承認 / 拒否が可能
- 承認後・申請後は専用 `/match` 画面へ遷移
- MATCHING / MATCHING COMPLETE / BATTLE IN PROGRESS / VICTORY / DEFEAT を専用画面化
- 審判の勝利判定も対戦専用画面に配置
- ホームでは3秒ごとに新しい対戦申請を確認
- v5.11の承認処理、PostgreSQL、12アバター、ランキング、履歴などを維持

NEXUS:ZERO v5.11

- 対戦マッチングの承認処理を修正
- 相手承認と審判承認を個別にDB保存し、両方揃った時だけMATCHEDへ移行
- 承認ボタンの連打でもエラーになりにくい冪等処理へ変更
- 承認エラーを対戦カード内に表示
- 既存DBのmatches status CHECK制約をアップグレード時に再設定
- v5.10のアバター調整・対戦・PostgreSQL機能は維持

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
