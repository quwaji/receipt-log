# クイックリファレンス

## ファイル構造と責務

```
receipt-log/
├── src/
│   ├── index.js
│   │   └─ Express サーバー、/webhook・/bank/import エンドポイント
│   │
│   ├── lineHandler.js
│   │   ├─ LINE イベント処理
│   │   ├─ 画像取得 (getMessageContent)
│   │   ├─ ユーザー情報取得 (getProfile / getGroupMemberProfile)
│   │   └─ orchestration & error handling
│   │
│   ├── geminiParser.js
│   │   └─ Gemini 2.5 Flash を使用したレシート解析
│   │       入力: Buffer | 出力: {storeName, totalAmount, paymentDate, paymentMethod, items}
│   │
│   ├── sheetsLogger.js
│   │   └─ サービスアカウント認証で receipts シートに追記
│   │       範囲: {SHEET_NAME}!A:K
│   │
│   ├── bankTransactionImporter.js
│   │   └─ 銀行取引インポートのオーケストレーション
│   │       Drive から CSV 取得 → パース → 重複チェック → Sheets 追記
│   │
│   ├── bankCsvParser.js
│   │   └─ 銀行 CSV パース（Shift-JIS 対応、半角カナ全角変換、NFC 正規化）
│   │       マッピング設定 (bank_mapping.json) を使用して列を抽出
│   │
│   ├── bankTransactionDedup.js
│   │   └─ 銀行取引の重複チェック
│   │       照合キー: 取引日 + 金額 + 摘要 + 残高
│   │
│   ├── bankDriveHelper.js
│   │   └─ Google Drive から CSV 一覧取得・ダウンロード・フォルダ移動（bank/card 共用）
│   │
│   ├── cardTransactionImporter.js
│   │   └─ カード取引インポートのオーケストレーション
│   │       Drive から CSV 取得 → パース → 重複チェック → Sheets 追記
│   │
│   ├── cardCsvParser.js
│   │   └─ カード CSV パース・card_mapping.json 読み込み
│   │
│   ├── cardTransactionDedup.js
│   │   └─ カード取引の重複チェック
│   │       照合キー: 利用日 + 利用店名 + 利用者 + 利用金額
│   │       ※ファイル内重複はすべて取り込み、Sheets 既存データのみスキップ
│   │
│   ├── aggregationService.js
│   │   └─ 月別集計（receipts / bank trans / card trans）
│   │       - 除外列にテキストがある行をスキップ
│   │       - bank trans の「入金」区分を支出から分離
│   │       - getLastMonth() で先月を YYYY-MM 形式で返す
│   │
│   ├── categoryService.js
│   │   └─ カテゴリ自動判定（ルール照合 + Gemini バッチ）
│   │       ① category rules シートからキーワードを読み込み部分一致で判定
│   │       ② 未知の店名のみ Gemini に一括問い合わせ
│   │       ③ 新規ルールを category rules シートに自動追記
│   │
│   └── logger.js
│       └─ logs シートへの処理結果記録
│           範囲: {LOGS_SHEET_NAME}!A:I
│
├── public/
│   └── summary.html             # 月別集計 SPA（Chart.js CDN、ビルド不要）
│       - 前月・翌月ナビゲーション（?month= クエリで制御）
│       - カテゴリ別ドーナツグラフ
│       - ボトムシートでドリルダウン（スワイプで閉じる）
│
├── conf/
│   ├── bank_mapping/
│   │   └── saitamaresona.json   # 銀行マッピングサンプル
│   └── card_mapping/
│       └── rakuten.json         # 楽天カード用マッピングサンプル
│
├── package.json
│   └─ 依存関係（@line/bot-sdk, googleapis, @google/generative-ai, iconv-lite）
│
├── Dockerfile
│   └─ Cloud Run デプロイ用（Node 20-slim）
│
├── .env.example
│   └─ 環境変数テンプレート
│
└── docs/
    ├── SETUP.md       # GCP プロジェクト作成からデプロイまで
    ├── ARCHITECTURE.md  # システム設計
    ├── API.md         # Webhook / Sheets スキーマ / エンドポイント仕様
    ├── QUICKREF.md    # このファイル
    └── MONITORING.md  # 監視・運用手順
```

