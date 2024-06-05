import lark from "@larksuiteoapi/node-sdk";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const LARK_APP_ID = process.env.LARK_APP_ID || "";
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || "";
const FLOWISE_API_URL = process.env.FLOWISE_API_URL || "";
const LARK_ACCESS_TOKEN = process.env.LARK_ACCESS_TOKEN || "";

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

async function cmdProcess(cmdParams) {
  switch (cmdParams && cmdParams.action) {
    case "/help":
      await cmdHelp(cmdParams.messageId);
      break;
    case "/clear":
      await cmdClear(cmdParams.sessionId, cmdParams.messageId);
      break;
    default:
      await cmdHelp(cmdParams.messageId);
      break;
  }
  return { code: 0 };
}

async function reply(messageId, content) {
  try {
    return await client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify({
          text: content,
        }),
        msg_type: "text",
      },
    });
  } catch (e) {
    if (e && e.response && e.response.data && e.response.data.code === 230002) {
      logger("Bot/User is not in the chat anymore", e, messageId, content);
    } else {
      logger("send message to Lark error", e, messageId, content);
    }
  }
}

async function cmdHelp(messageId) {
  const helpText = `Lark GPT manpages

Usage:
    /clear    remove conversation history for get a new, clean, bot context.
    /help     get more help message
  `;
  await reply(messageId, helpText);
}

async function cmdClear(sessionId, messageId) {
  await reply(messageId, "✅ All history removed");
}

async function query(data) {
  try {
    const response = await fetch(`${FLOWISE_API_URL}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: data.question,
        max_tokens: 150,
        temperature: 0.7,
      }),
    });
    const result = await response.json();
    return result;
  } catch (error) {
    console.error("Error querying API:", error);
    throw error;
  }
}

async function doctor() {
  if (LARK_APP_ID === "") {
    return {
      code: 1,
      message: {
        en_US: "Here is no Lark APP id, please check & re-Deploy & call again",
      },
    };
  }
  if (!LARK_APP_ID.startsWith("cli_")) {
    return {
      code: 1,
      message: {
        en_US:
          "Your Lark App ID is Wrong, Please Check and call again. Lark APPID must Start with cli",
      },
    };
  }
  if (LARK_APP_SECRET === "") {
    return {
      code: 1,
      message: {
        en_US:
          "Here is no Lark APP Secret, please check & re-Deploy & call again",
      },
    };
  }
  return {
    code: 0,
    message: {
      en_US:
        "✅ Configuration is correct, you can use this bot in your Lark App",
    },
    meta: {
      LARK_APP_ID,
    },
  };
}

async function handleReply(userInput, sessionId, messageId) {
  const question = userInput.text.replace("@_user_1", "").trim();
  logger("question: " + question);
  const action = question.trim();
  if (action.startsWith("/")) {
    return await cmdProcess({ action, sessionId, messageId });
  }
  const openaiResponse = await query({ question });

  const answer = openaiResponse.text;
  await reply(messageId, answer);

  return { code: 0 };
}

async function replyWithImage(messageId, imageKey) {
  try {
    return await client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify({
          image_key: imageKey,
        }),
        msg_type: "image",
      },
    });
  } catch (e) {
    logger("send image message to Lark error", e, messageId);
  }
}

async function handleImageMessage(message, sessionId, messageId) {
  const imageKey = message.content.image_key;

  // You can process the received image here (e.g., save it, analyze it, etc.)

  // Respond with another image
  const responseImageKey = await uploadImage("path/to/response/image.jpg");
  await replyWithImage(messageId, responseImageKey);
}

async function uploadImage(filePath) {
  const formData = new FormData();
  formData.append("image", fs.createReadStream(filePath));

  const response = await fetch(
    "https://open.larksuite.com/open-apis/im/v1/images",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LARK_ACCESS_TOKEN}`,
      },
      body: formData,
    }
  );

  const result = await response.json();
  return result.data.image_key;
}

const processedEvents = new Set();

app.post("/webhook", async (req, res) => {
  const params = req.body;
  if (params.encrypt) {
    logger("user enable encrypt key");
    return res.json({
      code: 1,
      message: {
        en_US: "You have open Encrypt Key Feature, please close it.",
      },
    });
  }
  if (params.type === "url_verification") {
    logger("deal url_verification");
    return res.json({
      challenge: params.challenge,
    });
  }
  if (!params.header || req.query.debug) {
    logger("enter doctor");
    const doc = await doctor();
    return res.json(doc);
  }
  if (params.header.event_type === "im.message.receive_v1") {
    const eventId = params.header.event_id;
    const messageId = params.event.message.message_id;
    const chatId = params.event.message.chat_id;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = chatId + senderId;

    logger(`Received event ID: ${eventId}`);

    // Check if the event ID has already been processed
    if (processedEvents.has(eventId)) {
      logger(`Event ID ${eventId} already processed, skipping.`);
      return res.json({ code: 0 });
    }

    // Add the event ID to the processed set
    processedEvents.add(eventId);

    const messageType = params.event.message.message_type;

    switch (messageType) {
      case "text":
        const userInput = JSON.parse(params.event.message.content);
        const result = await handleReply(userInput, sessionId, messageId);
        return res.json(result);
      case "image":
        // Handle image message
        await handleImageMessage(params.event.message, sessionId, messageId);
        return res.json({ code: 0 });
      default:
        await reply(messageId, "Not support other format question, only text.");
        logger("skip and reply not support");
        return res.json({ code: 0 });
    }
  }

  logger("return without other log");
  return res.json({ code: 2 });
});

app.get("/hello", (req, res) => {
  res.json({ message: "Hello, World!" });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
