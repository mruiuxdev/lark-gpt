const lark = require("@larksuiteoapi/node-sdk");
const dotenv = require("dotenv");
const express = require("express");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const LARK_APP_ID = process.env.LARK_APP_ID || "";
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || "";
const FLOWISE_API_URL = process.env.FLOWISE_API_URL || "";

// In-memory store for simplicity. Can be replaced with Redis for persistence.
const sessionMemory = new Map();

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

app.use(express.json());

function logger(...params) {
  console.error(`[CF]`, ...params);
}

function storeUserName(sessionId, userName) {
  sessionMemory.set(sessionId, { name: userName });
}

function getUserName(sessionId) {
  const sessionData = sessionMemory.get(sessionId);
  return sessionData ? sessionData.name : null;
}

async function queryFlowise(question, sessionId) {
  try {
    const response = await fetch(FLOWISE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, sessionId }),
    });
    const result = await response.json();
    return result.text;
  } catch (error) {
    logger("Error querying Flowise API:", error);
    throw error;
  }
}

async function handleReply(userInput, sessionId, messageId) {
  const question = userInput.text.replace("@_user_1", "").trim();
  logger("Received question:", question);

  if (question.startsWith("/")) {
    return await cmdProcess({ action: question, sessionId, messageId });
  }

  // Check for user name in question
  if (question.toLowerCase().includes("my name is")) {
    const userName = question.split("my name is")[1].trim();
    storeUserName(sessionId, userName);
    return await reply(
      messageId,
      `Nice to meet you, ${userName}! How can I assist you today?`
    );
  }

  // Check if the user is asking for their name
  if (
    question.toLowerCase().includes("what's my name") ||
    question.toLowerCase().includes("what is my name")
  ) {
    const userName = getUserName(sessionId);
    if (userName) {
      return await reply(messageId, `Your name is ${userName}.`);
    } else {
      return await reply(
        messageId,
        "I don't know your name yet. Please tell me by saying 'My name is [your name]'."
      );
    }
  }

  // Query Flowise for other questions
  try {
    const answer = await queryFlowise(question, sessionId);
    return await reply(messageId, answer);
  } catch (error) {
    return await reply(
      messageId,
      "⚠️ An error occurred while processing your request."
    );
  }
}

async function reply(messageId, content, msgType = "text") {
  try {
    const formattedContent = formatMarkdown(content);
    return await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({
          text: formattedContent,
        }),
        msg_type: msgType,
      },
    });
  } catch (e) {
    const errorCode = e?.response?.data?.code;
    if (errorCode === 230002) {
      logger("Bot/User is not in the chat anymore", e, messageId, content);
    } else {
      logger("Error sending message to Lark", e, messageId, content);
    }
  }
}

function formatMarkdown(text) {
  text = text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
  text = text.replace(/\*(.*?)\*/g, "<i>$1</i>");
  return text;
}

app.post("/webhook", async (req, res) => {
  const { body: params } = req;

  if (params.type === "url_verification") {
    return res.json({ challenge: params.challenge });
  }

  if (params.encrypt) {
    return res.json({
      code: 1,
      message: "Encryption is enabled, please disable it.",
    });
  }

  if (!params.header) {
    return res.json({ code: 1, message: "Missing headers." });
  }

  const { event_type: eventType, event_id: eventId } = params.header;

  if (eventType === "im.message.receive_v1") {
    const {
      message_id: messageId,
      chat_id: chatId,
      message_type: messageType,
    } = params.event.message;
    const sessionId = params.event.session_id; // Grab the sessionId here
    const userInput = JSON.parse(params.event.message.content);

    if (messageType !== "text") {
      await reply(messageId, "Only text messages are supported.");
      return res.json({ code: 0 });
    }

    const result = await handleReply(userInput, sessionId, messageId);
    return res.json(result);
  }

  return res.json({ code: 2 });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
