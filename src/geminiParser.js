const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PROMPT = `
この画像はレシートです。以下の情報をJSON形式で抽出してください。
情報が読み取れない場合は null にしてください。

{
  "storeName": "店名（文字列）",
  "totalAmount": 合計金額（数値、税込み、円記号なし）,
  "paymentDate": "支払い日時（レシートに記載の日時を「YYYY/MM/DD HH:mm」形式で。日付のみの場合は「YYYY/MM/DD」。読み取れない場合は null）",
  "paymentMethod": "支払い方法（「カード」または「現金」のいずれか。クレジット・デビット・電子マネー・QR決済はすべて「カード」。判断できない場合は「現金」）",
  "items": "品目リスト（各行に「品名 金額円」の形式で改行区切り）"
}

JSONのみを返してください。マークダウンのコードブロックは不要です。
`.trim();

/**
 * レシート画像を Gemini で解析し構造化データを返す
 * @param {Buffer} imageBuffer - レシート画像のバイナリ
 * @returns {{ storeName: string|null, totalAmount: number|null, items: string|null }}
 */
async function parseReceipt(imageBuffer) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const imagePart = {
    inlineData: {
      data: imageBuffer.toString("base64"),
      mimeType: "image/jpeg",
    },
  };

  const result = await model.generateContent([PROMPT, imagePart]);
  let text = result.response.text().trim();

  // マークダウンコードブロック（```json ... ```）を削除
  text = text.replace(/```(?:json)?\n?/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON パースに失敗した場合はフォールバック
    console.warn("Gemini レスポンスの JSON パース失敗:", text);
    parsed = { storeName: null, totalAmount: null, items: text };
  }

  return {
    storeName: parsed.storeName ?? null,
    totalAmount: parsed.totalAmount ?? null,
    paymentDate: parsed.paymentDate ?? null,
    paymentMethod: parsed.paymentMethod ?? "現金",
    items: parsed.items ?? null,
  };
}

module.exports = { parseReceipt };
