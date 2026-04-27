const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
}

/**
 * ログをスプレッドシートに記録
 * @param {string} spreadsheetId - スプレッドシートID
 * @param {Object} logEntry - ログエントリ
 */
async function logResult(
  spreadsheetId,
  {
    timestamp,
    fileName,
    status, // "success" | "failure"
    totalRows,
    importedRows,
    duplicateRows,
    errorMessage = "",
  }
) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const logsSheetName = process.env.LOGS_SHEET_NAME || "logs";

  const values = [
    [
      timestamp,
      fileName,
      status,
      totalRows,
      importedRows,
      duplicateRows,
      errorMessage,
    ],
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${logsSheetName}!A:G`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
  } catch (err) {
    console.error("ログ記録エラー:", err);
    throw err;
  }
}

module.exports = {
  logResult,
};
