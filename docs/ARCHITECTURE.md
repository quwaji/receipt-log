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
                           │
        ┌──────────────────▼──────────────────┐
        │   Cloud Run                         │
        │ (receipt-log-bot)                   │
        │                                      │
        │  ┌─────────────────────────────┐   │
        │  │  Express Server (Port 8080)  │   │
        │  │  - /webhook      (POST)      │   │
        │  │  - /bank/import  (POST)      │   │
        │  │  - /card/import  (POST)      │   │
        │  │  - /health       (GET)       │   │
        │  └────────┬──────────┬──────────┘   │
        │           │          │              │
        │  ┌────────▼──────┐  ┌▼─────────────────────────────────┐  │
        │  │ lineHandler   │  │ bank/cardTransactionImporter      │  │
        │  ├───────────────┤  ├──────────────────────────────────┤  │
        │  │ • Image 取得  │  │ • CSV 取得 (Drive)               │  │
        │  │ • User 情報   │  │ • CSV パース                     │  │
        │  │ • orchestrate │  │ • 重複チェック                   │  │
        │  └────────┬──────┘  │ • Sheets 追記                   │  │
        │           │         │ • ログ記録                       │  │
        │  ┌────────┼─────────────────────────────────────┐    │  │
        │  ▼        ▼        ▼        ▼           ▼         ▼   │  │
        │ Gemini  Sheets  Drive    Sheets       Sheets    Sheets │  │
        │  API  (receipts) API  (bank trans) (card trans) (logs) │  │
        └──────────────────────────────────────────────────────┘
```

## コンポーネント詳細

### 1. Cloud Run (Express Server)

**役割:** LINE Webhook・銀行インポート・カードインポートリクエストを受け取り、各サービスを調整

**エンドポイント:**
- `POST /webhook` — LINE のイベント受信（middleware で署名検証）
- `POST /bank/import` — 銀行取引 CSV インポート
- `POST /card/import` — カード利用明細 CSV インポート
- `GET /health` — ヘルスチェック

**環境変数:**
```
LINE_CHANNEL_SECRET          # Webhook 署名検証用
LINE_CHANNEL_ACCESS_TOKEN    # メッセージ送受信
GEMINI_API_KEY               # Gemini API 認証
SPREADSHEET_ID               # Google Sheets ID
SHEET_NAME                   # receipts シート名（default: receipts）
BANK_TRANS_SHEET_NAME        # 銀行取引シート名（default: bank trans）
CARD_TRANS_SHEET_NAME        # カード取引シート名（default: card trans）
LOGS_SHEET_NAME              # ログシート名（default: logs）
CATEGORY_RULES_SHEET_NAME    # カテゴリルールシート名（default: category rules）
BANK_FOLDER_ID               # 銀行 CSV を置く Google Drive フォルダ ID
CARD_FOLDER_ID               # カード CSV を置く Google Drive フォルダ ID
GOOGLE_SERVICE_ACCOUNT_JSON  # GCP サービスアカウント認証情報
```

---

### 2. LINE Handler (`src/lineHandler.js`)

**フロー:**

```
Event 受信
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
            → {storeName, totalAmount, paymentDate, paymentMethod, items}
      ↓
  [支払い日時フォールバック]
      └─ paymentDate が null → 受信日時を使用、備考にメモ
      ↓
  [カテゴリ自動判定]
      └─ categorizeTransactions(spreadsheetId, [storeName])
            → ルール照合（部分一致）→ 未知の場合 Gemini バッチ処理
      ↓
  [Sheets に記録]
      └─ logToSheet({receivedAt, paymentDate, userId, displayName,
                      groupId, storeName, totalAmount, paymentMethod, items, remarks, categoryAuto})
      ↓
  [返信を送信]
      └─ replyMessage(replyToken, text)
```

---

### 3. Gemini Parser (`src/geminiParser.js`)

**モデル:** Gemini 2.5 Flash

**入力:** レシート画像（Buffer）

**出力:**
```json
{
  "storeName": "セブン-イレブン",
  "totalAmount": 1280,
  "paymentDate": "2026/04/10 15:32",
  "paymentMethod": "現金",
  "items": "おにぎり 150円\nコーヒー 180円\n..."
}
```

**paymentMethod のルール:**
- クレジット・デビット・電子マネー・QR決済 → 「カード」
- 判断できない場合 → 「現金」

---

### 4. Sheets Logger (`src/sheetsLogger.js`)

**receipts シートのレコード形式:**

| A | B | C | D | E | F | G | H | I | J | K |
|---|---|---|---|---|---|---|---|---|---|---|
| 受信日時 | 支払い日時 | LINE UserID | 表示名 | グループID | 店名 | 合計金額 | 支払い方法 | 品目 | 備考 | カテゴリ |

---

### 5. カテゴリサービス (`src/categoryService.js`)

**役割:** レシート・銀行・カードの全トランザクションにカテゴリを自動付与

**フロー:**

```
[category rules シートからルール読み込み]
  ↓
[各トランザクションをルール照合（部分一致）]
  ├─ 一致 → カテゴリ確定
  └─ 不一致 → 未知リストへ
      ↓
  [未知の店名を Gemini バッチ処理]
      └─ 1リクエストで複数店名を一括判定
      ↓
  [新規ルールを category rules シートに追記]
      └─ {キーワード, カテゴリ, 登録日時, "Gemini"}
