import lark from "@larksuiteoapi/node-sdk";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const LARK_APP_ID = process.env.LARK_APP_ID || "";
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || "";
const FLOWISE_API_URL = process.env.FLOWISE_API_URL || "";

// Initialize Lark SDK client
const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

app.use(express.json());

// Map to store the last sessionId for each user
const lastSessionMap = new Map();

function logger(...params) {
  console.error(`[CF]`, ...params);
}

// Function to process commands like /help, /clear, etc.
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

// Function to format markdown into HTML-like format
function formatMarkdown(text) {
  text = text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
  text = text.replace(/\*(.*?)\*/g, "<i>$1</i>");
  return text;
}

// Function to send a reply message to Lark
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

// Command to display help
async function cmdHelp(messageId) {
  const helpText = `
  Lark GPT Commands

  Usage:
  - /clear : Remove conversation history to start a new session.
  - /help : Get more help messages.
  `;
  await reply(messageId, helpText, "Help");
}

// Command to clear conversation history
async function cmdClear(sessionId, messageId) {
  lastSessionMap.delete(sessionId);
  await reply(messageId, "✅ Conversation history cleared.");
}

// Query Flowise API with question and sessionId
async function queryFlowise(question, sessionId) {
  try {
    const response = await fetch(FLOWISE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, sessionId }), // Include sessionId in the request
    });

    const result = await response.json();

    if (result.text) {
      // Check if sessionId is updated in the response
      const newSessionId = result.sessionId || sessionId;

      // Update session map with the latest sessionId and response
      lastSessionMap.set(newSessionId, { question, answer: result.text });

      return { text: result.text, sessionId: newSessionId }; // Return updated sessionId
    }

    throw new Error("Invalid response from Flowise API");
  } catch (error) {
    logger("Error querying Flowise API:", error);
    throw error;
  }
}

// Handle the user input and send reply using Flowise
async function handleReply(userInput, sessionId, messageId) {
  const question = userInput.text.replace("@_user_1", "").trim();
  logger("Received question:", question, sessionId);

  // If input is a command, process it
  if (question.startsWith("/")) {
    return await cmdProcess({ action: question, sessionId, messageId });
  }

  try {
    // Query Flowise and get response and sessionId
    const { text, sessionId: newSessionId } = await queryFlowise(
      question,
      sessionId
    );

    // Update session map with the latest sessionId
    lastSessionMap.set(newSessionId, { question, text });

    // Reply with the answer
    return await reply(messageId, text);
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

  // Handle URL verification for Lark API
  if (params.type === "url_verification") {
    return res.json({ challenge: params.challenge });
  }

  // Handle encryption (if enabled)
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
    const sessionId = `${chatId}${senderId}`; // SessionId based on chat and sender

    // Avoid processing duplicate events
    if (processedEvents.has(eventId)) {
      return res.json({ code: 0, message: "Duplicate event" });
    }

    processedEvents.add(eventId);

    if (messageType !== "text") {
      await reply(messageId, "Only text messages are supported.");
      return res.json({ code: 0 });
    }

    const userInput = JSON.parse(params.event.message.content);

    // Handle reply and use sessionId from the event
    const result = await handleReply(userInput, sessionId, messageId);

    return res.json(result);
  }

  return res.json({ code: 2 });
});

// Sample route to test the server
app.get("/hello", (req, res) => {
  res.json({ message: "Hello, World!" });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
