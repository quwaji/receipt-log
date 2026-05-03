/**
 * LIFF ID トークン検証ミドルウェア
 *
 * 本番環境（NODE_ENV=production）では LINE API でトークンを検証する。
 * 開発環境では検証をスキップし、直接アクセスを許可する。
 */
async function verifyLiffToken(req, res, next) {
  // 開発環境はスキップ
  if (process.env.NODE_ENV !== "production") return next();

  const channelId = process.env.LIFF_CHANNEL_ID;
  if (!channelId) {
    console.warn("LIFF_CHANNEL_ID が未設定のため認証をスキップします");
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "認証が必要です" });
  }

  const idToken = authHeader.slice(7);

  try {
    const resp = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      console.warn("LIFF トークン検証失敗:", body);
      return res.status(401).json({ error: "トークンが無効です" });
    }

    next();
  } catch (err) {
    console.error("LIFF トークン検証エラー:", err);
    res.status(500).json({ error: "認証エラーが発生しました" });
  }
}

module.exports = { verifyLiffToken };
