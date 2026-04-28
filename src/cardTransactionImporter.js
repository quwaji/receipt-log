const { google } = require("googleapis");
const { listCsvFiles, downloadFile, moveFile } = require("./bankDriveHelper");
const { loadCardMapping, parseCardCSV } = require("./cardCsvParser");
const { getExistingCardTransactions, filterCardDuplicates } = require("./cardTransactionDedup");
const { logResult } = require("./logger");
const { categorizeTransactions } = require("./categoryService");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
}

/**
 * サブフォルダを取得または作成
 */
async function getOrCreateSubfolder(auth, parentFolderId, folderName) {
  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.list({
    q: `'${parentFolderId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: "drive",
    fields: "files(id)",
    pageSize: 1,
  });

  if (response.data.files && response.data.files.length > 0) {
    return response.data.files[0].id;
  }

  const createResponse = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
  });

  return createResponse.data.id;
}

/**
 * カード利用明細 CSV をスプレッドシートにインポート
 * @param {string} spreadsheetId
 * @param {string} cardFolderId
 * @returns {Promise<Object>}
 */
async function importCardTransactions(spreadsheetId, cardFolderId) {
  const timestamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const results = [];

  try {
    const mapping = await loadCardMapping(cardFolderId);
    const cardName = mapping.cardName || "不明";

    const csvFiles = await listCsvFiles(cardFolderId);

    if (csvFiles.length === 0) {
      return {
        status: "success",
        message: "処理対象の CSV ファイルがありません",
        timestamp,
        results: [],
      };
    }

    const cardTransSheetName = process.env.CARD_TRANS_SHEET_NAME || "card trans";
    const existingTransactions = await getExistingCardTransactions(spreadsheetId, cardTransSheetName);

    const driveAuth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    const successFolderId = await getOrCreateSubfolder(driveAuth, cardFolderId, "処理済み");
    const failureFolderId = await getOrCreateSubfolder(driveAuth, cardFolderId, "要確認");

    for (const file of csvFiles) {
      const fileResult = await processSingleFile(
        file,
        spreadsheetId,
        mapping,
        cardName,
        existingTransactions,
        successFolderId,
        failureFolderId,
        timestamp
      );
      results.push(fileResult);
    }

    const successCount = results.filter((r) => r.status === "success").length;
    const failureCount = results.filter((r) => r.status === "failure").length;

    return {
      status: "completed",
      message: `${successCount}ファイル成功、${failureCount}ファイル失敗`,
      timestamp,
      results,
    };
  } catch (err) {
    console.error("カードインポート処理エラー:", err);
    return { status: "error", message: err.message, timestamp, results };
  }
}

/**
 * 単一 CSV ファイルを処理
 */
async function processSingleFile(
  file,
  spreadsheetId,
  mapping,
  cardName,
  existingTransactions,
  successFolderId,
  failureFolderId,
  timestamp
) {
  const fileResult = {
    fileName: file.name,
    status: "failure",
    totalRows: 0,
    importedRows: 0,
    duplicateRows: 0,
    errorMessage: "",
  };

  try {
    const csvBuffer = await downloadFile(file.id);
    const transactions = parseCardCSV(csvBuffer, mapping);
    fileResult.totalRows = transactions.length;

    // ファイル内の重複はそのまま、スプレッドシート既存データのみスキップ
    const { unique, duplicate } = filterCardDuplicates(transactions, existingTransactions);
    fileResult.duplicateRows = duplicate.length;

    if (unique.length > 0) {
      try {
        const descriptions = unique.map((t) => t.storeName);
        const categories = await categorizeTransactions(spreadsheetId, descriptions);
        unique.forEach((t, i) => { t.categoryAuto = categories[i]; });
      } catch (err) {
        console.warn("カード取引カテゴリ判定失敗:", err.message);
        unique.forEach((t) => { t.categoryAuto = "その他"; });
      }

      await appendCardTransactionsToSheet(spreadsheetId, cardName, unique);
      fileResult.importedRows = unique.length;

      // 次ファイル処理時の重複チェック用に追加
      existingTransactions.push(...unique);
    }

    await moveFile(file.id, successFolderId);
    fileResult.status = "success";

    await logResult(spreadsheetId, {
      processName: "card trans",
      bankName: cardName,
      timestamp,
      ...fileResult,
    });
  } catch (err) {
    console.error(`ファイル処理エラー (${file.name}):`, err);
    fileResult.errorMessage = err.message;

    try {
      await moveFile(file.id, failureFolderId);
      await logResult(spreadsheetId, {
        processName: "card trans",
        bankName: cardName,
        timestamp,
        ...fileResult,
      });
    } catch (moveErr) {
      console.error(`ファイル移動エラー (${file.name}):`, moveErr);
    }
  }

  return fileResult;
}

/**
 * カード取引をスプレッドシートに追記
 */
async function appendCardTransactionsToSheet(spreadsheetId, cardName, transactions) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = process.env.CARD_TRANS_SHEET_NAME || "card trans";

  const values = transactions.map((t) => [
    t.usageDate,
    t.storeName,
    t.user,
    t.paymentMethod,
    t.amount,
    t.fee,
    t.totalAmount,
    t.paymentMonth,
    cardName,
    t.categoryAuto ?? "",
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:J`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

module.exports = { importCardTransactions };
