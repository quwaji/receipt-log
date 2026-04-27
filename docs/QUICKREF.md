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
│   │       範囲: {SHEET_NAME}!A:J
│   │
│   ├── bankTransactionImporter.js
│   │   └─ 銀行取引インポートのオーケストレーション
│   │       Drive から CSV 取得 → パース → 重複チェック → Sheets 追記
│   │
│   ├── bankCsvParser.js
│   │   └─ CSV パース（Shift-JIS 対応、半角カナ全角変換、NFC 正規化）
│   │       マッピング設定 (bank_mapping.json) を使用して列を抽出
│   │
│   ├── bankTransactionDedup.js
│   │   └─ 既存トランザクションとの重複チェック
│   │       照合キー: 取引日 + 金額 + 摘要 + 残高
│   │
│   ├── bankDriveHelper.js
│   │   └─ Google Drive から CSV 一覧取得・ダウンロード・フォルダ移動
│   │
│   └── logger.js
│       └─ logs シートへの処理結果記録
│           範囲: {LOGS_SHEET_NAME}!A:I
│
├── conf/
│   └── bank_mapping/
│       └── saitamaresona.json   # 銀行マッピングサンプル
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
  range: `${SHEET_NAME}!A:J`,   // receipts: A:J / bank trans: A:H / logs: A:I
  valueInputOption: "USER_ENTERED",
  insertDataOption: "INSERT_ROWS",
  requestBody: { values: [[...]] }
});
```

### 銀行インポートのローカルテスト

```bash
curl -X POST http://localhost:8080/bank/import \
  -H "Content-Type: application/json" \
  -d '{"spreadsheetId": "...", "bankFolderId": "..."}'
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

---

## テストチェックリスト

### レシート機能
- [ ] `npm run dev` が起動する
- [ ] ngrok で LINE テストメッセージ送信 → Bot 返信確認
- [ ] receipts シートに行が追記される（A:J 全カラム）
- [ ] 支払い日時が読み取れない場合、J 列に備考が入る
- [ ] グループ ID が E 列に記録される

### 銀行インポート機能
- [ ] `POST /bank/import` でエラーなく完了する
- [ ] bank trans シートに行が追記される（H 列に銀行名）
- [ ] logs シートに処理結果が記録される（B 列に "bank trans"、C 列に銀行名）
- [ ] 重複行が除外される
- [ ] 処理済み CSV が「処理済み」フォルダへ移動する

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
