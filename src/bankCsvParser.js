const { downloadFile } = require("./bankDriveHelper");

const MAPPING_FILENAME = "bank_mapping.json";

/**
 * フォルダからマッピング設定をダウンロード
 * @param {string} bankFolderId - 銀行フォルダID
 * @returns {Promise<Object>} マッピング設定
 */
async function loadBankMapping(bankFolderId) {
  try {
    // フォルダ内のファイル一覧を取得
    const { google } = require("googleapis");
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    const drive = google.drive({ version: "v3", auth });

    const response = await drive.files.list({
      q: `'${bankFolderId}' in parents and name='${MAPPING_FILENAME}' and trashed=false`,
      spaces: "drive",
      fields: "files(id)",
      pageSize: 1,
    });

    if (!response.data.files || response.data.files.length === 0) {
      throw new Error(`${MAPPING_FILENAME} が見つかりません`);
    }

    const mappingFileId = response.data.files[0].id;
    const buffer = await downloadFile(mappingFileId);
    const mapping = JSON.parse(buffer.toString("utf-8"));

    return mapping;
  } catch (err) {
    throw new Error(`マッピング設定の読み込みエラー: ${err.message}`);
  }
}

/**
 * CSVをパースしてオブジェクト配列に変換
 * @param {Buffer} csvBuffer - CSVファイルの内容
 * @param {Object} mapping - マッピング設定 { columns: { "取引日": 0, "金額": 1, ... } }
 * @returns {Array<Object>} パース済みのトランザクションリスト
 */
function parseCSV(csvBuffer, mapping) {
  const csv = csvBuffer.toString("utf-8");
  const lines = csv.split("\n").filter((line) => line.trim());

  if (lines.length === 0) {
    return [];
  }

  const transactions = [];

  // 最初の行をヘッダーとして処理するか、列インデックスで処理するか
  // マッピングで列インデックスが指定されているため、全行がデータ
  const startIndex = mapping.skipHeaderRow ? 1 : 0;

  for (let i = startIndex; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const transaction = extractTransactionData(values, mapping.columns);

    if (transaction) {
      transactions.push(transaction);
    }
  }

  return transactions;
}

/**
 * CSVの1行をパース（シンプルな実装、クォート対応）
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
        i++; // スキップ
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
 * マッピングを適用してトランザクションデータを抽出
 * @param {Array<string>} values - CSV行のデータ配列
 * @param {Object} columns - 列マッピング
 * @returns {Object|null} トランザクションオブジェクト
 */
function extractTransactionData(values, columns) {
  // 必須フィールド
  const transactionDate = values[columns["取引日"]]?.trim();
  const amount = values[columns["金額"]]?.trim();
  const description = values[columns["摘要"]]?.trim();
  const balance = values[columns["残高"]]?.trim();

  if (!transactionDate || !amount || !description || !balance) {
    return null; // 必須データが不足している行はスキップ
  }

  return {
    transactionDate,
    amount: parseFloat(amount.replace(/[^0-9.-]/g, "")), // 数字のみ抽出
    category: values[columns["区分"]]?.trim() || "",
    balance: parseFloat(balance.replace(/[^0-9.-]/g, "")),
    description,
    comments: values[columns["コメント"]]?.trim() || "",
    categoryAuto: "", // 将来的に自動化
  };
}

module.exports = {
  loadBankMapping,
  parseCSV,
};
