# API ドキュメント

## エンドポイント一覧

| メソッド | パス | 説明 |
|---------|------|------|
| POST | `/webhook` | LINE Messaging API からのイベント受信 |
| POST | `/bank/import` | 銀行取引 CSV インポート |
| GET | `/health` | ヘルスチェック |

---

## POST /webhook

LINE Messaging API からのイベントを受け取ります。

**リクエスト:**

```
POST https://{cloud-run-url}/webhook
Content-Type: application/json
X-Line-Signature: {署名}
```

**リクエストボディ:**

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
      "message": {
        "type": "image",
        "id": "100001"
      }
    }
  ]
}
```

**レスポンス:**

- `200 OK` — 受信完了（イベント処理は非同期で継続）
- `400 Bad Request` — 不正なリクエスト形式
- `401 Unauthorized` — 署名検証失敗

**処理フロー:**

1. LINE Webhook を受け取り即座に 200 を返す（タイムアウト防止）
2. バックグラウンドで画像解析・Sheets 記録・返信を実行

---

## POST /bank/import

Google Drive の指定フォルダにある CSV ファイルを読み込み、bank trans シートにインポートします。

**リクエスト:**

```
POST https://{cloud-run-url}/bank/import
Content-Type: application/json
```

**リクエストボディ（省略可）:**

```json
{
  "spreadsheetId": "1V3GW_...",
  "bankFolderId": "1abc..."
}
```

省略した場合は環境変数 `SPREADSHEET_ID` / `BANK_FOLDER_ID` を使用。

**レスポンス（成功）:**

```json
{
  "status": "completed",
  "message": "2ファイル成功、0ファイル失敗",
  "timestamp": "2026/04/27 10:00:00",
  "results": [
    {
      "fileName": "202604.csv",
      "status": "success",
      "totalRows": 42,
      "importedRows": 40,
      "duplicateRows": 2,
      "errorMessage": ""
    }
  ]
}
```

**レスポンス（エラー）:**

```json
{
  "status": "error",
  "message": "bank_mapping.json が見つかりません"
}
```

**フォルダ構成:**

```
{BANK_FOLDER_ID}/
├── bank_mapping.json   # マッピング設定（必須）
├── 202604.csv          # インポート対象 CSV
└── 処理済み/           # 成功ファイルの移動先（自動作成）
└── 要確認/             # 失敗ファイルの移動先（自動作成）
```

---

## LINE Bot の返信フォーマット

### 成功時

```
✅ 記録しました！

👤 {displayName}
🏪 {storeName}
🗓 {paymentDate}
💴 {totalAmount} 円（{paymentMethod}）
🛒 {items}
📝 {remarks}  ← 支払い日時が読み取れなかった場合のみ表示
```

**例:**
```
✅ 記録しました！

👤 田中太郎
🏪 セブン-イレブン
🗓 2026/04/10 15:32
💴 1,280 円（現金）
🛒 おにぎり、コーヒー、弁当
```

**支払い日時が読み取れない場合:**
```
✅ 記録しました！

👤 田中太郎
🏪 セブン-イレブン
🗓 2026/04/27 10:15:33
💴 980 円（カード）
🛒 サンドイッチ、お茶
📝 支払い日時はレシートから読み取れなかったため受信日時を使用
```

### エラー時

```
画像の取得に失敗しました。
レシートの読み取りに失敗しました。
スプレッドシートへの記録に失敗しました。
```

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
  "paymentDate": "2026/04/10 15:32",
  "paymentMethod": "現金",
  "items": "おにぎり 150円\nサンドイッチ 300円\nコーヒー 180円"
}
```

### フィールド仕様

