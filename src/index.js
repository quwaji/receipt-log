require('dotenv').config();

const express = require("express");
const { middleware, Client } = require("@line/bot-sdk");
const { handleEvent } = require("./lineHandler");

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const app = express();

app.post("/webhook", middleware(config), (req, res) => {
  // すぐにレスポンスを返す（LINE のタイムアウト防止）
  res.status(200).send("OK");

  // イベント処理は非同期で実行（バックグラウンド）
  req.body.events.forEach((event) => {
    handleEvent(event, new Client(config)).catch((err) => {
      console.error("イベント処理エラー:", err);
    });
  });
});

app.get("/health", (_req, res) => res.send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