```

**カテゴリ一覧:**
`食費 / 日用品 / 交通費 / 通信費 / 光熱費 / 医療 / 娯楽 / 衣類 / 教育 / 保険 / 住居費 / その他`

**設計のポイント:**
- 既知の店名はルールで即判定（Gemini 不使用）→ RPD 節約
- 未知の店名のみ Gemini バッチ処理（複数をまとめて 1 リクエスト）
- 判定結果を自動で rules シートに蓄積 → 次回以降はルール照合で完結

---

### 6. 銀行取引インポート・カード利用明細インポート

#### 銀行取引フロー（`POST /bank/import`）

```
[マッピング設定読み込み]
  └─ Google Drive: bank_mapping.json
        → {bankName, encoding, skipHeaderRow, skipFooterRow, columns}
  ↓
[CSV ファイル一覧取得] → [既存トランザクション取得]
  ↓
[各 CSV ファイルを処理]
  ├─ パース (bankCsvParser)
  │    ├─ Shift-JIS デコード (iconv-lite)
  │    ├─ 半角カナ→全角変換・NFC 正規化
  │    └─ 年月日分割カラム対応
  ├─ 重複チェック: 取引日 + 金額 + 摘要 + 残高
  ├─ カテゴリ自動判定 (categoryService)
  │    └─ ルール照合 → 未知の店名のみ Gemini バッチ → category rules に蓄積
  ├─ Sheets 追記 (bank trans シート、G 列にカテゴリ)
  ├─ ファイル移動 (成功→処理済み / 失敗→要確認)
  └─ ログ記録 (logs シート、処理名: "bank trans")
```

#### カード利用明細フロー（`POST /card/import`）

```
[マッピング設定読み込み]
  └─ Google Drive: card_mapping.json
        → {cardName, encoding, skipHeaderRow, skipFooterRow, columns}
  ↓
[CSV ファイル一覧取得] → [既存トランザクション取得]
  ↓
[各 CSV ファイルを処理]
  ├─ パース (cardCsvParser)
  │    └─ encoding 指定に対応（楽天カードは UTF-8）
  ├─ 重複チェック: 利用日 + 利用店名 + 利用者 + 利用金額
  │    ※ファイル内の重複はすべて取り込み、Sheets 既存データのみスキップ
  ├─ カテゴリ自動判定 (categoryService)
  │    └─ ルール照合 → 未知の店名のみ Gemini バッチ → category rules に蓄積
  ├─ Sheets 追記 (card trans シート、J 列にカテゴリ)
  ├─ ファイル移動 (成功→処理済み / 失敗→要確認)
  └─ ログ記録 (logs シート、処理名: "card trans")
```

#### bank trans シートのレコード形式

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| 取引日 | 金額 | 区分 | 残高 | 摘要 | コメント | カテゴリ（自動）| 銀行名 |

#### card trans シートのレコード形式

| A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|
| 利用日 | 利用店名・商品名 | 利用者 | 支払方法 | 利用金額 | 手数料/利息 | 支払総額 | 支払月 | カード名 | カテゴリ |

#### category rules シートのレコード形式

| A | B | C | D |
|---|---|---|---|
| キーワード | カテゴリ | 登録日時 | ソース |

- **キーワード**: 店名の部分一致に使用する文字列
- **カテゴリ**: `食費 / 日用品 / 交通費 / 通信費 / 光熱費 / 医療 / 娯楽 / 衣類 / 教育 / 保険 / 住居費 / その他`
- **ソース**: `Gemini`（自動追加）または手動で入力

#### logs シートのレコード形式

| A | B | C | D | E | F | G | H | I |
|---|---|---|---|---|---|---|---|---|
| タイムスタンプ | 処理名 | 銀行名 | ファイル名 | ステータス | 総行数 | インポート行数 | 重複行数 | エラー |

#### マッピング設定ファイル（`bank_mapping.json`）

銀行フォルダに配置する JSON ファイル。銀行ごとに CSV の列構成を定義する。

```json
{
  "bankName": "埼玉りそな銀行",
  "encoding": "shift_jis",
  "skipHeaderRow": true,
  "skipFooterRow": true,
  "columns": {
    "取引日（年）": 14,
    "取引日（月）": 15,
    "取引日（日）": 16,
    "金額": 17,
    "区分": 13,
    "残高": 18,
    "摘要": 19,
    "コメント": 20
  }
}
```

取引日は単一カラム（`"取引日": 0`）でも年月日分割（`"取引日（年）"`, `"取引日（月）"`, `"取引日（日）"`）でも対応。

---

## セキュリティ

### LINE Webhook 署名検証

```javascript
app.post("/webhook", middleware(config), handler);
// X-Line-Signature ヘッダーが不正な場合は 401 返す
```

### サービスアカウント認証

```javascript
new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
  ]
})
```

**ベストプラクティス:**
- ✅ JSON キーは環境変数に（コミットしない）
- ✅ Cloud Run のサービスアカウントに最小権限を付与
- ✅ Sheets / Drive の共有を「編集者」のみに限定

---

## スケーラビリティ

| 指標 | 上限 | 説明 |
|------|------|------|
| Cloud Run 並行実行 | 80個 | デフォルト（無料枠内） |
| Gemini API (Free) | 20 req/日 | 無料枠 |
| Sheets API | 600 req/分 | API 仕様上の制限 |

---

## 本番環境での推奨設定

1. **Cloud Run:**
   - メモリ: 512 MB（デフォルト OK）
   - タイムアウト: 60秒（Gemini 待ち時間を考慮）

2. **エラー通知:**
   - Cloud Logging に ERROR を集約
   - 監視ダッシュボード作成（Cloud Monitoring）

3. **バージョン管理:**
   - Git タグで本番版を明記
