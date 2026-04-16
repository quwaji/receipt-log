const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME ?? "receipts";

// Cloud Run 上ではサービスアカウントの認証情報を環境変数から読む
function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
}

/**
 * スプレッドシートに1行追記する
 * @param {{ timestamp, userId, displayName, storeName, totalAmount, items }} row
 */
async function logToSheet({ timestamp, userId, displayName, storeName, totalAmount, items }) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const values = [
    [
      timestamp,
      userId,
      displayName,
      storeName ?? "",
      totalAmount ?? "",
      items ?? "",
    ],
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

module.exports = { logToSheet };
