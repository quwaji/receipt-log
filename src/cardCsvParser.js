const { google } = require("googleapis");
const { downloadFile } = require("./bankDriveHelper");
const iconv = require("iconv-lite");

const MAPPING_FILENAME = "card_mapping.json";

/**
 * フォルダから card_mapping.json をダウンロード
 * @param {string} cardFolderId
 * @returns {Promise<Object>}
 */
async function loadCardMapping(cardFolderId) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    const drive = google.drive({ version: "v3", auth });

    const response = await drive.files.list({
      q: `'${cardFolderId}' in parents and name='${MAPPING_FILENAME}' and trashed=false`,
      spaces: "drive",
      fields: "files(id)",
      pageSize: 1,
    });

    if (!response.data.files || response.data.files.length === 0) {
      throw new Error(`${MAPPING_FILENAME} が見つかりません`);
    }

    const buffer = await downloadFile(response.data.files[0].id);
    return JSON.parse(buffer.toString("utf-8"));
  } catch (err) {
    throw new Error(`マッピング設定の読み込みエラー: ${err.message}`);
  }
}

/**
 * カード利用明細 CSV をパースしてオブジェクト配列に変換
 * @param {Buffer} csvBuffer
 * @param {Object} mapping
 * @returns {Array<Object>}
 */
function parseCardCSV(csvBuffer, mapping) {
  const encoding = mapping.encoding || "utf-8";
  const csv = iconv.decode(csvBuffer, encoding);
  const lines = csv.split("\n").filter((line) => line.trim());

  if (lines.length === 0) return [];

  const startIndex = mapping.skipHeaderRow ? 1 : 0;
  const endIndex = mapping.skipFooterRow ? lines.length - 1 : lines.length;
  const transactions = [];

  for (let i = startIndex; i < endIndex; i++) {
    const values = parseCSVLine(lines[i]);
    const transaction = extractCardData(values, mapping.columns);
    if (transaction) transactions.push(transaction);
  }

  return transactions;
}

/**
 * CSV の 1 行をパース（クォート対応）
 */
function parseCSVLine(line) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === "," && !insideQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

/**
 * マッピングを適用してカード取引データを抽出
 * @param {Array<string>} values
 * @param {Object} columns
 * @returns {Object|null}
 */
function extractCardData(values, columns) {
  const usageDate = values[columns["利用日"]]?.trim();
  const storeName = values[columns["利用店名"]]?.trim();
  const amount = values[columns["利用金額"]]?.trim();

  // 必須項目が揃わない行はスキップ
  if (!usageDate || !storeName || !amount) return null;

  return {
    usageDate,
    storeName,
    user: values[columns["利用者"]]?.trim() || "",
    paymentMethod: values[columns["支払方法"]]?.trim() || "",
    amount: parseFloat(amount.replace(/[^0-9.-]/g, "")) || 0,
    fee: parseFloat((values[columns["手数料/利息"]]?.trim() || "0").replace(/[^0-9.-]/g, "")) || 0,
    totalAmount: parseFloat((values[columns["支払総額"]]?.trim() || "0").replace(/[^0-9.-]/g, "")) || 0,
    paymentMonth: values[columns["支払月"]]?.trim() || "",
  };
}

module.exports = { loadCardMapping, parseCardCSV };