---

## 環境変数

| 変数 | 用途 | 取得方法 |
|------|------|--------|
| `LINE_CHANNEL_SECRET` | LINE Webhook 署名検証 | LINE Developers > Channel Secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE メッセージ送受信 | LINE Developers > Channel Access Token |
| `GEMINI_API_KEY` | Gemini API 認証 | Google AI Studio (aistudio.google.com) ※個人アカウント |
| `SPREADSHEET_ID` | Google Sheets ID | URL: `/d/{SpreadsheetID}/edit` |
| `SHEET_NAME` | receipts シート名（default: receipts）| Google Sheets タブ名 |
| `BANK_TRANS_SHEET_NAME` | 銀行取引シート名（default: bank trans）| Google Sheets タブ名 |
| `LOGS_SHEET_NAME` | ログシート名（default: logs）| Google Sheets タブ名 |
| `BANK_FOLDER_ID` | 銀行 CSV フォルダ ID | Drive の URL: `/folders/{ID}` |
| `CARD_FOLDER_ID` | カード CSV フォルダ ID | Drive の URL: `/folders/{ID}` |
| `CARD_TRANS_SHEET_NAME` | カード取引シート名（default: card trans）| Google Sheets タブ名 |
| `CATEGORY_RULES_SHEET_NAME` | カテゴリルールシート名（default: category rules）| Google Sheets タブ名 |
| `LIFF_URL` | LIFF アプリの URL（任意）| LINE Developers > LINE Login チャンネル > LIFF |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GCP サービスアカウント認証 | gcloud iam service-accounts keys create |

---

## 開発フロー

### セットアップ

```bash
# 1. 依存関係のインストール
npm install

# 2. .env.local ファイル作成
cp .env.example .env.local
# 値を埋める...

# 3. ローカル実行（.env.local を自動で読み込む）
npm run dev
```

### デバッグ

```bash
# コンソールログで動作確認
# src/lineHandler.js で console.log / console.error

# Cloud Run のリモートログ確認
gcloud run logs read receipt-log-bot --region asia-northeast1 --limit 50
```

### デプロイ

```bash
gcloud run deploy receipt-log-bot \
  --source . \
  --region asia-northeast1 \
  --set-env-vars="..." # SETUP.md 参照
```

---

## API 呼び出しチートシート

### LINE Messaging API

```javascript
const { Client } = require("@line/bot-sdk");
const client = new Client(config);

// メッセージコンテンツ取得（Binary）
await client.getMessageContent(messageId);

// グループメンバープロフィール取得
await client.getGroupMemberProfile(groupId, userId);

// 1対1プロフィール取得
await client.getProfile(userId);

// テキスト返信
await client.replyMessage(replyToken, { type: "text", text: "..." });
```

### Gemini API

```javascript
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const result = await model.generateContent([
  prompt,
  { inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } }
]);
const text = result.response.text();
```

### Google Sheets API（追記）

```javascript
const { google } = require("googleapis");
const sheets = google.sheets({ version: "v4", auth });

await sheets.spreadsheets.values.append({
  spreadsheetId,
  range: `${SHEET_NAME}!A:K`,   // receipts: A:K / bank trans: A:H / card trans: A:J / logs: A:I
  valueInputOption: "USER_ENTERED",
  insertDataOption: "INSERT_ROWS",
  requestBody: { values: [[...]] }
});
```

### 銀行・カードインポートのローカルテスト

```bash
curl -X POST http://localhost:8080/bank/import \
  -H "Content-Type: application/json" \
  -d '{"spreadsheetId": "...", "bankFolderId": "..."}'

curl -X POST http://localhost:8080/card/import \
  -H "Content-Type: application/json" \
  -d '{"spreadsheetId": "...", "cardFolderId": "..."}'
```

### 月別集計のローカルテスト

```bash
# JSON API
curl "http://localhost:8080/summary?month=2026-04"

# SPA をブラウザで確認
open "http://localhost:8080/summary.html?month=2026-04"
```

---

## エラー対応フローチャート

### レシート処理（/webhook）

