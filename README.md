# Receipt Log Bot

LINE グループ内で共有されたレシート画像を自動で解析し、Google Sheets に記録する Bot です。
また、銀行の取引明細 CSV を Google Drive 経由でスプレッドシートにインポートする機能も備えています。

## 特徴

- **無料で運用可能** — Cloud Run の無料枠内で動作
- **グループ対応** — 誰がレシートを申告したか・どのグループからかを自動記録
- **自動解析** — Gemini API でレシート情報（店名・金額・支払い日時・支払い方法・品目）を構造化データに変換
- **スプレッドシート統合** — リアルタイムでレシート情報を集計できる
- **銀行取引インポート** — Shift-JIS の CSV に対応、銀行ごとのマッピング設定で複数口座を管理
- **カード利用明細インポート** — 楽天カード等の CSV に対応、カードごとのマッピング設定で複数カードを管理
- **カテゴリ自動判定** — ルールベース＋Gemini のハイブリッドで全トランザクションにカテゴリを付与。既知の店名はルールで即判定し、未知の店名のみ Gemini に問い合わせて `category rules` シートに蓄積
- **月別集計** — 「集計」と投稿するとカテゴリ別支出・入金合計・メンバー別レシート合計をテキスト返信。LIFF SPA でドーナツグラフ・ドリルダウン・月ナビゲーションを提供
- **LIFF 認証** — 集計 SPA は LINE アプリ内からのみアクセス可能（LIFF ID トークン検証）。開発環境は認証なしで直接アクセス可

## 使い方

### ① レシートをグループで送信

LINE アプリでボットをグループに招待し、レシート画像を送るだけ。

```
✅ 記録しました！

👤 田中太郎
🏪 セブン-イレブン
🗓 2026/04/10 15:32
💴 1,280 円（現金）
🛒 おにぎり、コーヒー、弁当
```

ボットが自動で店名・金額・支払い日時・支払い方法・品目を認識し、送信者名・グループ ID とともに Google Sheets に追記します。

### ④ 月別集計（テキスト）

「集計」と投稿すると先月分のテキスト集計を返信します。

```
📊 2026年4月の集計

【支出カテゴリ別】
食費　¥45,230
日用品　¥12,800
──────────────
支出合計　¥67,760

【入金】
入金合計　¥350,000

【レシート】
田中太郎　¥18,500
山田花子　¥8,200
```

`LIFF_URL` を設定すると「📊 グラフで見る」ボタンも返信します。SPA ではメンバー別集計のドリルダウンも利用できます。

### ② 銀行取引明細のインポート

Google Drive の指定フォルダに CSV を置いて POST リクエストを送ると、スプレッドシートにインポートされます。

```bash
curl -X POST https://{cloud-run-url}/bank/import
```

- 重複チェックあり（同一取引の二重登録を防止）
- 処理済みファイルは自動で「処理済み」フォルダへ移動
- 失敗ファイルは「要確認」フォルダへ移動
- 処理結果は logs シートに記録

### ③ カード利用明細のインポート

銀行取引と同様に、Google Drive のフォルダに CSV を置いて POST リクエストを送ります。

```bash
curl -X POST https://{cloud-run-url}/card/import
```

- ファイル内の重複はすべて取り込み、スプレッドシート既存データと一致する場合のみスキップ
- 重複キー: 利用日 + 利用店名 + 利用者 + 利用金額
- 処理結果は logs シートに記録（処理名: `card trans`）

### ④ 月別集計

LINE グループで「集計」と投稿するとカテゴリ別支出と入金合計をテキストで返信します。

```
📊 2026年4月の集計

【支出カテゴリ別】
食費　¥45,230
日用品　¥12,800
交通費　¥8,500
──────────────
支出合計　¥67,760

【入金】
入金合計　¥350,000
```

`LIFF_URL` を設定すると「📊 グラフで見る」ボタンも返信します。ボタンから開く SPA では前月・翌月ナビゲーション、カテゴリ別ドーナツグラフ、タップで明細ドリルダウンが利用できます。

- 各シートの「除外」列（receipts: L列 / bank trans: I列 / card trans: K列）にテキストがある行は集計から除外
- bank trans の区分「入金」は支出と分離して入金合計に計上

## システム構成

```
LINE Bot
  ↓ (webhook / text)
├─ Cloud Run (Express)
   ├─ Gemini 2.5 Flash (レシート解析・カテゴリ判定)
   ├─ Google Sheets API (記録・集計)
   ├─ Google Drive API (CSV 取得)
   └─ public/summary.html (LIFF SPA)
```

**無料枠:**
- Cloud Run: 200万リクエスト/月
- Gemini API: 20リクエスト/日（Free tier）
- Google Sheets API: 制限なし
- LINE Messaging API: 返信メッセージは無料

