# システム設計書

## システムアーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                      LINE Users (Group)                      │
│                         📱📱📱                              │
└──────────────────────────┬──────────────────────────────────┘
                           │ Image Message
                           │
┌──────────────────────────▼──────────────────────────────────┐
│               LINE Messaging API                            │
│            (Event Webhook Endpoint)                         │
└──────────────────────────┬──────────────────────────────────┘
                           │ webhook POST
                           │ {type: "message", message: {type: "image"}}
                           │
        ┌──────────────────▼──────────────────┐
        │   Cloud Run                         │
        │ (receipt-log-bot)                   │
        │                                      │
        │  ┌─────────────────────────────┐   │
        │  │  Express Server (Port 8080) │   │
        │  │  - /webhook (POST)          │   │
        │  │  - /health (GET)            │   │
        │  └────────┬────────────────────┘   │
        │           │                        │
        │  ┌────────▼──────┐                │
        │  │ lineHandler   │                │
        │  ├───────────────┤                │
        │  │ • Image取得   │                │
        │  │ • User情報取得 │                │
        │  │ • orchestrate │                │
        │  └────────┬──────┘                │
        │           │                        │
        │  ┌────────┼──────────────────┐    │
        │  │        │                  │    │
        │  ▼        ▼                  ▼    │
        │┌──────┐ ┌──────────────┐ ┌──────┐│
        ││Gemini│ │Google Sheets │ │  LINE││
        ││ API  │ │    API       │ │ Reply││
        │└──────┘ └──────────────┘ └──────┘│
        └──────────────────────────────────┘
                    ▲         ▲         ▲
         ┌──────────┘         │         └──────────┐
         │                    │                    │
    ┌────▼─────┐         ┌────▼─────┐        ┌────▼─────┐
    │  Gemini  │         │ Google   │        │   LINE   │
    │   1.5    │         │ Sheets   │        │Messaging│
    │ Flash    │         │  API     │        │   API    │
    │          │         │          │        │          │
    │ Receipt  │         │ Append   │        │  Reply   │
    │ Analysis │         │  Rows    │        │ Message  │
    └───┬──────┘         └──────────┘        └──────────┘
        │
        │ Image (Base64)
        │
   ┌────▼──────────────┐
   │  LINE Bot         │
   │  (getMessageContent)
   └───────────────────┘
```

## コンポーネント詳細

### 1. Cloud Run (Express Server)

**役割:** LINE Webhook を受け取り、各サービスを調整

**エンドポイント:**
- `POST /webhook` — LINE のイベント受信（middleware で署名検証）
- `GET /health` — ヘルスチェック

**環境変数:**
```
LINE_CHANNEL_SECRET          # Webhook 署名検証用
LINE_CHANNEL_ACCESS_TOKEN    # メッセージ送受信
GEMINI_API_KEY               # Gemini API 認証
SPREADSHEET_ID               # Google Sheets ID
SHEET_NAME                   # シート名（default: receipts）
GOOGLE_SERVICE_ACCOUNT_JSON  # GCP サービスアカウント認証情報
```

### 2. LINE Handler (`src/lineHandler.js`)

**フロー:**

```
Event受信
  ↓
[メッセージタイプ判定]
  ├─ 画像以外 → 無視して終了
  │
  └─ 画像メッセージ
      ↓
  [ユーザー情報取得]
      ├─ グループ → getGroupMemberProfile()
      └─ 1対1    → getProfile()
      ↓
  [画像を取得]
      └─ getMessageContent(messageId)
      ↓
  [Gemini で解析]
      └─ parseReceipt(imageBuffer)
      ↓
  [Sheets に記録]
      └─ logToSheet({timestamp, userId, displayName, storeName, totalAmount, items})
      ↓
  [返信を送信]
      └─ replyMessage(replyToken, text)
```

**エラーハンドリング:**

各ステップでエラーキャッチ → ユーザーに通知して続行

```javascript
try {
  profile = await client.getGroupMemberProfile(groupId, userId);
} catch (err) {
  console.warn(`プロフィール取得失敗: ${err.message}`);
  displayName = "不明";  // フォールバック
}
```

### 3. Gemini Parser (`src/geminiParser.js`)

**入力:** レシート画像（Binary）

**プロセス:**

```
画像 (JPEG/PNG)
  ↓
[Base64 エンコード]
  ↓
Gemini 1.5 Flash に送信
  ├─ プロンプト: レシート解析指示
  ├─ 画像データ (inlineData)
  └─ 出力形式: JSON
  ↓
[JSON パース]
  ↓
構造化データ返却
{
  "storeName": "セブン-イレブン",
  "totalAmount": 1280,
  "items": "おにぎり 150円\nコーヒー 180円\n..."
}
```

**Prompt:**

```
この画像はレシートです。以下の情報をJSON形式で抽出してください。
情報が読み取れない場合は null にしてください。

