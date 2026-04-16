# クイックリファレンス

## ファイル構造と責務

```
receipt-log/
├── src/
│   ├── index.js
│   │   └─ Express サーバー、Webhook エンドポイント
│   │
│   ├── lineHandler.js
│   │   ├─ LINE イベント処理
│   │   ├─ 画像取得 (getMessageContent)
│   │   ├─ ユーザー情報取得 (getProfile / getGroupMemberProfile)
│   │   └─ orchestration & error handling
│   │
│   ├── geminiParser.js
│   │   └─ Gemini 1.5 Flash を使用したレシート解析
│   │       入力: Buffer | 出力: {storeName, totalAmount, items}
│   │
│   └── sheetsLogger.js
│       └─ サービスアカウント認証で Google Sheets に追記
│           範囲: {SHEET_NAME}!A:F
│
├── package.json
│   └─ 依存関係（@line/bot-sdk, googleapis, @google/generative-ai）
│
├── Dockerfile
│   └─ Cloud Run デプロイ用（Node 20-slim）
│
├── README.md
│   └─ プロジェクト概要
│
├── ARCHITECTURE.md
│   └─ システム設計（フロー、アーキテクチャ、スキーマ）
│
├── API.md
│   └─ Webhook / LINE API / Sheets API 仕様
│
├── SETUP.md
│   └─ GCP プロジェクト作成からデプロイまで
│
└── .env.example
    └─ 環境変数テンプレート
```

---

## 環境変数

| 変数 | 用途 | 取得方法 |
|------|------|--------|
| `LINE_CHANNEL_SECRET` | LINE Webhook 署名検証 | LINE Developers > Channel Secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE メッセージ送受信 | LINE Developers > Channel Access Token |
| `GEMINI_API_KEY` | Gemini API 認証 | Google AI Studio (aistudio.google.com) |
| `SPREADSHEET_ID` | Google Sheets ID | URL: `/d/{SpreadsheetID}/edit` |
| `SHEET_NAME` | シート名（デフォルト: receipts） | Google Sheets タブ名 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GCP サービスアカウント認証 | gcloud iam service-accounts keys create |

---

## 開発フロー

### セットアップ

```bash
# 1. 依存関係のインストール
npm install

# 2. .env ファイル作成
cp .env.example .env
# 値を埋める...

# 3. ローカル実行
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
# 環境変数を指定してデプロイ（SETUP.md 参照）
gcloud run deploy receipt-log-bot \
  --source . \
  --region asia-northeast1 \
  --set-env-vars="..." \
  # ... 他の環境変数
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
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// 画像 + テキスト送信
const result = await model.generateContent([
  prompt,
  {
    inlineData: {
      data: imageBuffer.toString("base64"),
      mimeType: "image/jpeg"
    }
  }
]);

// レスポンス取得
const text = result.response.text();
```

### Google Sheets API

```javascript
const { google } = require("googleapis");
const sheets = google.sheets({ version: "v4", auth });

// 行を追記
await sheets.spreadsheets.values.append({
  spreadsheetId,
  range: `${SHEET_NAME}!A:F`,
  valueInputOption: "USER_ENTERED",
  insertDataOption: "INSERT_ROWS",
  requestBody: { values: [[...]] }
});
```

---

## エラー対応フローチャート

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

---

## テストチェックリスト

- [ ] ローカルで `npm run dev` が起動する
- [ ] ngrok で LINE テストメッセージ送信 → Bot 返信確認
- [ ] Google Sheets に行が追記されることを確認
- [ ] グループのユーザー ID が記録される
- [ ] エラー時に Bot が通知を返す

---

## パフォーマンス目安

| 処理 | 時間 |
|------|------|
| LINE Webhook 受信 | ~10ms |
| 画像取得 | ~100ms |
| Gemini 解析 | ~2-5s |
| Sheets 追記 | ~100ms |
| **合計** | **~2.2-5.2s** |

タイムアウト: Cloud Run 60秒（充分な余裕）

---

## メトリクス監視

### 重要な KPI

```
Error Rate (1日)
  └─ replyMessage("失敗しました") の頻度
  └─ 目安: < 1%

Latency P95
  └─ Webhook 完了まで
  └─ 目安: < 5秒

Daily Requests
  └─ Gemini API 使用量
  └─ 目安: < 1,500 (無料枠)
```

### Cloud Logging で監視（オプション）

```bash
# エラーログだけを抽出
gcloud run logs read receipt-log-bot \
  --region asia-northeast1 \
  --filter="severity>=ERROR"

# 特定の期間で集計
gcloud run logs read receipt-log-bot \
  --region asia-northeast1 \
  --limit 100 \
  --from-log-name=projects/PROJECT_ID/logs/run.googleapis.com%2Fstdout
```

---

## よくある問題と解決策

### Q: Sheets に記録されない
**A:**
1. Spreadsheet ID が正しいか確認
2. サービスアカウントがシートの共有を持つか確認
   ```bash
   gcloud iam service-accounts describe receipt-bot-sa@PROJECT_ID.iam.gserviceaccount.com
   ```
3. `gcloud run logs` でエラーを確認

### Q: Bot の返信が遅い
**A:**
1. Gemini API レート制限を確認（15 RPM）
2. 大きな画像を送っていないか確認
3. Cloud Run メモリを増やす（デフォルト 512 MB で充分）

### Q: グループで「不明」と表示される
**A:**
1. Bot がグループに参加しているか確認
2. グループ ID が正しく渡されているか確認
3. `console.warn("プロフィール取得失敗")` をログで見てフォールバック動作は正常

---

## まとめ

- **3 つのサービス統合:** LINE + Gemini + Google Sheets
- **エラーハンドリング:** 各ステップで try-catch、段階的フェイルセーフ
- **スケーラビリティ:** 無料枠で月 1,500 件まで対応可能
- **監視:** Cloud Logging で自動ログ、エラー時は Slack 通知可能（拡張）

