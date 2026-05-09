const { google } = require("googleapis");

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

/**
 * 日付文字列から YYYY-MM を抽出
 * 対応: "2026/04/10 15:32", "2026/04/10", "2026-04-10"
 */
function extractYearMonth(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/(\d{4})[\/\-](\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * 指定月の集計データを返す
 * @param {string} spreadsheetId
 * @param {string} month - "YYYY-MM"
 * @returns {Promise<{month, expenseTotal, incomeTotal, categories, income}>}
 */
async function aggregateByMonth(spreadsheetId, month) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const [receiptsRows, bankRows, cardRows] = await Promise.all([
    getSheetRows(sheets, spreadsheetId, process.env.SHEET_NAME || "receipts", "A:L"),
    getSheetRows(sheets, spreadsheetId, process.env.BANK_TRANS_SHEET_NAME || "bank trans", "A:I"),
    getSheetRows(sheets, spreadsheetId, process.env.CARD_TRANS_SHEET_NAME || "card trans", "A:K"),
  ]);

  const categories = {};
  const income = { total: 0, transactions: [] };

  // receipts: B=支払い日時, F=店名, G=金額, K=カテゴリ, L=除外
  for (let i = 0; i < receiptsRows.length; i++) {
    const row = receiptsRows[i];
    if (extractYearMonth(row[1]) !== month) continue;
    if (row[11]) continue; // L列: 除外
    const amount = parseFloat(row[6]) || 0;
    if (!amount) continue;
    const category = row[10] || "その他"; // K列
    addTransaction(categories, category, {
      date: String(row[1] || "").split(" ")[0],
      label: row[5] || "",   // F列: 店名
      amount,
      source: "receipt",
      detail: row[3] || "",  // D列: 表示名
      category,
      rowIndex: i + 2,       // スプレッドシートの実際の行番号（1-based、ヘッダー分+1）
    });
  }

  // bank trans: A=取引日, B=金額, C=区分, E=摘要, G=カテゴリ, H=銀行名, I=除外
  for (let i = 0; i < bankRows.length; i++) {
    const row = bankRows[i];
    if (extractYearMonth(row[0]) !== month) continue;
    if (row[8]) continue; // I列: 除外
    const amount = parseFloat(row[1]) || 0;
    if (!amount) continue;
    if (row[2] === "入金") {
      income.total += amount;
      income.transactions.push({
        date: row[0] || "",
        label: row[4] || "",  // E列: 摘要
        amount,
        source: "bank",
        detail: row[7] || "", // H列: 銀行名
      });
    } else {
      const category = row[6] || "その他"; // G列
      addTransaction(categories, category, {
        date: row[0] || "",
        label: row[4] || "",  // E列: 摘要
        amount: Math.abs(amount),
        source: "bank",
        detail: row[7] || "", // H列: 銀行名
        category,
        rowIndex: i + 2,
      });
    }
  }

  // card trans: A=利用日, B=利用店名, E=利用金額, I=カード名, J=カテゴリ, K=除外
  for (let i = 0; i < cardRows.length; i++) {
    const row = cardRows[i];
    if (extractYearMonth(row[0]) !== month) continue;
    if (row[10]) continue; // K列: 除外
    const amount = parseFloat(row[4]) || 0; // E列
    if (!amount) continue;
    const category = row[9] || "その他"; // J列
    addTransaction(categories, category, {
      date: row[0] || "",
      label: row[1] || "",  // B列: 利用店名
      amount,
      source: "card",
      detail: row[8] || "", // I列: カード名
      category,
      rowIndex: i + 2,
    });
  }

  // メンバー別集計（receipts のみ）
  const members = {};
  for (let i = 0; i < receiptsRows.length; i++) {
    const row = receiptsRows[i];
    if (extractYearMonth(row[1]) !== month) continue;
    if (row[11]) continue; // L列: 除外
    const amount = parseFloat(row[6]) || 0;
    if (!amount) continue;
    const name = row[3] || "不明"; // D列: 表示名
    const category = row[10] || "その他";
    if (!members[name]) members[name] = { total: 0, transactions: [] };
    members[name].total += amount;
    members[name].transactions.push({
      date: String(row[1] || "").split(" ")[0],
      label: row[5] || "",          // F列: 店名
      amount,
      source: "receipt",
      detail: [category, row[7]].filter(Boolean).join("・"), // カテゴリ・支払方法
      category,
      rowIndex: i + 2,
    });
  }

  // カテゴリ・メンバーをそれぞれ日付昇順でソート
  for (const cat of Object.values(categories)) {
    cat.transactions.sort((a, b) => (a.date > b.date ? 1 : -1));
  }
  for (const m of Object.values(members)) {
    m.transactions.sort((a, b) => (a.date > b.date ? 1 : -1));
  }
  income.transactions.sort((a, b) => (a.date > b.date ? 1 : -1));

  const expenseTotal = Object.values(categories).reduce((s, c) => s + c.total, 0);

  return { month, expenseTotal, incomeTotal: income.total, categories, income, members };
}

function addTransaction(categories, category, tx) {
  if (!categories[category]) {
    categories[category] = { total: 0, transactions: [] };
  }
  categories[category].total += tx.amount;
  categories[category].transactions.push(tx);
}

async function getSheetRows(sheets, spreadsheetId, sheetName, range) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!${range}`,
    });
    const rows = res.data.values || [];
    return rows.slice(1); // ヘッダー行を除く
  } catch (err) {
    console.warn(`シート読み込み失敗 (${sheetName}):`, err.message);
    return [];
  }
}

/**
 * 先月を YYYY-MM 形式で返す
 */
function getLastMonth() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  return `${year}-${String(month).padStart(2, "0")}`;
}

module.exports = { aggregateByMonth, getLastMonth };
