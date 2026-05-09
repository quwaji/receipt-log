const { parseReceipt } = require("./geminiParser");
const { logToSheet } = require("./sheetsLogger");
const { categorizeTransactions } = require("./categoryService");
const { aggregateByMonth, getLastMonth } = require("./aggregationService");

/**
 * LINE イベントを処理する
 * @param {object} event - LINE Webhook イベント
 * @param {object} client - LINE Bot SDK クライアント
 */
async function handleEvent(event, client) {
  if (event.type !== "message") return;

  if (event.message.type === "text") {
    await handleTextMessage(event, client);
  } else if (event.message.type === "image") {
    await handleImageMessage(event, client);
  }
}

/**
 * テキストメッセージを処理する
 */
async function handleTextMessage(event, client) {
  const text = event.message.text;
  if (!text.includes("集計")) return;

  const replyToken = event.replyToken;
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const month = getLastMonth();

  let data;
  try {
    data = await aggregateByMonth(spreadsheetId, month);
  } catch (err) {
    console.error("集計失敗:", err);
    await client.replyMessage(replyToken, {
      type: "text",
      text: "集計中にエラーが発生しました。",
    });
    return;
  }

  const [year, m] = month.split("-");
  const title = `📊 ${year}年${parseInt(m)}月の集計`;

  // カテゴリ別支出を金額降順で整形
  const sortedCategories = Object.entries(data.categories).sort(
    ([, a], [, b]) => b.total - a.total
  );

  let categoryLines = sortedCategories
    .map(([name, c]) => `${name}　¥${c.total.toLocaleString()}`)
    .join("\n");

  if (!categoryLines) categoryLines = "（データなし）";

  // メンバー別レシート合計
  const sortedMembers = Object.entries(data.members || {}).sort(
    ([, a], [, b]) => b.total - a.total
  );
  const memberSection = sortedMembers.length > 0
    ? `\n\n【レシート】\n` +
      sortedMembers.map(([name, m]) => `${name}　¥${m.total.toLocaleString()}`).join("\n")
    : "";

  const summaryText =
    `${title}\n\n` +
    `【支出カテゴリ別】\n${categoryLines}\n` +
    `──────────────\n` +
    `支出合計　¥${data.expenseTotal.toLocaleString()}\n\n` +
    `【入金】\n入金合計　¥${data.incomeTotal.toLocaleString()}` +
    memberSection;

  const messages = [{ type: "text", text: summaryText }];

  const liffUrl = process.env.LIFF_URL;
  if (liffUrl) {
    messages.push({
      type: "flex",
      altText: "グラフで見る",
      contents: {
        type: "bubble",
        size: "kilo",
        body: {
          type: "box",
          layout: "vertical",
          paddingAll: "md",
          contents: [
            {
              type: "button",
              action: {
                type: "uri",
                label: "📊 グラフで見る",
                uri: `${liffUrl}?month=${month}`,
              },
              style: "primary",
              color: "#4A90D9",
            },
          ],
        },
      },
    });
  }

  await client.replyMessage(replyToken, messages);
}

/**
 * 画像メッセージを処理する（レシート記録）
 */
async function handleImageMessage(event, client) {
  const userId = event.source.userId;
  const groupId = event.source.groupId ?? null;
  const replyToken = event.replyToken;
  const receivedAt = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  // グループ内のユーザー表示名を取得（グループ外はプロフィールから取得）
  let displayName = "不明";
  try {
    if (groupId) {
      const profile = await client.getGroupMemberProfile(groupId, userId);
      displayName = profile.displayName;
    } else {
      const profile = await client.getProfile(userId);
      displayName = profile.displayName;
    }
  } catch (err) {
    console.warn(`プロフィール取得失敗 userId=${userId}:`, err.message);
  }

  // レシート画像のバイナリを取得
  let imageBuffer;
  try {
    const stream = await client.getMessageContent(event.message.id);
    imageBuffer = await streamToBuffer(stream);
  } catch (err) {
    console.error("画像取得失敗:", err);
    await client.replyMessage(replyToken, { type: "text", text: "画像の取得に失敗しました。" });
    return;
  }

  // Gemini でレシートを解析
  let receipt;
  try {
    receipt = await parseReceipt(imageBuffer);
  } catch (err) {
    console.error("レシート解析失敗:", err);
    await client.replyMessage(replyToken, { type: "text", text: "レシートの読み取りに失敗しました。" });
    return;
  }

  // 支払い日時が読み取れなかった場合は受信日時を使い備考にメモ
  const paymentDate = receipt.paymentDate ?? receivedAt;
  const remarks = receipt.paymentDate ? "" : "支払い日時はレシートから読み取れなかったため受信日時を使用";

  // カテゴリ自動判定
  let categoryAuto = "その他";
  try {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const categories = await categorizeTransactions(spreadsheetId, [receipt.storeName ?? ""]);
    categoryAuto = categories[0];
  } catch (err) {
    console.warn("カテゴリ判定失敗:", err.message);
  }

  // スプレッドシートに記録
  try {
    await logToSheet({
      receivedAt,
      paymentDate,
      userId,
      displayName,
      groupId,
      storeName: receipt.storeName,
      totalAmount: receipt.totalAmount,
      paymentMethod: receipt.paymentMethod,
      items: receipt.items,
      remarks,
      categoryAuto,
    });
  } catch (err) {
    console.error("スプレッドシート記録失敗:", err);
    await client.replyMessage(replyToken, { type: "text", text: "スプレッドシートへの記録に失敗しました。" });
    return;
  }

  // 記録完了を返信
  const itemsText = receipt.items ? receipt.items.replace(/\n/g, "、") : "（品目不明）";
  const remarksText = remarks ? `\n📝 ${remarks}` : "";
  await client.replyMessage(replyToken, {
    type: "text",
    text: `✅ 記録しました！\n\n👤 ${displayName}\n🏪 ${receipt.storeName ?? "（店名不明）"}\n🗓 ${paymentDate}\n💴 ${receipt.totalAmount ?? "（金額不明）"} 円（${receipt.paymentMethod}）\n🛒 ${itemsText}${remarksText}`,
  });
}

/**
 * ReadableStream を Buffer に変換する
 */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

module.exports = { handleEvent };
