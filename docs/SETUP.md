# セットアップ手順

## 1. GCP プロジェクト作成

```bash
# プロジェクト作成（project-id は任意）
gcloud projects create receipt-log-bot --name="Receipt Log Bot"
gcloud config set project receipt-log-bot

# 課金アカウントをリンク（Cloud Run に必要）
# → GCP コンソール > 課金 からリンク

# 必要な API を有効化
gcloud services enable \
  run.googleapis.com \
  sheets.googleapis.com \
  generativelanguage.googleapis.com
```

## 2. Google サービスアカウントの作成

**（Gemini API・Sheets API 両方で必要なため、先に作成）**

```bash
# サービスアカウント作成
gcloud iam service-accounts create receipt-bot-sa \
  --display-name="Receipt Bot Service Account"

# JSON キーを発行
gcloud iam service-accounts keys create sa-key.json \
  --iam-account=receipt-bot-sa@receipt-log-bot.iam.gserviceaccount.com

# 確認
cat sa-key.json | head -3
```

## 3. Gemini API キーの取得

### ✅ Workspace 有料版（Business Standard 以上）の場合

1. GCP コンソール > APIs & Services > Credentials
2. 「認証情報を作成」 > 「API キー」
3. 右側パネルで「このキーを使用してアクセスできる API」から **Gemini API** をチェック
4. 「作成」ボタン
5. 表示されたキーをコピー

### ⚠️ Workspace 無償版（Essential Starter）の場合

**Workspace 無償版では Gemini API が利用できません。**  
以下のいずれかを選択：

**オプション A: 個人 Gmail で取得（推奨 - ローカルテスト用）**

```bash
# 1. 個人 Google アカウント（@gmail.com）でログイン
# 2. https://aistudio.google.com/app/apikey を開く
# 3. 「Create API key」をクリック
# 4. キーをコピー（AIzaSy...）
```

**オプション B: Workspace をアップグレード（本番推奨）**

```
Google Admin Console > お支払い > サブスクリプション
  → 「購入またはアップグレード」
  → Business Standard 以上に変更
  → Gemini API が有効化可能に
```

### キーを保存

```bash
# .env に後で設定
GEMINI_API_KEY=AIzaSy...
```

## 4. Google スプレッドシートの準備

1. Google スプレッドシートを新規作成
2. シート名を `receipts` に変更
3. 1行目にヘッダーを入力：
   `日時` / `LINE UserID` / `表示名` / `店名` / `合計金額（円）` / `品目`
4. URLから Spreadsheet ID をコピー
   例: `https://docs.google.com/spreadsheets/d/【ここがID】/edit`
5. スプレッドシートをサービスアカウントのメールアドレスに共有（編集者）
   メールアドレス: `receipt-bot-sa@receipt-log-bot.iam.gserviceaccount.com`

## 5. LINE Messaging API チャンネルの設定

1. LINE Developers コンソール でチャンネル作成（Messaging API）
2. 「チャンネル基本設定」→ **Channel secret** をコピー
3. 「Messaging API設定」→ **Channel access token（長期）** を発行してコピー
4. 「グループ・複数人チャットへの参加を許可する」を **ON** に設定
5. Webhook URL は後でデプロイ後に設定

## 6. .env ファイルの準備

```bash
# テンプレートをコピー
cp .env.example .env

# 各値を埋める
nano .env
```

**.env の内容:**

```bash
LINE_CHANNEL_SECRET=【LINE Developers > Channel secret】
LINE_CHANNEL_ACCESS_TOKEN=【LINE Developers > Channel access token】
GEMINI_API_KEY=【Step 3で取得した API キー】
SPREADSHEET_ID=【Step 4の Google Sheets ID】
SHEET_NAME=receipts

# sa-key.json を1行に圧縮して設定
GOOGLE_SERVICE_ACCOUNT_JSON=【以下の方法で取得】
```

**sa-key.json を1行に圧縮:**

```bash
cat sa-key.json | tr -d '\n'
# 出力: {"type":"service_account","project_id":...}
# これをコピーして .env の GOOGLE_SERVICE_ACCOUNT_JSON に貼り付け
```

## 7. ローカル環境で動作確認（推奨）

### 要件

- Node.js 20+
- ngrok（無料アカウント）
- npm

### セットアップ

```bash
# 1. ngrok に認証
ngrok config add-authtoken {your-authtoken}

# 2. npm 依存関係をインストール
npm install

# 3. ターミナル 1: ngrok で外部公開
ngrok http 8080
# https://xxx-yyy-zzz.ngrok.io -> http://localhost:8080

# 4. ターミナル 2: ローカルアプリ起動
npm run dev
# Listening on port 8080

# 5. ターミナル 3: LINE Webhook URL を設定
# LINE Developers > Messaging API設定
# Webhook URL: https://xxx-yyy-zzz.ngrok.io/webhook
# 「検証」ボタン → 200 OK 確認
```

### テスト

グループまたは 1 対 1 チャットでレシート画像を送信 → ボットが返信 OK

---

## 8. Cloud Run へのデプロイ

```bash
# sa-key.json の中身を1行に圧縮
SERVICE_ACCOUNT_JSON=$(cat sa-key.json | tr -d '\n')

# Cloud Run にデプロイ
gcloud run deploy receipt-log-bot \
  --source . \
  --region asia-northeast1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars="LINE_CHANNEL_SECRET=【チャンネルシークレット】" \
  --set-env-vars="LINE_CHANNEL_ACCESS_TOKEN=【アクセストークン】" \
  --set-env-vars="GEMINI_API_KEY=【Gemini APIキー】" \
  --set-env-vars="SPREADSHEET_ID=【スプレッドシートID】" \
  --set-env-vars="SHEET_NAME=receipts" \
  --set-env-vars="GOOGLE_SERVICE_ACCOUNT_JSON=$SERVICE_ACCOUNT_JSON"
```

デプロイ完了後、表示される URL（例: `https://receipt-log-bot-xxxx-an.a.run.app`）をコピー。

## 9. LINE Webhook URL を本番環境に設定

1. LINE Developers コンソール →「Messaging API設定」
2. Webhook URL に `https://【CloudRunのURL】/webhook` を入力
3. 「検証」ボタンで接続確認 → 200 OK が返れば OK
4. 「Webhookの利用」を **ON** に設定

## 10. ボットをグループに追加

LINE アプリからボットをグループに招待するだけで動作します。

---

## トラブルシューティング

### Gemini API キーが作成できない

- **Workspace 無償版** → オプション A（個人 Gmail）を使用
- **Workspace 有料版** → Admin Console で Gemini API が有効か確認

### スプレッドシートに記録されない

- サービスアカウントメールがシートで編集者権限を持つか確認
- Spreadsheet ID が正しいか確認
- `gcloud run logs read receipt-log-bot` でエラーを確認

### ローカルテストが繋がらない

- ngrok が起動しているか確認: `ngrok http 8080`
- LINE Webhook URL が ngrok の URL に設定されているか確認
- `.env` の LINE_CHANNEL_SECRET / ACCESS_TOKEN が正しいか確認
