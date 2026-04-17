const { parseReceipt } = require("./geminiParser");
const { logToSheet } = require("./sheetsLogger");

/**
 * LINE イベントを処理する
 * @param {object} event - LINE Webhook イベント
 * @param {object} client - LINE Bot SDK クライアント
 */
async function handleEvent(event, client) {
  // 画像メッセージ以外は無視
  if (event.type !== "message" || event.message.type !== "image") {
    return;
  }

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
