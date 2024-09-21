require("dotenv").config();
const express = require("express");
const { sendToFlowise } = require("./utils/flowise");
const lark = require("@larksuiteoapi/node-sdk");

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

const client = new lark.Client({
  appId: process.env.LARK_APP_ID,
  appSecret: process.env.LARK_APP_SECRET,
  appType: lark.AppType.SelfBuild,
});

let sessionIdStore = {};

app.post("/webhook", async (req, res) => {
  const { event } = req.body;

  if (event && event.message && event.message.text) {
    const userId = event.sender.sender_id.user_id;
    const userMessage = event.message.text;

    const sessionId =
      sessionIdStore[userId] || `session-${userId}-${Date.now()}`;

    try {
      const flowiseResponse = await sendToFlowise(userMessage, sessionId);

      sessionIdStore[userId] = sessionId;

      await client.im.message.reply({
        path: {
          message_id: event.message.message_id,
        },
        data: {
          content: JSON.stringify({
            text:
              flowiseResponse.answer || "Sorry, I could not understand that.",
          }),
          msg_type: "text",
        },
      });
    } catch (error) {
      console.error("Error sending message to Flowise:", error);
    }
  }

  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
