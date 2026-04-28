const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require("googleapis");

const CATEGORIES = [
  "食費", "日用品", "交通費", "通信費", "光熱費",
  "医療", "娯楽", "衣類", "教育", "保険", "住居費", "その他",
];
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
}

/**
 * category rules シートからルール一覧を取得
 * @returns {Promise<Array<{keyword: string, category: string}>>}
 */
async function loadCategoryRules(spreadsheetId) {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = process.env.CATEGORY_RULES_SHEET_NAME || "category rules";

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:B`,
    });
    const rows = response.data.values || [];
    return rows.slice(1)
      .filter((row) => row[0] && row[1])
      .map((row) => ({ keyword: row[0].trim(), category: row[1].trim() }));
  } catch (err) {
    console.warn("category rules 読み込みエラー（シートが未作成の可能性）:", err.message);
    return [];
  }
}

/**
 * ルールから部分一致でカテゴリを検索
 * @param {string} description
 * @param {Array<{keyword, category}>} rules
 * @returns {string|null}
 */
function findCategoryByRule(description, rules) {
  if (!description) return null;
  const desc = description.toLowerCase();
  const matched = rules.find((r) => desc.includes(r.keyword.toLowerCase()));
  return matched ? matched.category : null;
}

/**
 * Gemini に複数の摘要をまとめてカテゴリ判定させる
 * @param {Array<{index: number, description: string}>} items
 * @returns {Promise<Object>} { [index]: category }
 */
async function categorizeWithGemini(items) {
  if (items.length === 0) return {};

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
以下の取引の店名・摘要から、適切なカテゴリを1つ選んでください。
カテゴリは必ず次の中から選んでください: ${CATEGORIES.join("、")}

JSON配列のみを返してください（説明不要）:
[{"index": 番号, "category": "カテゴリ名"}, ...]

取引リスト:
${JSON.stringify(items, null, 2)}
`.trim();

  try {
    const result = await model.generateContent(prompt);
    let text = result.response.text().trim().replace(/```(?:json)?\n?/g, "").trim();
    const parsed = JSON.parse(text);
    return Object.fromEntries(parsed.map((r) => [r.index, r.category]));
  } catch (err) {
    console.error("Gemini カテゴリ判定エラー:", err.message);
    // 失敗時は全件「その他」
    return Object.fromEntries(items.map((item) => [item.index, "その他"]));
  }
}

/**
 * 新しいルールを category rules シートに追記
 * @param {string} spreadsheetId
 * @param {Array<{keyword: string, category: string}>} newRules
 */
async function addNewRules(spreadsheetId, newRules) {
  if (newRules.length === 0) return;

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const sheetName = process.env.CATEGORY_RULES_SHEET_NAME || "category rules";
  const timestamp = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  const values = newRules.map((r) => [r.keyword, r.category, timestamp, "Gemini"]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:D`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

/**
 * 摘要リストにカテゴリを付与して返す（メイン関数）
 * - rules シートを部分一致で照合
 * - 未ヒット分を Gemini にバッチ送信
 * - 新規ルールを rules シートに追記
 *
 * @param {string} spreadsheetId
 * @param {Array<string>} descriptions - 店名・摘要の配列
 * @returns {Promise<Array<string>>} categories - 同順のカテゴリ配列
 */
async function categorizeTransactions(spreadsheetId, descriptions) {
  const rules = await loadCategoryRules(spreadsheetId);
  const categories = new Array(descriptions.length).fill(null);
  const unknownItems = [];

  // ① ルールで照合
  descriptions.forEach((desc, i) => {
    const category = findCategoryByRule(desc, rules);
    if (category) {
      categories[i] = category;
    } else {
      unknownItems.push({ index: i, description: desc || "" });
    }
  });

  // ② 未ヒット分を Gemini でバッチ判定
  if (unknownItems.length > 0) {
    const geminiResult = await categorizeWithGemini(unknownItems);

    // 新規ルールを収集（同じキーワードの重複を排除）
    const newRules = [];
    const addedKeywords = new Set(rules.map((r) => r.keyword.toLowerCase()));

    unknownItems.forEach((item) => {
      const category = geminiResult[item.index] ?? "その他";
      categories[item.index] = category;

      const keyword = item.description;
      if (keyword && !addedKeywords.has(keyword.toLowerCase())) {
        newRules.push({ keyword, category });
        addedKeywords.add(keyword.toLowerCase());
      }
    });

    // ③ 新規ルールを rules シートに追記
    await addNewRules(spreadsheetId, newRules);
  }

  return categories.map((c) => c ?? "その他");
}

module.exports = { categorizeTransactions, CATEGORIES };
