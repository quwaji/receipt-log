# LINE Bot API ドキュメント

## Webhook エンドポイント

### POST /webhook

LINE Messaging API からのイベントを受け取ります。

**リクエスト:** 

```
POST https://{cloud-run-url}/webhook
Content-Type: application/json
X-Line-Signature: {署名}
```

**リクエストボディ：**

```json
{
  "events": [
    {
      "type": "message",
      "source": {
        "type": "group",
        "groupId": "C1234567890abcdef1234567890abcd",
        "userId": "U1234567890abcdef1234567890abcd"
      },
      "replyToken": "nHuyWiB7yP5Zw52FIkcQT",
      "timestamp": 1462629479859,
      "message": {
        "type": "image",
        "id": "100001"
      }
    }
  ]
}
```

**レスポンス:**

- **成功時 (200 OK):**
  ```
  OK
  ```

- **失敗時:**
  - `400 Bad Request` — 不正なリクエスト形式
  - `401 Unauthorized` — 署名検証失敗
  - `500 Internal Server Error` — サーバーエラー

---

## イベント種別

### 画像メッセージ（処理対象）

```json
{
  "type": "message",
  "message": {
    "type": "image",
    "id": "message_id"
  }
}
```

**処理:**
1. メッセージID から BASE64 画像データを取得
2. Gemini API で解析
3. Google Sheets に記録
4. ユーザーに返信

### その他のメッセージ

テキスト、スタンプ、位置情報など → **無視**

---

## LINE Bot の返信フォーマット

### 成功時

```
✅ 記録しました！

👤 {displayName}
🏪 {storeName}
💴 {totalAmount} 円
🛒 {items}
```

**例:**
```
✅ 記録しました！

👤 田中太郎
🏪 セブン-イレブン
💴 1,280 円
🛒 おにぎり、コーヒー、弁当
```

### エラー時

```
【エラータイプ】
- 画像の取得に失敗しました。
- レシートの読み取りに失敗しました。
- スプレッドシートへの記録に失敗しました。
```

---

## LINE グループ内での動作

### グループメッセージ処理フロー

```
グループ
  └─ ボットをメンバーとして追加
  └─ 画像メッセージ送信
       └─ source.type: "group"
       └─ source.groupId: グループID
       └─ source.userId: 送信者ID
         ↓
Bot が以下を実行:
  1. getGroupMemberProfile(groupId, userId)
     → グループ内でのユーザー表示名取得
  2. getMessageContent(messageId)
     → 画像データ取得
  3. 解析・記録
  4. replyMessage(replyToken, message)
     → グループ内で返信
```

### ユーザー情報取得

|シチュエーション | API メソッド | 取得情報 |
|---|---|---|
| グループ | `getGroupMemberProfile()` | グループ内の表示名 |
| 1対1チャット | `getProfile()` | LINEプロフィール名 |

---

## Google Sheets ス키ーマ

### 追記対象範囲

```
Range: {SHEET_NAME}!A:F
```

例: `receipts!A:F`

### 列定義

| 列 | タイプ | 説明 | 例 |
|----|--------|------|-----|
| A | String | タイムスタンプ | `2026-04-10 15:30:45` |
| B | String | LINE User ID | `U1234567890abcdef1234567890abcd` |
| C | String | 表示名 | `田中太郎` |
| D | String | 店名 | `セブン-イレブン新宿店` |
| E | Number | 合計金額（円） | `1280` |
| F | String | 品目（改行区切り） | `おにぎり 150円\nコーヒー 180円\nお菓子 320円` |

### 追記時の値処理

```javascript
[
  [
    timestamp,           // "2026-04-10 15:30:45" (String)
    userId,             // "U1234567890..." (String)
    displayName,        // "田中太郎" (String)
    storeName ?? "",    // "" if null (String)
    totalAmount ?? "",  // "" if null (可変 - Numbers)
    items ?? ""         // "" if null (String with newlines)
  ]
]
```

