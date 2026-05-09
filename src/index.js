require('dotenv').config({ path: process.env.DOTENV_PATH || '.env.local' });

const path = require("path");
const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const { handleEvent } = require("./lineHandler");
const { importBankTransactions } = require("./bankTransactionImporter");
const { importCardTransactions } = require("./cardTransactionImporter");
const { aggregateByMonth } = require("./aggregationService");
const { verifyLiffToken } = require("./liffAuth");

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const app = express();

// 静的ファイル配信（SPA）
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/webhook", middleware(config), (req, res) => {
  // すぐにレスポンスを返す（LINE のタイムアウト防止）
  res.status(200).send("OK");

  // イベント処理は非同期で実行（バックグラウンド）
  req.body.events.forEach((event) => {
    handleEvent(event, new Client(config)).catch((err) => {
      console.error("イベント処理エラー:", err);
    });
  });
});

/**
 * SPA に LIFF ID を渡すための公開設定エンドポイント
 * GET /config
 */
app.get("/config", (req, res) => {
  const liffUrl = process.env.LIFF_URL || "";
  const liffId = liffUrl.replace("https://liff.line.me/", "") || null;
  const authRequired =
    process.env.NODE_ENV === "production" && !!process.env.LIFF_CHANNEL_ID;
  res.json({ liffId, authRequired });
});

/**
 * 月別集計 API
 * GET /summary?month=YYYY-MM
 */
app.get("/summary", verifyLiffToken, async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "month パラメータが必要です（例: 2026-04）" });
  }
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    return res.status(500).json({ error: "SPREADSHEET_ID が設定されていません" });
  }
  try {
    const data = await aggregateByMonth(spreadsheetId, month);
    res.json(data);
  } catch (err) {
    console.error("/summary エラー:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 銀行取引CSVのインポート
 * POST /bank/import
 * リクエストボディ: { spreadsheetId: "...", bankFolderId: "..." }
 */
app.post("/bank/import", express.json(), async (req, res) => {
  try {
    const spreadsheetId = req.body.spreadsheetId || process.env.SPREADSHEET_ID;
    const bankFolderId = req.body.bankFolderId || process.env.BANK_FOLDER_ID;

    if (!spreadsheetId || !bankFolderId) {
      return res.status(400).json({
        status: "error",
        message: "spreadsheetId または bankFolderId が指定されていません",
      });
    }

    console.log(
      `銀行取引インポート開始: spreadsheetId=${spreadsheetId}, bankFolderId=${bankFolderId}`
    );

    const result = await importBankTransactions(spreadsheetId, bankFolderId);

    res.status(200).json(result);
  } catch (err) {
    console.error("/bank/import エラー:", err);
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

/**
 * カード利用明細CSVのインポート
 * POST /card/import
 * リクエストボディ: { spreadsheetId: "...", cardFolderId: "..." }
 */
app.post("/card/import", express.json(), async (req, res) => {
  try {
    const spreadsheetId = req.body.spreadsheetId || process.env.SPREADSHEET_ID;
    const cardFolderId = req.body.cardFolderId || process.env.CARD_FOLDER_ID;

    if (!spreadsheetId || !cardFolderId) {
      return res.status(400).json({
        status: "error",
        message: "spreadsheetId または cardFolderId が指定されていません",
      });
    }

    console.log(
      `カード取引インポート開始: spreadsheetId=${spreadsheetId}, cardFolderId=${cardFolderId}`
    );

    const result = await importCardTransactions(spreadsheetId, cardFolderId);

    res.status(200).json(result);
  } catch (err) {
    console.error("/card/import エラー:", err);
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.get("/health", (_req, res) => res.send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