## ファイル構成

```
src/
├── index.js                   # Express サーバー + 全エンドポイント + 静的ファイル配信
├── lineHandler.js             # LINE イベント処理（画像受信・テキスト「集計」対応）
├── geminiParser.js            # Gemini でレシート画像を構造化データに変換
├── sheetsLogger.js            # receipts シートに記録
├── aggregationService.js      # 月別集計（receipts / bank trans / card trans）
├── bankTransactionImporter.js # 銀行取引インポート処理のオーケストレーション
├── bankCsvParser.js           # 銀行 CSV パース（Shift-JIS 対応・半角カナ全角変換）
├── bankTransactionDedup.js    # 銀行取引の重複チェック
├── bankDriveHelper.js         # Google Drive からの CSV 取得・移動（bank/card 共用）
├── cardTransactionImporter.js # カード取引インポート処理のオーケストレーション
├── cardCsvParser.js           # カード CSV パース・card_mapping.json 読み込み
├── cardTransactionDedup.js    # カード取引の重複チェック
├── categoryService.js         # カテゴリ自動判定（ルール照合 + Gemini バッチ）
└── logger.js                  # logs シートへの処理結果記録

public/
└── summary.html               # 月別集計 SPA（LIFF・Chart.js CDN）

conf/
├── bank_mapping/              # 銀行ごとのマッピング設定
│   └── saitamaresona.json     # 埼玉りそな銀行用サンプル
└── card_mapping/              # カードごとのマッピング設定
    └── rakuten.json           # 楽天カード用サンプル

docs/
├── SETUP.md         # セットアップ手順
├── ARCHITECTURE.md  # システム設計書
├── API.md           # API 仕様書
├── QUICKREF.md      # 開発用チートシート
└── MONITORING.md    # 監視・運用手順

package.json         # 依存パッケージ
Dockerfile           # Cloud Run デプロイ用
.env.example         # 環境変数テンプレート
```

## クイックスタート

1. [docs/SETUP.md](./docs/SETUP.md) に従って GCP プロジェクトを作成
2. LINE Developers で Messaging API チャンネルを追加
3. `gcloud run deploy --source .` でデプロイ
4. Webhook URL を LINE に設定
5. ボットをグループに追加
6. （任意）LINE Login チャンネルを作成し LIFF アプリを登録 → `LIFF_URL` を環境変数に設定

## 技術スタック

- **Node.js 20** — バックエンド
- **Express** — Web フレームワーク
- **@line/bot-sdk** — LINE Messaging API クライアント
- **@google/generative-ai** — Gemini API クライアント
- **googleapis** — Google Sheets / Drive API クライアント
- **iconv-lite** — Shift-JIS CSV デコード
- **Cloud Run** — ホスティング

## スプレッドシートの構成

### receipts シート（レシート記録）

| 列 | 項目 |
|----|------|
| A | 受信日時 |
| B | 支払い日時 |
| C | LINE UserID |
| D | 表示名 |
| E | グループID |
| F | 店名 |
| G | 合計金額（円）|
| H | 支払い方法 |
| I | 品目 |
| J | 備考 |
| K | カテゴリ（自動）|
| L | 除外（集計から除く場合に記入）|

### card trans シート（カード利用明細）

| 列 | 項目 |
|----|------|
| A | 利用日 |
| B | 利用店名・商品名 |
| C | 利用者 |
| D | 支払方法 |
| E | 利用金額 |
| F | 手数料/利息 |
| G | 支払総額 |
| H | 支払月 |
| I | カード名 |
| J | カテゴリ（自動）|
| K | 除外（集計から除く場合に記入）|

### bank trans シート（銀行取引）

| 列 | 項目 |
|----|------|
| A | 取引日 |
| B | 金額 |
| C | 区分 |
| D | 残高 |
| E | 摘要 |
| F | コメント |
| G | カテゴリ（自動）|
| H | 銀行名 |
| I | 除外（集計から除く場合に記入）|

### logs シート（インポート処理ログ）

| 列 | 項目 |
|----|------|
| A | タイムスタンプ |
| B | 処理名 |
| C | 銀行名 |
| D | ファイル名 |
| E | ステータス |
| F | 総行数 |
| G | インポート行数 |
| H | 重複行数 |
| I | エラーメッセージ |

## トラブルシューティング

異常系の対応は各モジュールで実装済み：

- 画像取得失敗 → ユーザーに通知
- レシート解析失敗 → ユーザーに通知
- スプレッドシート記録失敗 → ユーザーに通知
- プロフィール取得失敗 → 「不明」として続行
- CSV インポート失敗 → 「要確認」フォルダへ移動・logs に記録

---

質問や機能リクエストは Issue を作成してください。
