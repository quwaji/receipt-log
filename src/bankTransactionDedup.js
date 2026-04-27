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
 * スプレッドシートから既存のトランザクション一覧を取得
 * @param {string} spreadsheetId - スプレッドシートID
 * @param {string} sheetName - シート名
 * @returns {Promise<Array>} 既存トランザクションのリスト
 */
async function getExistingTransactions(spreadsheetId, sheetName) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:E`, // 取引日、金額、摘要、残高を取得
    });

    const rows = response.data.values || [];
    // 最初の行はヘッダー、スキップ
    const transactions = rows.slice(1).map((row) => ({
      transactionDate: row[0] || "",
      amount: parseFloat(row[1]) || 0,
      balance: parseFloat(row[3]) || 0, // D列: 残高
      description: row[4] || "",        // E列: 摘要
    }));

    return transactions;
  } catch (err) {
    console.error("既存トランザクション取得エラー:", err);
    return [];
  }
}

/**
 * 新しいトランザクションが既に存在するかチェック
 * @param {Object} newTransaction - 新しいトランザクション
 * @param {Array<Object>} existingTransactions - 既存トランザクション
 * @returns {boolean} 重複しているかどうか
 */
function isDuplicate(newTransaction, existingTransactions) {
  return existingTransactions.some(
    (existing) =>
      existing.transactionDate === newTransaction.transactionDate &&
      existing.amount === newTransaction.amount &&
      existing.description === newTransaction.description &&
      existing.balance === newTransaction.balance
  );
}

/**
 * トランザクションリストから重複を除外
 * @param {Array<Object>} newTransactions - 新しいトランザクションリスト
 * @param {Array<Object>} existingTransactions - 既存トランザクション
 * @returns {Object} { unique, duplicate } の配列
 */
function filterDuplicates(newTransactions, existingTransactions) {
  const unique = [];
  const duplicate = [];

  newTransactions.forEach((transaction) => {
    if (isDuplicate(transaction, existingTransactions)) {
      duplicate.push(transaction);
    } else {
      unique.push(transaction);
    }
  });

  return { unique, duplicate };
}

module.exports = {
  getExistingTransactions,
  isDuplicate,
  filterDuplicates,
};