**注意:**
- null 値は空文字列に変換
- 改行は `\n` のまま保持（Sheets で複数行表示）
- `valueInputOption: "USER_ENTERED"` で自動フォーマット

---

## Gemini API 解析結果

### リクエスト

```javascript
{
  inlineData: {
    data: imageBuffer.toString("base64"),
    mimeType: "image/jpeg"
  }
}
```

対応フォーマット: `image/jpeg`, `image/png`, `image/gif`, `image/webp`

### レスポンス（JSON）

```json
{
  "storeName": "セブン-イレブン",
  "totalAmount": 1280,
  "items": "おにぎり 150円\nサンドイッチ 300円\nコーヒー 180円"
}
```

### NULL値の処理

値が読み取れない場合:

```json
{
  "storeName": null,
  "totalAmount": null,
  "items": "品目リスト（テキスト）"
}
```

アプリケーション側で `?? ""` で空文字列に統一

---

## エラーハンドリング

### ユースケース別の対応

#### 1. プロフィール取得失敗

```
console.warn("プロフィール取得失敗:", err.message);
displayName = "不明";  // フォールバック
// 処理続行
```

#### 2. 画像取得失敗

```
console.error("画像取得失敗:", err);
// replyMessage: "画像の取得に失敗しました。"
// 処理終了
```

#### 3. Gemini 解析失敗

```
console.error("レシート解析失敗:", err);
// replyMessage: "レシートの読み取りに失敗しました。"
// 処理終了
```

#### 4. Sheets 記録失敗

```
console.error("スプレッドシート記録失敗:", err);
// replyMessage: "スプレッドシートへの記録に失敗しました。"
// 処理終了
```

---

## レート制限

### LINE Messaging API

| 操作 | レート制限 |
|------|----------|
| メッセージ送信 | 無制限（Reply は無料） |
| メッセージコンテンツ取得 | 無制限 |
| メンバープロフィール取得 | 無制限 |

### Gemini API（無料枠）

```
15 RPM (Requests Per Minute)
1,500 RPD (Requests Per Day)

月間上限なし
```

**1グループ 100人 × 20 画像/日 = 2,000 req/日 → 超過**

調整方法:
- 無料から有料プランへ移行
- Vision API 切り替え（$1.5/1K）
- リクエスト数を削減

### Google Sheets API

```
600 リクエスト/分 (per project)
```

現在の実装では 1リクエスト/メッセージなので問題なし

---

## ローカルテスト

### ngrok で LINE Webhook を模擬

```bash
# ターミナル 1: ngrok 起動
ngrok http 8080

# Forwarding: https://xxxx-mmmm-nn.ngrok.io → http://localhost:8080

# ターミナル 2: アプリ起動
npm run dev

# LINE Developers Console で Webhook URL を更新
# https://xxxx-mmmm-nn.ngrok.io/webhook
```

### テストリクエスト例

```bash
curl -X POST https://xxxx-mmmm-nn.ngrok.io/webhook \
  -H "Content-Type: application/json" \
  -H "X-Line-Signature: {signature}" \
  -d '{
    "events": [{
      "type": "message",
      "source": {"type": "user", "userId": "U..."},
      "replyToken": "nHuyWiB7yP...",
      "message": {"type": "image", "id": "100001"}
    }]
  }'
```

**注:** 本来の署名は LINE が生成するので、実際には LINE アプリから画像を送るのが簡単

---

## トラブルシューティング

### Webhook が呼ばれない

1. `gcloud run logs read receipt-log-bot` でログ確認
2. LINE Webhook URL が正しいか確認
3. Channel Secret / Access Token の有効期限確認

### "Hmac signature does not match"

- Webhook 署名検証失敗
- Channel Secret が間違っている可能性

### スプレッドシートに記録されない

- サービスアカウントがシートの編集権限を持つか確認
- Spreadsheet ID / Sheet Name が正しいか確認

### Gemini が "invalid_request_error"

- API キーが無効
- 画像フォーマットが対応していない（JPEG/PNG 推奨）
- Base64 エンコードの誤り