```
Webhook 受信
  │
  ├─ type !== "message" OR message.type !== "image"
  │  └─► 無視
  │
  ├─ getGroupMemberProfile / getProfile 失敗
  │  └─► displayName = "不明" で続行
  │
  ├─ getMessageContent 失敗
  │  └─► replyMessage("画像の取得に失敗しました。") → 終了
  │
  ├─ Gemini parseReceipt 失敗
  │  └─► replyMessage("レシートの読み取りに失敗しました。") → 終了
  │
  ├─ Sheets logToSheet 失敗
  │  └─► replyMessage("スプレッドシートへの記録に失敗しました。") → 終了
  │
  └─ 全て成功
     └─► replyMessage("✅ 記録しました！...") → 終了
```

### 銀行インポート（/bank/import）

```
POST /bank/import
  │
  ├─ bank_mapping.json が見つからない → 400 エラー
  ├─ CSV ファイルなし → "処理対象なし" で 200
  │
  └─ 各 CSV ファイル
      ├─ パース失敗 → 「要確認」フォルダへ移動・logs に記録
      └─ 成功 → 「処理済み」フォルダへ移動・logs に記録
```

### カードインポート（/card/import）

```
POST /card/import
  │
  ├─ card_mapping.json が見つからない → 400 エラー
  ├─ CSV ファイルなし → "処理対象なし" で 200
  │
  └─ 各 CSV ファイル
      ├─ パース失敗 → 「要確認」フォルダへ移動・logs に記録
      └─ 成功（ファイル内重複はすべて取り込み、Sheets 既存のみスキップ）
             → 「処理済み」フォルダへ移動・logs に記録
```

---

## テストチェックリスト

### レシート機能
- [ ] `npm run dev` が起動する
- [ ] ngrok で LINE テストメッセージ送信 → Bot 返信確認
- [ ] receipts シートに行が追記される（A:K 全カラム）
- [ ] 支払い日時が読み取れない場合、J 列に備考が入る
- [ ] グループ ID が E 列に記録される
- [ ] K 列にカテゴリが記録される

### 銀行インポート機能
- [ ] `POST /bank/import` でエラーなく完了する
- [ ] bank trans シートに行が追記される（H 列に銀行名）
- [ ] G 列にカテゴリが記録される
- [ ] logs シートに処理結果が記録される（B 列に "bank trans"、C 列に銀行名）
- [ ] 重複行が除外される
- [ ] 処理済み CSV が「処理済み」フォルダへ移動する

### カードインポート機能
- [ ] `POST /card/import` でエラーなく完了する
- [ ] card trans シートに行が追記される（I 列にカード名）
- [ ] J 列にカテゴリが記録される
- [ ] logs シートに処理結果が記録される（B 列に "card trans"、C 列にカード名）
- [ ] ファイル内の重複行がすべて取り込まれる
- [ ] Sheets 既存データと一致する行のみスキップされる
- [ ] 処理済み CSV が「処理済み」フォルダへ移動する

### カテゴリ自動判定
- [ ] category rules シートのルールが照合される（部分一致）
- [ ] 未知の店名は Gemini で判定される
- [ ] 新規ルールが category rules シートに自動追記される

### 月別集計機能
- [ ] `GET /summary?month=YYYY-MM` が正しい JSON を返すこと
- [ ] SPA でグラフ・カテゴリリスト・入金が表示されること
- [ ] 前月・翌月ナビゲーションが機能すること
- [ ] カテゴリ・入金タップでドリルダウン明細が開くこと
- [ ] 明細が日付昇順で表示されること
- [ ] 除外列にテキストがある行が集計に含まれないこと
- [ ] LINE で「集計」と送信するとテキスト集計が返ること
- [ ] LIFF_URL 設定時に「グラフで見る」ボタンが返ること

---

## パフォーマンス目安

| 処理 | 時間 |
|------|------|
| LINE Webhook 受信 | ~10ms |
| 画像取得 | ~100ms |
| Gemini 解析 | ~2-5s |
| Sheets 追記 | ~100ms |
| **合計** | **~2.2-5.2s** |

タイムアウト: Cloud Run 60秒（十分な余裕）
