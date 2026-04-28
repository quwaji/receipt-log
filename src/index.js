require('dotenv').config({ path: process.env.DOTENV_PATH || '.env.local' });

const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const { handleEvent } = require("./lineHandler");
const { importBankTransactions } = require("./bankTransactionImporter");
const { importCardTransactions } = require("./cardTransactionImporter");

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const app = express();

// ボディパーサーの設定
app.use(express.json());

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
 * 銀行取引CSVのインポート
 * POST /bank/import
 * リクエストボディ: { spreadsheetId: "...", bankFolderId: "..." }
 */
app.post("/bank/import", async (req, res) => {
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
app.post("/card/import", async (req, res) => {
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
