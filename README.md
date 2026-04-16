# Receipt Log Bot

LINE グループ内で共有されたレシート画像を自動で解析し、Google Sheets に記録する Bot です。

## 特徴

- **無料で運用可能** — Cloud Run の無料枠内で動作
- **グループ対応** — 誰がレシートを申告したかを自動記録
- **自動解析** — Gemini API でレシート情報を構造化データに変換
- **スプレッドシート統合** — リアルタイムでレシート情報を集計できる

## 使い方

### ボットをグループに追加

LINE アプリでボットを招待するだけで OK。

### レシートを送信

グループ内でレシート画像を送ると、ボットが自動で：

1. 画像内の店名・金額・品目を認識
2. 送信者の名前と USER ID を記録
3. Google Sheets に追記
4. スプレッドシート記録完了を返信

```
✅ 記録しました！

👤 田中太郎
🏪 セブン-イレブン
💴 1,280 円
🛒 おにぎり、コーヒー、弁当
```

## システム構成

```
LINE Bot
  ↓ (webhook)
├─ Cloud Run (Express)
   ├─ Gemini 2.5 Flash (レシート解析)
   └─ Google Sheets API (記録)
```

**無料枠:**
- Cloud Run: 200万リクエスト/月
- Gemini API: 1,500リクエスト/日
- Google Sheets API: 制限なし
- LINE Messaging API: 返信メッセージは無料

## ファイル構成

```
src/
├── index.js         # Express サーバー + Webhook エンドポイント
├── lineHandler.js   # LINE イベント処理（画像受信・ユーザー取得）
├── geminiParser.js  # Gemini で画像をレシートデータに変換
└── sheetsLogger.js  # Google Sheets に記録

docs/
├── SETUP.md         # セットアップ手順
├── ARCHITECTURE.md  # システム設計書
├── API.md           # API 仕様書
└── QUICKREF.md      # 開発用チートシート

package.json         # 依存パッケージ
Dockerfile          # Cloud Run デプロイ用
.env.example        # 環境変数テンプレート
README.md           # このファイル
```

## クイックスタート

1. [docs/SETUP.md](./docs/SETUP.md) に従って GCP プロジェクトを作成
2. LINE Developers で Messaging API チャンネルを追加
3. `gcloud run deploy --source .` でデプロイ
4. Webhook URL を LINE に設定
5. ボットをグループに追加

## 技術スタック

- **Node.js 20** — バックエンド
- **Express** — Web 框架
- **@line/bot-sdk** — LINE Messaging API クライアント
- **@google/generative-ai** — Gemini API クライアント
- **googleapis** — Google Sheets API クライアント
- **Cloud Run** — ホスティング

## 費用

月間 100 件のレシート申告の場合：

| 項目 | 費用 |
|------|------|
| Cloud Run | 0円（無料枠内） |
| Gemini API | 100 × ¥0.075 = ¥7.5 |
| Google Sheets API | 0円 |
| **合計** | **¥7.5/月程度** |

## トラブルシューティング

異常系の対応は `lineHandler.js` で実装済み：

- 画像取得失敗 → ユーザーに通知
- レシート解析失敗 → ユーザーに通知
- スプレッドシート記録失敗 → ユーザーに通知
- プロフィール取得失敗 → 「不明」として続行

## 今後の拡張案

- 複数画像の一括送信対応
- 月別・ユーザー別の集計ダッシュボード
- カテゴリー分類の自動化
- 領収書の PDF 出力

---

質問や機能リクエストは Issue を作成してください。