| フィールド | 型 | 説明 | 読み取れない場合 |
|-----------|-----|------|--------------|
| `storeName` | string\|null | 店名 | null |
| `totalAmount` | number\|null | 合計金額（税込み、円） | null |
| `paymentDate` | string\|null | 支払い日時（YYYY/MM/DD HH:mm または YYYY/MM/DD） | null → 受信日時を使用 |
| `paymentMethod` | string | 「現金」または「カード」 | 「現金」 |
| `items` | string\|null | 品目リスト（改行区切り） | null |

---

## Google Sheets スキーマ

### receipts シート（レシート記録）

追記範囲: `{SHEET_NAME}!A:J`

| 列 | タイプ | 項目 | 例 |
|----|--------|------|----|
| A | String | 受信日時 | `2026/04/10 15:33:01` |
| B | String | 支払い日時 | `2026/04/10 15:32` |
| C | String | LINE UserID | `U1234567890abcdef...` |
| D | String | 表示名 | `田中太郎` |
| E | String | グループID | `C1234567890abcdef...` |
| F | String | 店名 | `セブン-イレブン新宿店` |
| G | Number | 合計金額（円）| `1280` |
| H | String | 支払い方法 | `現金` |
| I | String | 品目（改行区切り）| `おにぎり 150円\nコーヒー 180円` |
| J | String | 備考 | `支払い日時はレシートから読み取れなかったため受信日時を使用` |

### bank trans シート（銀行取引）

追記範囲: `{BANK_TRANS_SHEET_NAME}!A:H`

| 列 | タイプ | 項目 | 例 |
|----|--------|------|----|
| A | String | 取引日 | `2026/04/10` |
| B | Number | 金額 | `-1280` |
| C | String | 区分 | `支払い` |
| D | Number | 残高 | `125000` |
| E | String | 摘要 | `セブンイレブン新宿店` |
| F | String | コメント | `` |
| G | String | カテゴリ（自動）| `` |
| H | String | 銀行名 | `共通口座（埼玉りそな）` |

### logs シート（インポート処理ログ）

追記範囲: `{LOGS_SHEET_NAME}!A:I`

| 列 | タイプ | 項目 | 例 |
|----|--------|------|----|
| A | String | タイムスタンプ | `2026/04/27 10:00:00` |
| B | String | 処理名 | `bank trans` |
| C | String | 銀行名 | `共通口座（埼玉りそな）` |
| D | String | ファイル名 | `202604.csv` |
| E | String | ステータス | `success` |
| F | Number | 総行数 | `42` |
| G | Number | インポート行数 | `40` |
| H | Number | 重複行数 | `2` |
| I | String | エラーメッセージ | `` |

---

## LINE グループ内での動作

### ユーザー情報取得

| シチュエーション | API メソッド | 取得情報 |
|---|---|---|
| グループ | `getGroupMemberProfile(groupId, userId)` | グループ内の表示名 |
| 1対1チャット | `getProfile(userId)` | LINE プロフィール名 |

---

## レート制限

### Gemini API（Free tier）

| 指標 | 上限 |
|------|------|
| RPM（リクエスト/分）| 5 |
| TPM（トークン/分）| 250,000 |
| RPD（リクエスト/日）| 20 |

### Google Sheets API

```
600 リクエスト/分 (per project)
```

---

## トラブルシューティング

### Webhook が呼ばれない

1. `gcloud run logs read receipt-log-bot` でログ確認
2. LINE Webhook URL が正しいか確認
3. Channel Secret / Access Token の有効期限確認

### "Hmac signature does not match"

- Webhook 署名検証失敗 → Channel Secret が間違っている可能性

### スプレッドシートに記録されない

- サービスアカウントがシートの編集権限を持つか確認
- Spreadsheet ID / Sheet Name が正しいか確認

### Gemini 429 エラー

- Free tier の RPD（20件/日）を超過している可能性
- AI Studio の Rate Limit ページで使用量を確認: https://aistudio.google.com/app/rate-limit

### bank/import でファイルが見つからない

- `bank_mapping.json` がフォルダ直下に配置されているか確認
- サービスアカウントに Drive の閲覧・編集権限があるか確認
