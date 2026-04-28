const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
}

/**
 * スプレッドシートから既存のカード取引一覧を取得
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @returns {Promise<Array>}
 */
async function getExistingCardTransactions(spreadsheetId, sheetName) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:E`, // 利用日(A)、利用店名(B)、利用者(C)、支払方法(D)、利用金額(E)
    });

    const rows = response.data.values || [];
    return rows.slice(1).map((row) => ({
      usageDate: row[0] || "",
      storeName: row[1] || "",
      user: row[2] || "",
      amount: parseFloat(row[4]) || 0,
    }));
  } catch (err) {
    console.error("既存カード取引取得エラー:", err);
    return [];
  }
}

/**
 * 新しい取引が既存と重複するかチェック
 * キー: 利用日 + 利用店名 + 利用者 + 利用金額
 */
function isCardDuplicate(newTx, existingTransactions) {
  return existingTransactions.some(
    (existing) =>
      existing.usageDate === newTx.usageDate &&
      existing.storeName === newTx.storeName &&
      existing.user === newTx.user &&
      existing.amount === newTx.amount
  );
}

/**
 * ファイル内の重複はそのまま取り込み、スプレッドシート既存データと一致する場合のみスキップ
 * @param {Array<Object>} newTransactions - ファイルから読み込んだ全取引
 * @param {Array<Object>} existingTransactions - スプレッドシートの既存取引
 * @returns {{ unique: Array, duplicate: Array }}
 */
function filterCardDuplicates(newTransactions, existingTransactions) {
  const unique = [];
  const duplicate = [];

  newTransactions.forEach((tx) => {
    if (isCardDuplicate(tx, existingTransactions)) {
      duplicate.push(tx);
    } else {
      unique.push(tx);
    }
  });

  return { unique, duplicate };
}

module.exports = { getExistingCardTransactions, filterCardDuplicates };
