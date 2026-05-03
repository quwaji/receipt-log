const { google } = require("googleapis");
const { listCsvFiles, downloadFile, moveFile } = require("./bankDriveHelper");
const { loadBankMapping, parseCSV } = require("./bankCsvParser");
const {
  getExistingTransactions,
  filterDuplicates,
} = require("./bankTransactionDedup");
const { logResult } = require("./logger");
const { categorizeTransactions } = require("./categoryService");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
}

/**
 * サブフォルダを取得または作成
 */
async function getOrCreateSubfolder(auth, parentFolderId, folderName) {
  const drive = google.drive({ version: "v3", auth: auth });

  // 既存フォルダを確認
  const response = await drive.files.list({
    q: `'${parentFolderId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    spaces: "drive",
    fields: "files(id)",
    pageSize: 1,
  });

  if (response.data.files && response.data.files.length > 0) {
    return response.data.files[0].id;
  }

  // フォルダを作成
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
 * 銀行取引CSVをスプレッドシートにインポート
 * @param {string} spreadsheetId - スプレッドシートID
 * @param {string} bankFolderId - 銀行フォルダID
 * @returns {Promise<Object>} インポート結果
 */
async function importBankTransactions(spreadsheetId, bankFolderId) {
  const timestamp = new Date().toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });
  const results = [];

  try {
    // マッピング設定を読み込む
    const mapping = await loadBankMapping(bankFolderId);
    const bankName = mapping.bankName || "不明";

    // CSVファイル一覧を取得
    const csvFiles = await listCsvFiles(bankFolderId);

    if (csvFiles.length === 0) {
      return {
        status: "success",
        message: "処理対象のCSVファイルがありません",
        timestamp,
        results: [],
      };
    }

    // 既存トランザクションを取得
    const bankTransSheetName = process.env.BANK_TRANS_SHEET_NAME || "bank trans";
    const existingTransactions = await getExistingTransactions(
      spreadsheetId,
      bankTransSheetName
    );

    // サブフォルダを取得・作成
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    const successFolderId = await getOrCreateSubfolder(
      auth,
      bankFolderId,
      "処理済み"
    );
    const failureFolderId = await getOrCreateSubfolder(
      auth,
      bankFolderId,
      "要確認"
    );

    // 各CSVファイルを処理
    for (const file of csvFiles) {
      const fileResult = await processSingleFile(
        file,
        spreadsheetId,
        mapping,
        bankName,
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
    console.error("インポート処理エラー:", err);
    return {
      status: "error",
      message: err.message,
      timestamp,
      results,
    };
  }
}

/**
 * 単一のCSVファイルを処理
 */
async function processSingleFile(
  file,
  spreadsheetId,
  mapping,
  bankName,
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
    // ファイルをダウンロード
    const csvBuffer = await downloadFile(file.id);

    // CSVをパース
    const transactions = parseCSV(csvBuffer, mapping);
    fileResult.totalRows = transactions.length;

    // 重複をチェック
    const { unique, duplicate } = filterDuplicates(
      transactions,
      existingTransactions
    );
    fileResult.duplicateRows = duplicate.length;

    // 新規トランザクションにカテゴリを付与
    if (unique.length > 0) {
      try {
        const descriptions = unique.map((t) => t.description);
        const categories = await categorizeTransactions(spreadsheetId, descriptions);
        unique.forEach((t, i) => {
          t.categoryAuto = categories[i];
          if (t.categoryAuto === "除外") t.excludeAuto = "自動除外";
        });
      } catch (err) {
        console.warn("銀行取引カテゴリ判定失敗:", err.message);
        unique.forEach((t) => { t.categoryAuto = "その他"; });
      }

      await appendTransactionsToSheet(spreadsheetId, bankName, unique);
      fileResult.importedRows = unique.length;

      // 既存トランザクションに新規を追加（次ファイル処理時の重複チェック用）
      existingTransactions.push(...unique);
    }

    // ファイルを「処理済み」フォルダに移動
    await moveFile(file.id, successFolderId);
    fileResult.status = "success";

    // ログを記録
    await logResult(spreadsheetId, {
      processName: "bank trans",
      bankName,
      timestamp,
      ...fileResult,
    });
  } catch (err) {
    console.error(`ファイル処理エラー (${file.name}):`, err);
    fileResult.errorMessage = err.message;

    try {
      // 失敗したファイルを「要確認」フォルダに移動
      await moveFile(file.id, failureFolderId);

      // ログを記録
      await logResult(spreadsheetId, {
        processName: "bank trans",
        bankName,
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
 * トランザクションをスプレッドシートに追記
 */
async function appendTransactionsToSheet(spreadsheetId, bankName, transactions) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = process.env.BANK_TRANS_SHEET_NAME || "bank trans";

  const values = transactions.map((t) => [
    t.transactionDate,
    t.amount,
    t.category,
    t.balance,
    t.description,
    t.comments,
    t.categoryAuto,
    bankName,
    t.excludeAuto ?? "",
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:I`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

module.exports = {
  importBankTransactions,
};
