# NEXUS:ZERO コード整理（2026-10-30）

## 今回削除したもの
サーバーのルーティングでルート直下の最新版が常に優先されている、`public/` 内の旧コピー7ファイルを削除。

- `public/admin.html` → `/admin` / `/admin.html` はルート `admin.html`
- `public/chinchiro.html`, `public/hit-blow.html`, `public/janken.html`, `public/match.html` → `.html` 付き・なしともルート側で配信
- `public/watch.html` → `/watch` / `/watch.html` はルート `watch.html`
- `public/style.css` → `/style.css` はルート `style.css`

`public/index.html` は最終フォールバックに利用されているため削除していない。

## 安全性と制約
- 元のページ・API・ゲームロジック・ポイント計算は変更していない。
- `public/` は Express の静的配信ルートにマウントされており、旧コピーは通常の URL では参照されない。
- 削除したものの直接パス（リポジトリ内の `public/xxx` をファイルとして参照する独自運用）には対応しない。
- 画像・音声・DBファイルと、使用有無を静的に断定できないJS関数・CSSセレクタは保留。
- JS構文検査とZIP整合性検査は実施。ブラウザ・DBを伴うE2Eテストは未実施。
