require('dotenv').config({ path: process.env.DOTENV_PATH || '.env.local' });

const path = require("path");
const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const { handleEvent } = require("./lineHandler");
const { importBankTransactions } = require("./bankTransactionImporter");
const { importCardTransactions } = require("./cardTransactionImporter");
const { aggregateByMonth } = require("./aggregationService");
const { verifyLiffToken } = require("./liffAuth");
const { CATEGORIES } = require("./categoryService");
const { google } = require("googleapis");

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
  res.json({ liffId, authRequired, categories: CATEGORIES });
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
 * カテゴリ編集 API
 * PATCH /transaction
 * リクエストボディ: { source, rowIndex, category, oldCategory, displayName }
 */
const SHEET_META = {
  receipt: {
    nameEnv: "SHEET_NAME",
    nameDefault: "receipts",
    catCol: "K",
    noteCol: "M",
  },
  bank: {
    nameEnv: "BANK_TRANS_SHEET_NAME",
    nameDefault: "bank trans",
    catCol: "G",
    noteCol: "J",
  },
  card: {
    nameEnv: "CARD_TRANS_SHEET_NAME",
    nameDefault: "card trans",
    catCol: "J",
    noteCol: "L",
  },
};

app.patch("/transaction", express.json(), verifyLiffToken, async (req, res) => {
  const { source, rowIndex, category, oldCategory, displayName } = req.body;

  if (!SHEET_META[source]) {
    return res.status(400).json({ error: "source が不正です（receipt / bank / card）" });
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    return res.status(400).json({ error: "rowIndex が不正です" });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "category が不正です" });
  }

  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    return res.status(500).json({ error: "SPREADSHEET_ID が設定されていません" });
  }

  const { nameEnv, nameDefault, catCol, noteCol } = SHEET_META[source];
  const sheetName = process.env[nameEnv] || nameDefault;

  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // 既存の備考を読み取る
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!${noteCol}${rowIndex}`,
    });
    const existingNote = (getRes.data.values?.[0]?.[0] || "").trim();

    // 備考に追記（日時・ユーザー名・変更内容）
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const from = oldCategory || "（不明）";
    const newEntry = `${now} ${displayName || "不明"}: ${from}→${category}`;
    const updatedNote = existingNote ? `${existingNote}\n${newEntry}` : newEntry;

    // カテゴリと備考を一括更新
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `${sheetName}!${catCol}${rowIndex}`, values: [[category]] },
          { range: `${sheetName}!${noteCol}${rowIndex}`, values: [[updatedNote]] },
        ],
      },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("/transaction PATCH エラー:", err);
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
