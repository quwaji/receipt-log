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
 * @param {{ receivedAt, paymentDate, userId, displayName, groupId, storeName, totalAmount, paymentMethod, items, remarks }} row
 */
async function logToSheet({ receivedAt, paymentDate, userId, displayName, groupId, storeName, totalAmount, paymentMethod, items, remarks }) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const values = [
    [
      receivedAt,
      paymentDate ?? "",
      userId,
      displayName,
      groupId ?? "",
      storeName ?? "",
      totalAmount ?? "",
      paymentMethod ?? "",
      items ?? "",
      remarks ?? "",
    ],
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:J`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

module.exports = { logToSheet };
