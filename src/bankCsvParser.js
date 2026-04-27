const { downloadFile } = require("./bankDriveHelper");
const iconv = require("iconv-lite");

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
 * @param {Object} mapping - マッピング設定 { skipHeaderRow: true/false, skipFooterRow: true/false, encoding: "utf-8" | "shift_jis", columns: { "取引日": 0, ... } }
 * @returns {Array<Object>} パース済みのトランザクションリスト
 */
function parseCSV(csvBuffer, mapping) {
  // エンコーディングに対応（デフォルトはutf-8）
  const encoding = mapping.encoding || "utf-8";
  const csv = iconv.decode(csvBuffer, encoding);
  const lines = csv.split("\n").filter((line) => line.trim());

  if (lines.length === 0) {
    return [];
  }

  const transactions = [];

  // 最初の行をヘッダーとして処理するか、列インデックスで処理するか
  // マッピングで列インデックスが指定されているため、全行がデータ
  const startIndex = mapping.skipHeaderRow ? 1 : 0;
  const endIndex = mapping.skipFooterRow ? lines.length - 1 : lines.length;

  for (let i = startIndex; i < endIndex; i++) {
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
 * 半角カナを全角カナに変換
 * @param {string} text - 変換対象のテキスト
 * @returns {string} 全角カナに変換されたテキスト
 */
function convertHankakuToZenkaku(text) {
  if (!text) return text;

  // 半角カナから全角カナへのマッピング
  const hankakuMap = {
    ｱ: "ア",
    ｲ: "イ",
    ｳ: "ウ",
    ｴ: "エ",
    ｵ: "オ",
    ｶ: "カ",
    ｷ: "キ",
    ｸ: "ク",
    ｹ: "ケ",
    ｺ: "コ",
    ｻ: "サ",
    ｼ: "シ",
    ｽ: "ス",
    ｾ: "セ",
    ｿ: "ソ",
    ﾀ: "タ",
    ﾁ: "チ",
    ﾂ: "ツ",
    ﾃ: "テ",
    ﾄ: "ト",
    ﾅ: "ナ",
    ﾆ: "ニ",
    ﾇ: "ヌ",
    ﾈ: "ネ",
    ﾉ: "ノ",
    ﾊ: "ハ",
    ﾋ: "ヒ",
    ﾌ: "フ",
    ﾍ: "ヘ",
    ﾎ: "ホ",
    ﾏ: "マ",
    ﾐ: "ミ",
    ﾑ: "ム",
    ﾒ: "メ",
    ﾓ: "モ",
    ﾔ: "ヤ",
    ﾕ: "ユ",
    ﾖ: "ヨ",
    ﾗ: "ラ",
    ﾘ: "リ",
    ﾙ: "ル",
    ﾚ: "レ",
    ﾛ: "ロ",
    ﾜ: "ワ",
    ﾝ: "ン",
    ｧ: "ァ",
    ｨ: "ィ",
    ｩ: "ゥ",
    ｪ: "ェ",
    ｫ: "ォ",
    ｬ: "ャ",
    ｭ: "ュ",
    ｮ: "ョ",
    ｯ: "ッ",
  };

  // 半角カナを全角カナに変換
  let result = text.replace(/[ｱ-ﾝ]/g, (match) => hankakuMap[match] || match);

  // 半角の濁点・半濁点を全角に変換（゛゜）
  result = result.replace(/ｶﾞ/g, "ガ");
  result = result.replace(/ｷﾞ/g, "ギ");
  result = result.replace(/ｸﾞ/g, "グ");
  result = result.replace(/ｹﾞ/g, "ゲ");
  result = result.replace(/ｺﾞ/g, "ゴ");
  result = result.replace(/ｻﾞ/g, "ザ");
  result = result.replace(/ｼﾞ/g, "ジ");
  result = result.replace(/ｽﾞ/g, "ズ");
  result = result.replace(/ｾﾞ/g, "ゼ");
  result = result.replace(/ｿﾞ/g, "ゾ");
  result = result.replace(/ﾀﾞ/g, "ダ");
  result = result.replace(/ﾁﾞ/g, "ヂ");
  result = result.replace(/ﾂﾞ/g, "ヅ");
  result = result.replace(/ﾃﾞ/g, "デ");
  result = result.replace(/ﾄﾞ/g, "ド");
  result = result.replace(/ﾊﾞ/g, "バ");
  result = result.replace(/ﾋﾞ/g, "ビ");
  result = result.replace(/ﾌﾞ/g, "ブ");
  result = result.replace(/ﾍﾞ/g, "ベ");
  result = result.replace(/ﾎﾞ/g, "ボ");
  result = result.replace(/ﾊﾟ/g, "パ");
  result = result.replace(/ﾋﾟ/g, "ピ");
  result = result.replace(/ﾌﾟ/g, "プ");
  result = result.replace(/ﾍﾟ/g, "ペ");
  result = result.replace(/ﾎﾟ/g, "ポ");

  // NFC正規化で長音符や複合文字を正規化
  return result.normalize("NFC");
}

/**
 * マッピングを適用してトランザクションデータを抽出
 * @param {Array<string>} values - CSV行のデータ配列
 * @param {Object} columns - 列マッピング
 * @returns {Object|null} トランザクションオブジェクト
 */
function extractTransactionData(values, columns) {
  // 取引日を取得（単一カラムまたは複合カラム）
  let transactionDate;
  if (columns["取引日"] !== undefined) {
    transactionDate = values[columns["取引日"]]?.trim();
  } else if (
    columns["取引日（年）"] !== undefined &&
    columns["取引日（月）"] !== undefined &&
    columns["取引日（日）"] !== undefined
  ) {
    const year = values[columns["取引日（年）"]]?.trim();
    const month = values[columns["取引日（月）"]]?.trim();
    const day = values[columns["取引日（日）"]]?.trim();

    if (year && month && day) {
      transactionDate = `${year}/${month}/${day}`;
    }
  }

  const amount = values[columns["金額"]]?.trim();
  const description = values[columns["摘要"]]?.trim();
  const balance = values[columns["残高"]]?.trim();

  if (!transactionDate || !amount || !description || !balance) {
    return null; // 必須データが不足している行はスキップ
  }

  return {
    transactionDate,
    amount: parseFloat(amount.replace(/[^0-9.-]/g, "")), // 数字のみ抽出
    category: convertHankakuToZenkaku(values[columns["区分"]]?.trim() || ""),
    balance: parseFloat(balance.replace(/[^0-9.-]/g, "")),
    description: convertHankakuToZenkaku(description),
    comments: convertHankakuToZenkaku(values[columns["コメント"]]?.trim() || ""),
    categoryAuto: "", // 将来的に自動化
  };
}

module.exports = {
  loadBankMapping,
  parseCSV,
};
