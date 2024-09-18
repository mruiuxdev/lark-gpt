import lark from "@larksuiteoapi/node-sdk";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const LARK_APP_ID = process.env.LARK_APP_ID || "";
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || "";
const FLOWISE_API_URL = process.env.FLOWISE_API_URL || "";

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

app.use(express.json());

const conversationHistories = new Map();

function logger(...params) {
  console.error(`[CF]`, ...params);
}

// Function to process commands
async function cmdProcess({ action, sessionId, messageId }) {
  switch (action) {
    case "/help":
      return await cmdHelp(messageId);
    case "/clear":
      return await cmdClear(sessionId, messageId);
    default:
      return await cmdHelp(messageId);
  }
}

function formatMarkdown(text) {
  text = text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");  // **bold**
  text = text.replace(/\*(.*?)\*/g, "<i>$1</i>");      // *italic*
  return text;
}

// Function to reply to a message in Lark
async function reply(messageId, content, msgType = "text") {
  try {
    const formattedContent = formatMarkdown(content);
    return await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: formattedContent }),
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

// Function to upload an image to Lark
async function uploadImage(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const response = await client.im.image.create({
      data: {
        image_type: "message",
        image: fs.createReadStream(filePath),
      },
    });

    return response.data.image_key;
  } catch (error) {
    logger("Error uploading image to Lark", error);
    throw error;
  }
}

// Reply with an image
async function replyWithImage(messageId, imageKey) {
  return await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ image_key: imageKey }),
      msg_type: "image",
    },
  });
}

// Download the image from URL
async function downloadImage(imageUrl, filePath) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    const buffer = await response.buffer();
    fs.writeFileSync(filePath, buffer);
  } catch (error) {
    logger("Error downloading image", error);
    throw error;
  }
}

// Handle reply
async function handleReply(userInput, sessionId, messageId) {
  const question = userInput.text.replace("@_user_1", "").trim();
  logger("Received question:", question);

  if (question.startsWith("/")) {
    return await cmdProcess({ action: question, sessionId, messageId });
  }

  try {
    const answer = await queryFlowise(question, sessionId);

    // Check if the response contains an image URL
    if (userInput.artifacts && userInput.artifacts.length > 0) {
      const imageArtifact = userInput.artifacts[0];
      if (imageArtifact.type === "png") {
        const imageUrl = `https://chatflow-aowb.onrender.com/api/v1/get-upload-file?chatflowId=${userInput.chatflowId}&chatId=${userInput.chatId}&fileName=${imageArtifact.data}`;
        const filePath = `/tmp/${path.basename(imageArtifact.data)}`;

        // Download the image
        await downloadImage(imageUrl, filePath);

        // Upload the image to Lark
        const imageKey = await uploadImage(filePath);

        // Reply with the image
        return await replyWithImage(messageId, imageKey);
      }
    }

    return await reply(messageId, answer);
  } catch (error) {
    return await reply(
      messageId,
      "⚠️ An error occurred while processing your request."
    );
  }
}

// Validate Lark app configuration
async function validateAppConfig() {
  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    return { code: 1, message: "Missing Lark App ID or Secret" };
  }
  if (!LARK_APP_ID.startsWith("cli_")) {
    return { code: 1, message: "Lark App ID must start with 'cli_'" };
  }
  return { code: 0, message: "✅ Lark App configuration is valid." };
}

const processedEvents = new Set();

// Webhook handler
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
    const configValidation = await validateAppConfig();
    return res.json(configValidation);
  }

  const { event_type: eventType, event_id: eventId } = params.header;

  if (eventType === "im.message.receive_v1") {
    const {
      message_id: messageId,
      chat_id: chatId,
      message_type: messageType,
    } = params.event.message;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = `${chatId}${senderId}`;

    if (processedEvents.has(eventId)) {
      return res.json({ code: 0, message: "Duplicate event" });
    }

    processedEvents.add(eventId);

    if (messageType !== "text") {
      await reply(messageId, "Only text messages are supported.");
      return res.json({ code: 0 });
    }

    const userInput = JSON.parse(params.event.message.content);
    const result = await handleReply(userInput, sessionId, messageId);
    return res.json(result);
  }

  return res.json({ code: 2 });
});

// Hello World route
app.get("/hello", (req, res) => {
  res.json({ message: "Hello, World!" });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