{
  "storeName": "店名（文字列）",
  "totalAmount": 合計金額（数値、税込み、円記号なし）,
  "items": "品目リスト（各行に「品名 金額円」の形式で改行区切り）"
}
```

**費用概算（月 100 件）:**
- Gemini 1.5 Flash: $0.075/1K トークン
- 1 リクエスト平均 ~600 トークン
- 100 × 600 / 1000 × $0.075 = $4.5 ＝ 約 ¥650

**品質:** 
- テクスト認識精度: ~95%（一般的なレシート）
- 構造化精度: ~85%（複雑な書きとめはミス可能性あり）

### 4. Sheets Logger (`src/sheetsLogger.js`)

**認証:** Google Cloud Service Account

```
┌─────────────────┐
│  Service      │
│  Account      │──────→ Sheets API
│  (JSON Key)   │
└─────────────────┘
     JSON ↓
credentials.json から GoogleAuth オブジェクト作成
     ↓
google.sheets.spreadsheets.values.append()
```

**レコード形式:**

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| 日時 | LINE UserID | 表示名 | 店名 | 合計金額 | 品目 |
| 2026-04-10 15:32 | U1234abcd... | 田中太郎 | セブン-イレブン | 1280 | おにぎり 150円<br>コーヒー 180円 |

**追記方法:**

```javascript
await sheets.spreadsheets.values.append({
  spreadsheetId: SPREADSHEET_ID,
  range: `receipts!A:F`,
  valueInputOption: "USER_ENTERED",  // 数式や日時フォーマットを解釈
  insertDataOption: "INSERT_ROWS",   // 既存データを上に移動しない
  requestBody: { values: [[...]] }
});
```

---

## データフロー例

### シナリオ: グループでレシートを共有

```
[グループ]
田中太郎が画像送信
  ↓
[LINE Bot]
EVENT: message.image
  ├─ groupId: "C12345..."
  ├─ userId: "U5678..."
  └─ imageId: "12345..."
  ↓
[lineHandler]
getGroupMemberProfile("C12345...", "U5678...") → "田中太郎"
getMessageContent("12345...") → Buffer (JPEG)
  ↓
[geminiParser]
Gemini: "この店はファミリーマート、¥2,450, 弁当¥580..." → JSON
  ↓
{
  storeName: "ファミリーマート",
  totalAmount: 2450,
  items: "弁当 580円\nおかし 320円\nドリンク 240円"
}
  ↓
[sheetsLogger]
Sheets.append({
  timestamp: "2026-04-10 15:45",
  userId: "U5678...",
  displayName: "田中太郎",
  storeName: "ファミリーマート",
  totalAmount: 2450,
  items: "弁当 580円\nおかし 320円\n..."
})
  ↓
[LINE Bot]
replyMessage(replyToken, "✅ 記録しました！...")
  ↓
[グループ]
ボットの返信が表示される
```

---

## スケーラビリティ

### 現在の設定での処理能力

| 指標 | 上限 | 説明 |
|------|------|------|
| Cloud Run 並行実行 | 80個 | デフォルト（無料枠内） |
| Gemini API | 1,500 req/日 | 無料枠 |
| Sheets API | 600 req/分 | API 仕様上の制限 |
| **推定処理能力** | **1,500 img/日** | Gemini が律速 |

### 月 5,000 件の場合（拡張必要）

Gemini API から Vision API へ切り替え可能：
- Vision API: $1.5/1K リクエスト → 月額 $7.5
- Gemini より安いが、結果は JSON でなくテキスト

---

## セキュリティ

### LINE Webhook 署名検証

```javascript
// Express middleware で自動検証（@line/bot-sdk）
app.post("/webhook", middleware(config), handler);
// X-Line-Signature ヘッダーが不正な場合は 401 返す
```

### サービスアカウント認証

```javascript
// JSON キーから GoogleAuth インスタンス作成
new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
})
```

**ベストプラクティス:**
- ✅ JSON キーは環境変数に（コミットしない）
- ✅ Cloud Run のサービスアカウントに最小権限を付与
- ✅ Sheets の共有を「編集者」のみに限定

---

## 監視・ロギング

### Cloud Run ログ

```bash
gcloud run logs read receipt-log-bot --region asia-northeast1 --limit 50
```

### アプリケーションログ

```javascript
console.log("レシート記録完了:", storeName);
console.warn("プロフィール取得失敗:", err.message);
console.error("Gemini API エラー:", err);
```

---

## 本番環境での推奨設定

1. **Cloud Run:**
   - メモリ: 512 MB（デフォルト OK）
   - タイムアウト: 60秒（Gemini 待ち時間を考慮）
   - 並行実行: 80（デフォルト OK）

2. **エラー通知:**
   - Cloud Logging に ERROR を集約
   - 監視ダッシュボード作成（Cloud Monitoring）

3. **バージョン管理:**
   - Git タグで本番版を明記
   - Dockerfile レジストリ: Artifact Registry 推奨

